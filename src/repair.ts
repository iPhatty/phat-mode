import type { Context } from '@earendil-works/chord/context';
import { defineExtension, defineTask, type Extension, type RunningTask, type TaskRuntime } from '@earendil-works/pi-durable';
import { mkdir } from 'node:fs/promises';
import type { PlanReport } from './agents.ts';
import {
  type BuildStepsState,
  buildSteps,
  createConversations,
  type FailState,
  type Published,
  RESULT_MARKER,
  type Work,
} from './build-steps.ts';
import { branchFor } from './config.ts';
import { type Issue, mergeLabels, PROGRESS_LABELS, progressChange } from './github.ts';
import {
  departuresFrom,
  outcomeOf,
  repairComment,
  repairGaveUpComment,
  repairGaveUpSummary,
  shortSha,
  silentDecisionsFrom,
  withOutcome,
} from './messages.ts';
import { repairInstructions } from './prompts.ts';
import { findSpec } from './spec.ts';
import {
  attemptsOf,
  giveUpMarker,
  lookAtPullRequest,
  type RepairCause,
  REPAIRED_CAUSES,
  repairHistory,
  repairMarker,
  whyLeftAlone,
} from './stuck.ts';
import { failureGuard, type OnPhase, perRepo, phasesWith, type Services, StepFailure } from './task-kit.ts';
import { scratchFor } from './workspace.ts';
import { readYoloMarker } from './yolo.ts';

/**
 * Repair: a durable run on one of phat-mode's own open pull requests that is stuck, ending in a new verdict or a
 * hand-off. See docs/adr/0006-repair-is-its-own-task-kind.md and GLOSSARY.md.
 *
 * Phases: `look` decides, from GitHub alone (src/stuck.ts), whether and why the pull request is stuck. `prepare` posts
 * the repair's comment (which counts it), resets the issue's workspace to the pull request's head and starts fresh
 * conversations. Then the build's finishing steps (src/build-steps.ts), entered at `update`: the base branch is merged
 * in, conflicts go to the implementer, and check, review, verify, describe and publish run again. A failure in any of
 * them goes to `fail`, and then `give-up`, which labels the pull request `phat-mode:stuck` with a summary and fails the
 * issue. Before it starts work, merges, publishes or gives up (also after a resume) it checks again that no human acted on the
 * pull request, and stops if one did; it only pushes over the head it started from. So far repair handles conflicts (and a branch behind its base where GitHub requires it up to date).
 */

export const REPAIR_TASK = 'phat.repair';

export type RepairInput = { repo: string; issue: number };

export type RepairResult =
  | { status: 'repaired'; url: string }
  | { status: 'stuck'; url: string; reason: string }
  | { status: 'ignored'; reason: string };

/** What `look` decided to repair: the pull request, the head it repairs, why, and the repair's number and round. */
type Target = { pr: number; url: string; head: string; cause: RepairCause; reason: string; n: number; round: number };

export type RepairState =
  | { phase: 'look' }
  | { phase: 'prepare'; target: Target }
  /** The build's finishing steps, src/build-steps.ts. */
  | BuildStepsState
  | FailState
  /**
   * `round`: the round of repairs this give-up ends. `heads`: the commits the pull request's head may be at, phat-mode's
   * own; any other means a human pushed, and the give-up stops. `authorized`: the give-up checked, before changing
   * anything, that no human had taken the pull request over (stuck label included); from then on a stuck label may be
   * its own, set before an interruption. Absent: not checked yet.
   */
  | {
      phase: 'give-up';
      issue: number;
      pr: number;
      url: string;
      round: number;
      reason: string;
      heads: string[];
      authorized?: true;
    };

type Runtime = TaskRuntime<RepairInput, RepairState, RepairResult, object>;
type Phase<P extends RepairState['phase']> = RunningTask<RepairInput, Extract<RepairState, { phase: P }>, RepairResult>;

/** The Repair task, for every repo; as `createPipeline`. */
export function createRepair(servicesFor: (repo: string) => Promise<Services>, onPhase?: OnPhase<RepairInput>) {
  const phase = phasesWith<RepairInput, ReturnType<typeof repoPhases>>(
    perRepo(async (repo) => repoPhases(await servicesFor(repo))),
    onPhase,
  );
  const Repair = defineTask<RepairInput, RepairState, RepairResult>({
    name: REPAIR_TASK,
    version: 1,
    initial: () => ({ phase: 'look' }),
    phases: {
      look: phase('look'),
      prepare: phase('prepare'),
      implement: phase('implement'),
      check: phase('check'),
      review: phase('review'),
      verify: phase('verify'),
      describe: phase('describe'),
      update: phase('update'),
      publish: phase('publish'),
      fail: phase('fail'),
      'give-up': phase('give-up'),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const extension: Extension = defineExtension({ name: REPAIR_TASK, tasks: [Repair] });
  return { Repair, extension };
}

const firstLine = (text: string) => text.trim().split('\n')[0]!.trim();

/** Every phase of a repair, for one repo. */
function repoPhases(services: Services) {
  const { config, github, workspaces, logger } = services;
  const { labels, limits } = config;
  const stuckLabel = PROGRESS_LABELS.stuck.name;

  const go = (runtime: Runtime, next: RepairState, context: Context) =>
    runtime.commit(() => ({ status: 'running', checkpoint: next }), context);
  const finish = (runtime: Runtime, result: RepairResult, context: Context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
  const guarded = failureGuard<Runtime>(logger, (runtime, issue, reason, context) =>
    go(runtime, { phase: 'fail', issue, reason }, context),
  );

  /** Say how this repair ended, in its comment: the newest repair of the current round on the pull request. */
  async function recordOutcome(pr: number, outcome: string) {
    const attempt = repairHistory(await github.phatModeComments(pr)).attempts.at(-1);
    if (attempt === undefined) return;
    const marker = repairMarker(attempt);
    await github.upsertComment(pr, marker, withOutcome(attempt.body, marker, outcome));
  }

  /**
   * Why the repair must stop now, if it must: the pull request closed, or a human acted on it since `look` (pushed,
   * requested changes, labelled it stuck, removed the verdict). `heads`: the commits its head may be at, phat-mode's own.
   */
  async function humanStop(issue: number, heads: readonly string[]): Promise<string | undefined> {
    const pr = await github.findPullRequest(branchFor(issue));
    if (pr === undefined) return 'the pull request is no longer open';
    return whyLeftAlone(await github.pullRequestStatus(pr.number), heads)?.reason;
  }

  const steps = buildSteps<RepairResult>(services, {
    published: async ({ number, url, head, verdict }: Published): Promise<RepairResult> => {
      const judged = verdict.verdict === 'clean' ? 'verdict clean' : `verdict not clean (${verdict.reason})`;
      await recordOutcome(number, `repaired: pushed ${shortSha(head)}, ${judged}`);
      return { status: 'repaired', url };
    },
    guard: {
      // Its head may be the one `look` found, or what this repair pushed before a crash.
      check: async (state) =>
        humanStop(state.issue.number, [...(state.lease === undefined ? [] : [state.lease]), await workspaces.head(state.workspace)]),
      stopped: async (state, reason) => {
        const pr = await github.findPullRequest(branchFor(state.issue.number));
        if (pr !== undefined) await recordOutcome(pr.number, `stopped: ${reason}`);
        return { status: 'ignored', reason };
      },
    },
  });

  return {
    look: async (task: Phase<'look'>, runtime: Runtime, context: Context) => {
      const number = task.input.issue;
      const pr = await github.findPullRequest(branchFor(number));
      if (pr === undefined) {
        await finish(runtime, { status: 'ignored', reason: `#${number} has no open pull request` }, context);
        return;
      }
      const outcome = await lookAtPullRequest(github, pr, {
        maxRepairs: limits.maxRepairs,
        now: new Date(),
        baseBranch: config.baseBranch,
      });
      if (outcome.kind === 'give_up' && REPAIRED_CAUSES.includes(outcome.cause)) {
        logger.step(number, `Repair: ${outcome.reason}`);
        await go(
          runtime,
          {
            phase: 'give-up',
            issue: number,
            pr: pr.number,
            url: pr.url,
            round: outcome.round,
            reason: outcome.reason,
            heads: [outcome.head],
          },
          context,
        );
        return;
      }
      if (outcome.kind !== 'repair' || !REPAIRED_CAUSES.includes(outcome.cause)) {
        logger.step(number, `Not repairing ${pr.url}: ${outcome.reason}`);
        await finish(runtime, { status: 'ignored', reason: outcome.reason }, context);
        return;
      }
      const { cause, reason, head, n, round } = outcome;
      logger.step(number, `Repair ${n} of ${limits.maxRepairs} of ${pr.url}: ${reason}`);
      await go(runtime, { phase: 'prepare', target: { pr: pr.number, url: pr.url, head, cause, reason, n, round } }, context);
    },

    prepare: guarded<Phase<'prepare'>>(async (task, runtime, context) => {
      const { target } = task.state.checkpoint;
      const number = task.input.issue;
      // A human may have acted since `look` (e.g. while the run was interrupted): then this repair never counts.
      const stop = await humanStop(number, [target.head]);
      if (stop !== undefined) {
        logger.step(number, `Not repairing ${target.url}: ${stop}`);
        await finish(runtime, { status: 'ignored', reason: stop }, context);
        return;
      }
      // The count: this comment, with its marker, is what the budget counts. Upserted, so a crash never counts twice.
      await github.upsertComment(
        target.pr,
        repairMarker({ ...target, sha: target.head }),
        repairComment({ ...target, maxRepairs: limits.maxRepairs, outcome: 'in progress' }),
      );
      const fetched = await github.getIssue(number);
      const spec = findSpec(fetched, config.allowedAuthors, config.repo);
      if (spec === undefined) {
        throw new StepFailure(`#${number} has no spec from a trusted author to repair its pull request against.`);
      }
      const issue: Issue = { ...fetched, comments: [] };
      // What the build decided, from the description phat-mode wrote: the conversations are fresh.
      const { body } = await github.pullRequestStatus(target.pr);
      const departures = departuresFrom(body);
      const plan: PlanReport = {
        decision: 'proceed',
        summary: `Repair of ${target.url}: ${target.reason}`,
        plan: [],
        established: [],
        questions: [],
        reason: '',
        ...silentDecisionsFrom(body),
      };
      logger.step(number, `Preparing workspace at ${shortSha(target.head)}, the pull request's head`);
      const workspace = await workspaces.checkout(number, target.head);
      await mkdir(scratchFor(workspace), { recursive: true });
      const instructions = repairInstructions(config.checkCommand, {
        issue,
        spec,
        pr: { url: target.url, body },
        reason: target.reason,
        plan,
        departures,
      });
      await runtime.commit(async (tx) => {
        const conversations = await createConversations(tx, {
          taskId: runtime.taskId,
          config,
          issue: number,
          workspace,
          instructions: { implement: instructions },
        });
        const work: Work = {
          issue,
          spec,
          workspace,
          conversations,
          plan,
          runs: 0,
          checkFixes: 0,
          reviewRounds: 0,
          verifyRounds: 0,
          updates: 0,
          done: { summary: plan.summary, testing: '', departures },
          unchecked: true,
          // Publish pushes only over the head this repair started from, never over a human's commits.
          lease: target.head,
        };
        // The steps' `update` entry, which needs no bookkeeping: what `steps.start` commits for it, here in the same
        // transaction as the conversations. Nothing is reviewed or verified yet: `unchecked` sends the work through
        // check, review and verify before it is published.
        const entry: BuildStepsState = {
          ...work,
          phase: 'update',
          review: null,
          unresolved: false,
          verification: { kind: 'skipped', reason: 'Not verified yet.' },
          pr: null,
        };
        return { status: 'running', checkpoint: entry };
      }, context);
    }),

    ...steps.phases,

    fail: async (task: Phase<'fail'>, runtime: Runtime, context: Context) => {
      const { issue, reason } = task.state.checkpoint;
      const pr = await github.findPullRequest(branchFor(issue));
      if (pr === undefined) {
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: reason } } }), context);
        return;
      }
      // phat-mode's own heads: the one this repair started from (its comment's marker), or one it pushed and judged.
      const status = await github.pullRequestStatus(pr.number);
      const { round, attempts } = repairHistory(await github.phatModeComments(pr.number));
      const verdict = readYoloMarker(status.body);
      const heads = [...new Set([...attempts.slice(-1).map((attempt) => attempt.sha), ...(verdict ? [verdict.sha] : [])])];
      // A human acted while the repair ran: it is theirs now, not a failure to give up on.
      const left = whyLeftAlone(status, heads);
      if (left !== undefined) {
        logger.step(issue, `Repair failed, but ${left.reason}: leaving ${pr.url} alone`);
        await recordOutcome(pr.number, `stopped: ${left.reason}`);
        await finish(runtime, { status: 'ignored', reason: left.reason }, context);
        return;
      }
      await recordOutcome(pr.number, `failed: ${firstLine(reason)}`);
      await go(runtime, { phase: 'give-up', issue, pr: pr.number, url: pr.url, round, reason, heads }, context);
    },

    'give-up': async (task: Phase<'give-up'>, runtime: Runtime, context: Context) => {
      const state = task.state.checkpoint;
      const { issue, pr, url, round, reason, heads, authorized } = state;
      // Checked every time, also when resumed. Before the first change, a stuck label is a human's, and stops it; once
      // authorized (saved before any change), the label may be this give-up's own, so only that is let through.
      const open = await github.findPullRequest(branchFor(issue));
      const left =
        open?.number !== pr
          ? 'the pull request is no longer open'
          : whyLeftAlone(await github.pullRequestStatus(pr), heads, { ignoreStuckLabel: authorized === true })?.reason;
      if (left !== undefined) {
        logger.step(issue, `Not giving up on ${url}: ${left}`);
        await finish(runtime, { status: 'ignored', reason: left }, context);
        return;
      }
      if (!authorized) {
        await go(runtime, { ...state, authorized: true }, context);
        return;
      }
      logger.step(issue, `Giving up on ${url}: labelling it ${stuckLabel}`);
      await github.editLabels(pr, { add: [stuckLabel] });
      const attempts = attemptsOf(await github.phatModeComments(pr), round).map((attempt) => ({
        ...attempt,
        outcome: outcomeOf(attempt.body),
      }));
      await github.upsertComment(pr, giveUpMarker(round), repairGaveUpSummary({ reason, attempts, maxRepairs: limits.maxRepairs, stuckLabel }));
      // As a failed build: a human should take it.
      await github.upsertComment(issue, RESULT_MARKER, repairGaveUpComment(url, reason, labels, stuckLabel));
      await github.editLabels(
        issue,
        mergeLabels(progressChange('failed'), { add: [labels.readyForHuman], remove: [labels.readyForAgent] }),
      );
      await finish(runtime, { status: 'stuck', url, reason: firstLine(reason) }, context);
    },
  };
}

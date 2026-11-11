import type { Context } from '@earendil-works/chord/context';
import {
  configure,
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
  type RunningTask,
  type TaskRuntime,
} from '@earendil-works/pi-durable';
import { mkdir } from 'node:fs/promises';
import { type DiagnosisReport, type PlanReport, ROLE_TOOLS, RoleDoc } from './agents.ts';
import {
  type BuildStepsState,
  buildSteps,
  createConversations,
  type FailState,
  type Published,
  RESULT_MARKER,
  type Work,
} from './build-steps.ts';
import { branchFor, modelFor } from './config.ts';
import { type CheckDetail, type Issue, mergeLabels, PROGRESS_LABELS, progressChange } from './github.ts';
import {
  baseRedComment,
  departuresFrom,
  outcomeOf,
  repairComment,
  repairGaveUpComment,
  repairGaveUpSummary,
  rerunComment,
  shortSha,
  silentDecisionsFrom,
  withOutcome,
} from './messages.ts';
import { type CiFailure, diagnosePrompt, fixFailedChecksPrompt, repairInstructions, roleInstructions } from './prompts.ts';
import { findSpec } from './spec.ts';
import {
  attemptsOf,
  baseRedMarker,
  baseRedReason,
  giveUpMarker,
  lookAtPullRequest,
  type RepairCause,
  repairHistory,
  repairMarker,
  rerunMarker,
  whyLeftAlone,
} from './stuck.ts';
import { askForReport, failureGuard, type OnPhase, perRepo, phasesWith, type Services, StepFailure } from './task-kit.ts';
import { scratchFor } from './workspace.ts';
import { readYoloMarker, verificationWasTheReason } from './yolo.ts';

/**
 * Repair: a durable run on one of phat-mode's own open pull requests that is stuck, ending in a new verdict or a
 * hand-off. See docs/adr/0006-repair-is-its-own-task-kind.md and GLOSSARY.md.
 *
 * Phases: `look` decides, from GitHub alone (src/stuck.ts), whether and why the pull request is stuck.
 *
 * Failed checks first go to `rerun` when GitHub Actions jobs failed and were not rerun on this head yet: it records the
 * rerun in a marker on the pull request, reruns them, and ends `waiting`, spending no attempt. When they fail again,
 * `gather` checks out the head and collects each failed job's log tail (or a check's name, description and link), and
 * `diagnose`, a read-only agent, judges the cause: this change's goes on to `prepare`; base red or flaky writes a
 * base-red marker and ends `waiting` until the base branch moves on; out of reach gives up at once.
 *
 * `prepare` posts the repair's comment (which counts it), resets the issue's workspace to the pull request's head and
 * starts fresh conversations. Then the build's finishing steps (src/build-steps.ts): for conflicts entered at `update`,
 * where the base branch is merged in and conflicts go to the implementer; for failed checks at `implement`, with the
 * failures and the diagnosis; for not clean at `review`, a fresh code review of the head against its base (and a fresh
 * verification before any fix, when verification was the verdict's reason), whose must-fix findings alone go to the
 * implementer, with a fresh `maxReviewRounds`. Check, review, verify, describe and publish run again. A failure in any of them goes to
 * `fail`, and then `give-up`, which labels the pull request `phat-mode:stuck` with a summary and fails the issue.
 * Before it starts work, merges, publishes or gives up (also after a resume) it checks again that no human acted on the
 * pull request, and stops if one did; it only pushes over the head it started from. Repair handles conflicts (and a
 * branch behind its base where GitHub requires it up to date), failed checks, and not clean.
 */

export const REPAIR_TASK = 'phat.repair';

export type RepairInput = { repo: string; issue: number };

export type RepairResult =
  | { status: 'repaired'; url: string }
  | { status: 'stuck'; url: string; reason: string }
  /** Nothing to repair yet: failed jobs were rerun, or the failed checks are not this change's. No attempt spent. */
  | { status: 'waiting'; url: string; reason: string }
  | { status: 'ignored'; reason: string };

/**
 * What `look` decided to repair: the pull request, the head it repairs, why, and the repair's number and round.
 * `giveUp`: failed checks with the budget spent (or this head repaired already): rerun and diagnose still run, as they
 * spend no attempt, but a failure this change caused gives up, for this reason.
 */
type Target = { pr: number; url: string; head: string; cause: RepairCause; reason: string; n: number; round: number; giveUp?: string };

/** The failed checks and what diagnose made of them: what a repair of failed checks starts from. */
type ChecksFix = { failures: CiFailure[]; diagnosis: DiagnosisReport; workspace: string };

/** The longest tail of a job's log a repair quotes. */
const LOG_LINES = 300;

export type RepairState =
  | { phase: 'look' }
  /**
   * `jobs`: the failed GitHub Actions jobs on the target's head, to rerun. `attempts`: each workflow run's attempt
   * (by run id) before any rerun, so a resumed rerun skips a run whose attempt moved on: it was rerun already.
   */
  | { phase: 'rerun'; target: Target; jobs: { name: string; id: number; runId: number }[]; attempts?: Record<string, number> }
  | { phase: 'gather'; target: Target }
  /** `base`: the base branch's head and its checks, as gathered. `baseline`: the diagnoser's reports before asking. */
  | {
      phase: 'diagnose';
      target: Target;
      workspace: string;
      conversation: ConversationId;
      failures: CiFailure[];
      base: { sha: string; checks: CheckDetail[] };
      baseline: number;
    }
  /** `checks`: for failed checks, what diagnose found, and the workspace `gather` checked out. */
  | { phase: 'prepare'; target: Target; checks?: ChecksFix }
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
      rerun: phase('rerun'),
      gather: phase('gather'),
      diagnose: phase('diagnose'),
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

/** The last `count` lines of `text`. */
const lastLines = (text: string, count: number) => text.replace(/\n+$/, '').split('\n').slice(-count).join('\n');

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

  /** End the run, ignored, when a human acted on the pull request since `look`. Returns whether it ended. */
  async function stoppedByHuman(runtime: Runtime, issue: number, target: Target, context: Context): Promise<boolean> {
    const stop = await humanStop(issue, [target.head]);
    if (stop === undefined) return false;
    logger.step(issue, `Not repairing ${target.url}: ${stop}`);
    await finish(runtime, { status: 'ignored', reason: stop }, context);
    return true;
  }

  /** Reset the issue's workspace to the target's head, with its scratch folder. */
  async function checkoutHead(issue: number, target: Target): Promise<string> {
    logger.step(issue, `Preparing workspace at ${shortSha(target.head)}, the pull request's head`);
    const workspace = await workspaces.checkout(issue, target.head);
    await mkdir(scratchFor(workspace), { recursive: true });
    return workspace;
  }

  /**
   * Give up on the target's pull request before any repair of it ran this time (so no repair comment of its own to
   * record an outcome on).
   */
  const toGiveUp = (runtime: Runtime, issue: number, target: Target, reason: string, context: Context) =>
    go(
      runtime,
      { phase: 'give-up', issue, pr: target.pr, url: target.url, round: target.round, reason, heads: [target.head] },
      context,
    );

  const steps = buildSteps<RepairResult>(services, {
    published: async ({ number, url, head, verdict }: Published): Promise<RepairResult> => {
      const judged = verdict.verdict === 'clean' ? 'verdict clean' : `verdict not clean (${verdict.reason})`;
      // A not clean pull request whose fresh review found nothing to fix keeps its head: only the verdict is new.
      const attempt = repairHistory(await github.phatModeComments(number)).attempts.at(-1);
      const pushed = attempt?.sha === head ? 'no new commit' : `pushed ${shortSha(head)}`;
      await recordOutcome(number, `repaired: ${pushed}, ${judged}`);
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
      if (outcome.kind === 'give_up') {
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
      if (outcome.kind !== 'repair') {
        logger.step(number, `Not repairing ${pr.url}: ${outcome.reason}`);
        await finish(runtime, { status: 'ignored', reason: outcome.reason }, context);
        return;
      }
      const { cause, reason, head, n, round } = outcome;
      const target: Target = {
        pr: pr.number,
        url: pr.url,
        head,
        cause,
        reason,
        n,
        round,
        ...(outcome.giveUp === undefined ? {} : { giveUp: outcome.giveUp }),
      };
      if (cause !== 'checks') {
        logger.step(number, `Repair ${n} of ${limits.maxRepairs} of ${pr.url}: ${reason}`);
        await go(runtime, { phase: 'prepare', target }, context);
        return;
      }
      // Failed checks: rerun the failed GitHub Actions jobs once per head before anything else; a rerun is no repair.
      if (outcome.rerun) {
        const jobs = (await github.commitChecks(head)).checks.flatMap((check) =>
          check.state === 'failed' && check.job !== undefined ? [{ name: check.name, ...check.job }] : [],
        );
        if (jobs.length > 0) {
          await go(runtime, { phase: 'rerun', target, jobs }, context);
          return;
        }
      }
      logger.step(number, `${pr.url}: ${reason}; working out why`);
      await go(runtime, { phase: 'gather', target }, context);
    },

    rerun: async (task: Phase<'rerun'>, runtime: Runtime, context: Context) => {
      const { target, jobs, attempts } = task.state.checkpoint;
      const number = task.input.issue;
      if (await stoppedByHuman(runtime, number, target, context)) return;
      const runs = [...new Set(jobs.map((job) => job.runId))];
      if (attempts === undefined) {
        // Saved before any rerun: GitHub may go on showing the old failures for a while after a rerun is asked for, but
        // a rerun starts a new attempt of its workflow run at once.
        const before: Record<string, number> = {};
        for (const runId of runs) before[runId] = await github.runAttempt(runId);
        await go(runtime, { ...task.state.checkpoint, attempts: before }, context);
        return;
      }
      const names = [...new Set(jobs.map((job) => job.name))];
      // The marker first: once it is there, no later look reruns this head again.
      await github.upsertComment(target.pr, rerunMarker(target.head), rerunComment(target.head, names));
      for (const runId of runs) {
        // Rerun already, before a crash: its attempt moved on.
        if ((await github.runAttempt(runId)) > (attempts[runId] ?? 0)) continue;
        await github.rerunFailedJobs(runId);
      }
      const reason = `reran failed jobs: ${names.join(', ')}`;
      logger.step(number, `${target.url}: ${reason}; repairing only if they fail again`);
      await finish(runtime, { status: 'waiting', url: target.url, reason }, context);
    },

    gather: async (task: Phase<'gather'>, runtime: Runtime, context: Context) => {
      const { target } = task.state.checkpoint;
      const number = task.input.issue;
      if (await stoppedByHuman(runtime, number, target, context)) return;
      const workspace = await checkoutHead(number, target);
      const [head, base] = await Promise.all([github.commitChecks(target.head), github.commitChecks(config.baseBranch)]);
      const failures: CiFailure[] = [];
      for (const check of head.checks.filter((candidate) => candidate.state === 'failed')) {
        const failure: CiFailure = { name: check.name, description: check.description, url: check.url };
        if (check.job === undefined) {
          failures.push(failure);
          continue;
        }
        try {
          failures.push({ ...failure, log: lastLines(await github.jobLog(check.job.id), LOG_LINES) });
        } catch (error) {
          logger.step(number, `No log for ${check.name}: ${firstLine((error as Error).message)}`);
          failures.push({ ...failure, logUnavailable: true });
        }
      }
      logger.step(number, `Gathered ${failures.length} failed check(s): ${failures.map((failure) => failure.name).join(', ')}`);
      await runtime.commit(async (tx) => {
        const model = modelFor(config, 'diagnose');
        const created = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
        await configure(tx, created.id, {
          model: { provider: model.provider, modelId: model.modelId },
          thinkingLevel: model.thinkingLevel,
          tools: ROLE_TOOLS.diagnose,
          instructions: roleInstructions(config.checkCommand).diagnose,
          cwd: workspace,
        });
        Object.assign(await tx.doc(RoleDoc, created.id), { role: 'diagnose', repo: config.repo, issue: number, workspace });
        return {
          status: 'running',
          checkpoint: {
            phase: 'diagnose',
            target,
            workspace,
            conversation: created.id,
            failures,
            base: { sha: base.sha, checks: base.checks },
            baseline: 0,
          },
        };
      }, context);
    },

    diagnose: async (task: Phase<'diagnose'>, runtime: Runtime, context: Context) => {
      const state = task.state.checkpoint;
      const { target, workspace, failures, base } = state;
      const number = task.input.issue;
      logger.step(number, `Diagnosing the failed checks (${modelFor(config, 'diagnose').modelId})`);
      // Read-only: whatever the diagnoser changes in the checkout is thrown away, before (a resumed diagnose may find
      // what it changed before a crash) and after. The checkout is the head as `gather` left it, with nothing of its own.
      await workspaces.restoreSnapshot(workspace);
      let diagnosis: DiagnosisReport | undefined;
      try {
        diagnosis = await askForReport(
          runtime,
          {
            conversation: state.conversation,
            requestId: 'diagnose',
            prompt: diagnosePrompt({
              pr: { url: target.url, head: target.head },
              failures,
              base,
              baseBranch: config.baseBranch,
              checkCommand: config.checkCommand,
            }),
            baseline: state.baseline,
            type: 'diagnosis',
            tool: 'report_diagnosis',
          },
          context,
        );
      } catch (error) {
        if (!(error instanceof StepFailure) || runtime.signal.aborted) throw error;
        diagnosis = undefined;
      }
      const discarded = await workspaces.restoreSnapshot(workspace);
      if (discarded.length > 0) logger.step(number, `Discarded changes the diagnoser made: ${discarded.join(', ')}`);
      if (diagnosis === undefined) {
        logger.error(`${task.input.repo}#${number}: the diagnose agent reported no cause`);
        await toGiveUp(runtime, number, target, 'The diagnose agent reported no cause for the failed checks.', context);
        return;
      }
      logger.step(number, `Diagnosis: ${diagnosis.cause}: ${diagnosis.reason}`);
      switch (diagnosis.cause) {
        case 'this-change':
          // A fix would be a repair: only with budget left.
          if (target.giveUp !== undefined) {
            logger.step(number, `Repair: ${target.giveUp}`);
            await toGiveUp(runtime, number, target, target.giveUp, context);
            return;
          }
          await go(runtime, { phase: 'prepare', target, checks: { failures, diagnosis, workspace } }, context);
          return;
        case 'out-of-reach':
          await toGiveUp(runtime, number, target, `out of reach: ${diagnosis.reason}`, context);
          return;
        default: {
          const cause = diagnosis.cause;
          const reason = baseRedReason(cause, failures.map((failure) => failure.name), config.baseBranch);
          await github.upsertComment(
            target.pr,
            baseRedMarker({ head: target.head, base: base.sha, cause }),
            baseRedComment({ head: target.head, base: base.sha, baseBranch: config.baseBranch, cause, reason: diagnosis.reason }),
          );
          logger.step(number, `${target.url}: ${reason}; no repair spent`);
          await finish(runtime, { status: 'waiting', url: target.url, reason }, context);
        }
      }
    },

    prepare: guarded<Phase<'prepare'>>(async (task, runtime, context) => {
      const { target, checks } = task.state.checkpoint;
      const number = task.input.issue;
      // A human may have acted since `look` (e.g. while the run was interrupted): then this repair never counts.
      if (await stoppedByHuman(runtime, number, target, context)) return;
      if (checks === undefined) logger.step(number, `Repair ${target.n} of ${limits.maxRepairs} of ${target.url}: ${target.reason}`);
      else logger.step(number, `Repair ${target.n} of ${limits.maxRepairs} of ${target.url}: ${checks.diagnosis.reason}`);
      // The count: this comment, with its marker, is what the budget counts. Upserted, so a crash never counts twice.
      await github.upsertComment(
        target.pr,
        repairMarker({ ...target, sha: target.head }),
        repairComment({
          ...target,
          maxRepairs: limits.maxRepairs,
          outcome: 'in progress',
          ...(checks === undefined ? {} : { diagnosis: checks.diagnosis.reason }),
        }),
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
      // Failed checks: `gather` already checked out the head, and diagnose left it as it was.
      const workspace = checks?.workspace ?? (await checkoutHead(number, target));
      const instructions = repairInstructions(config.checkCommand, {
        issue,
        spec,
        pr: { url: target.url, body },
        reason: target.reason,
        cause: target.cause,
        plan,
        departures,
      });
      // Not clean: the base the head is reviewed against, saved with the entry, so `update` can tell a merge of a newer
      // base apart, even one made just before a crash, and send it through check, review and verify.
      const base = target.cause === 'not-clean' ? await workspaces.base(workspace) : undefined;
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
        // Failed checks: the steps' `implement` entry, with what `steps.start` adds for it (the first run, and a
        // baseline of no reports, as the conversations are new), here in the same transaction as the conversations.
        if (checks !== undefined) {
          const { unchecked: _unchecked, ...fixing } = work;
          const entry: BuildStepsState = {
            ...fixing,
            phase: 'implement',
            runs: 1,
            baseline: 0,
            prompt: fixFailedChecksPrompt(checks.failures, checks.diagnosis, config.checkCommand),
          };
          return { status: 'running', checkpoint: entry };
        }
        // Not clean: the steps' `review` entry, with what `steps.start` adds for it (the first round, and baselines of
        // no reports, as the conversations are new), here in the same transaction as the conversations. The original
        // run's findings are not trusted: a fresh review comes first, and a fresh verification too when verification was
        // the reason. Nothing is checked first: check runs once the implementer changes something.
        if (target.cause === 'not-clean') {
          const { unchecked: _unchecked, ...reviewing } = work;
          const verdict = readYoloMarker(body);
          const entry: BuildStepsState = {
            ...reviewing,
            base: base!,
            phase: 'review',
            reviewRounds: 1,
            baseline: { standards: 0, spec: 0 },
            ...(verdict?.verdict === 'not-clean' && verificationWasTheReason(verdict.reason) ? { verifyFirst: true as const } : {}),
          };
          return { status: 'running', checkpoint: entry };
        }
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

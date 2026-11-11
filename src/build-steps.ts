import type { Context } from '@earendil-works/chord/context';
import { configure, type ConversationId, type NextTaskState, type RunningTask, type TaskId, type Tx } from '@earendil-works/pi-durable';
import {
  AGENTS,
  type BuildAgent,
  type DoneReport,
  modelRole,
  type PlanReport,
  type PrReport,
  ReportsDoc,
  ROLE_TOOLS,
  RoleDoc,
} from './agents.ts';
import { type AxisReport, type CodeReview, loadCodeReviewSkill, mustFix, needsFixes, standardsSources } from './code-review.ts';
import type { Spec } from './spec.ts';
import { join, relative } from 'node:path';
import { branchFor, type Config, modelFor, paths } from './config.ts';
import { prSkill } from './pr.ts';
import {
  changedFeatureMap,
  collectEvidence,
  findVerifySkills,
  newFailures,
  restoreProtectedSkillFiles,
  type Verification,
  type VerificationReport,
} from './verify.ts';
import { commentMarker, type Issue, progressChange } from './github.ts';
import { doneComment, pullRequestBody, pullRequestTitle } from './messages.ts';
import {
  describePrompt,
  fixChecksPrompt,
  fixReviewPrompt,
  fixVerificationPrompt,
  resolveConflictsPrompt,
  roleInstructions,
  specReviewPrompt,
  standardsReviewPrompt,
  verifyPrompt,
} from './prompts.ts';
import { type AgentRuntime, askForReport, failureGuard, type Services, StepFailure } from './task-kit.ts';
import { EVIDENCE_BRANCH, tail } from './workspace.ts';
import { verdictFor, yoloMarker, type YoloVerdict } from './yolo.ts';

/**
 * The build's finishing steps: implement, check, code review, verify, describe, update and publish. The build pipeline
 * (src/pipeline.ts) runs them after planning; another durable task can start them at any one of them with
 * `buildSteps(...).start`, given the work so far, and then they run the same loop to a pull request with a verdict.
 */

export type Conversations = Record<BuildAgent, ConversationId>;

/** Known once the workspace is ready. `spec`: what to build, from an Agent Brief or the issue body. */
export type Setup = { issue: Issue; spec: Spec; workspace: string; conversations: Conversations };

/** Known once the planner decided to proceed. */
export type Work = Setup & {
  plan: PlanReport;
  /** Implementer runs so far; also names each run's request. */
  runs: number;
  checkFixes: number;
  reviewRounds: number;
  verifyRounds: number;
  done: DoneReport | null;
  /**
   * The commit of the base branch the change was last checked against, the code review's fixed point; set when the
   * checks pass. Absent in runs saved by an older phat-mode.
   */
  base?: string;
  /** Times the base branch was merged into the branch (`limits.maxBranchUpdates`). Absent: none yet. */
  updates?: number;
  /**
   * The work has not been checked in this run yet: `update` goes on to check even if the base branch did not move, and
   * check clears it once the checks pass. Set by a task that enters the steps at `update` (a Repair); never by a build.
   */
  unchecked?: true;
  /**
   * The commit the branch must still be at on origin to be pushed over: the pull request's head as a Repair found it.
   * Publish pushes only over it, so it never overwrites commits pushed since. Absent (a build): pushed as before.
   */
  lease?: string;
  /**
   * Verify even when the review left must-fix findings, so the implementer gets the review's findings and the
   * verification's failures in one request; verify clears it. Set only by a Repair of a pull request that is not clean
   * because of verification; never by a build.
   */
  verifyFirst?: true;
};

/** The outcome of the code review, carried to the pull request. */
export type Reviewed = { review: CodeReview | null; unresolved: boolean };

/** The checkpoints of the finishing steps. A task that runs them has all of these among its own checkpoints. */
export type BuildStepsState =
  /** `baseline`: how many reports the agent had made before this request, so only new ones count. */
  | (Work & { phase: 'implement'; prompt: string; baseline: number })
  | (Work & { phase: 'check' })
  /** `baseline`: per reviewer, as for implement. */
  | (Work & { phase: 'review'; baseline: { standards: number; spec: number } })
  /** `unresolved`: the last review still had findings that must be fixed. `baseline`: as for implement. */
  | (Work & Reviewed & { phase: 'verify'; baseline: number })
  | (Work & Reviewed & { phase: 'describe'; verification: Verification; baseline: number })
  /** `pr`: the description the implementer wrote, following the pr skill; null if it did not report one. */
  | (Work & Reviewed & { phase: 'update'; verification: Verification; pr: PrReport | null })
  | (Work & Reviewed & { phase: 'publish'; verification: Verification; pr: PrReport | null });

/** Where a task that runs the steps reports a failure; it must have this checkpoint and a `fail` phase of its own. */
export type FailState = { phase: 'fail'; issue: number; reason: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Where `start` enters the steps: a step's checkpoint without the bookkeeping `start` adds. Implement: `runs` is the
 * runs so far (`start` counts this one, within `limits.maxImplementRuns`); review and verify: the rounds so far.
 */
export type BuildStepsEntry = DistributiveOmit<BuildStepsState, 'baseline'>;

/** The input every task that runs the steps has. */
type StepsInput = { repo: string; issue: number };

/** What the steps use of a task's runtime; any task whose checkpoints include the steps' and `fail` has it. */
export type StepsRuntime<Result> = AgentRuntime & {
  readonly signal: AbortSignal;
  commit(
    change: (tx: Tx) => NextTaskState<BuildStepsState | FailState, Result> | Promise<NextTaskState<BuildStepsState | FailState, Result>>,
    context: Context,
  ): Promise<void>;
};

type Phase<P extends BuildStepsState['phase'], Result> = RunningTask<StepsInput, Extract<BuildStepsState, { phase: P }>, Result>;

export const RESULT_MARKER = commentMarker('result');

const NO_VERIFY_SKILL =
  'This repo has no verification skill (a `verify-*` skill in `.agents/skills`, `.claude/skills` or `.cursor/skills`). Create one with `/create-verification-skill` (`phat-mode init` installs it).';

const axisCount = (report: AxisReport<unknown> | null) =>
  report === null ? 'no report' : `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`;

/** The work so far, without a step's own fields. */
const work = <S extends Work>(state: S): Work => ({
  issue: state.issue,
  spec: state.spec,
  workspace: state.workspace,
  conversations: state.conversations,
  plan: state.plan,
  runs: state.runs,
  checkFixes: state.checkFixes,
  reviewRounds: state.reviewRounds,
  verifyRounds: state.verifyRounds,
  done: state.done,
  base: state.base,
  updates: state.updates,
  ...(state.unchecked ? { unchecked: true as const } : {}),
  ...(state.verifyFirst ? { verifyFirst: true as const } : {}),
  ...(state.lease === undefined ? {} : { lease: state.lease }),
});

/**
 * A fresh conversation for each build agent, in `workspace`, configured for its role. `instructions`: a role's own
 * instructions instead of the standard ones, e.g. the implementer's in a Repair.
 */
export async function createConversations(
  tx: Tx,
  options: {
    taskId: TaskId;
    config: Config;
    issue: number;
    workspace: string;
    instructions?: Partial<Record<BuildAgent, string>>;
  },
): Promise<Conversations> {
  const { taskId, config, issue, workspace } = options;
  const conversations = {} as Conversations;
  for (const role of AGENTS) {
    const model = modelFor(config, modelRole(role));
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId } });
    await configure(tx, created.id, {
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel: model.thinkingLevel,
      tools: ROLE_TOOLS[role],
      instructions: options.instructions?.[role] ?? roleInstructions(config.checkCommand)[role],
      cwd: workspace,
    });
    Object.assign(await tx.doc(RoleDoc, created.id), { role, repo: config.repo, issue, workspace });
    conversations[role] = created.id;
  }
  return conversations;
}

/** What publish did: the pull request, the commit it pushed, and the verdict it wrote for that commit. */
export type Published = { number: number; url: string; head: string; verdict: YoloVerdict };

/**
 * A task's guard on going on, asked before `update` and before `publish` (also after a resume): `check` says why the
 * task must stop, if it must (e.g. a human pushed to the pull request), and `stopped` gives the task's result then.
 * Publish also stops, with `commits added after phat-mode`, when origin moved on from `Work.lease`.
 */
export type StepsGuard<Result> = {
  check(state: Work): Promise<string | undefined>;
  stopped(state: Work, reason: string): Promise<Result>;
};

/**
 * The finishing steps, for one repo. `published`: the task's result once publish has opened or updated the pull
 * request, worked out before the task ends (so it may do more on GitHub first, which is repeated after a crash). Returns the steps' phase handlers, keyed by phase name, for the task's `defineTask`, and `start`, which moves
 * a running task to any one step. A StepFailure in a step goes to the task's `fail` phase.
 */
export function buildSteps<Result>(
  services: Services,
  { published, guard }: { published: (pr: Published) => Result | Promise<Result>; guard?: StepsGuard<Result> },
) {
  const { config, github, workspaces, checks, logger } = services;
  const { limits, labels } = config;
  const baseBranch = `origin/${config.baseBranch}`;
  type Runtime = StepsRuntime<Result>;
  /** The code review's fixed point: the commit of the base branch the change is based on. */
  const baseOf = async (state: Work) => state.base ?? (await workspaces.base(state.workspace));
  const commitMessage = (issue: Issue) => `${pullRequestTitle(issue)}\n\nCloses #${issue.number}`;

  const go = (runtime: Runtime, next: BuildStepsState | FailState, context: Context) =>
    runtime.commit(() => ({ status: 'running', checkpoint: next }), context);

  /** Number of reports a conversation has, read inside a transition so the baseline is stored with it. */
  const goWithBaseline = (
    runtime: Runtime,
    conversation: ConversationId,
    next: (baseline: number) => BuildStepsState,
    context: Context,
  ) =>
    runtime.commit(
      async (tx) => ({
        status: 'running',
        checkpoint: next((await tx.doc(ReportsDoc, conversation)).items.length),
      }),
      context,
    );

  /** Run one step; turn a StepFailure into the `fail` phase, which reports it on the issue. */
  const guarded = failureGuard<Runtime>(logger, (runtime, issue, reason, context) =>
    go(runtime, { phase: 'fail', issue, reason }, context),
  );

  /** End the task with the guard's result when it says stop. Returns whether it stopped. */
  async function stopped(runtime: Runtime, state: Work, context: Context, reason?: string): Promise<boolean> {
    if (guard === undefined) return false;
    const why = reason ?? (await guard.check(state));
    if (why === undefined) return false;
    logger.step(state.issue.number, `Stopping: ${why}`);
    const result = await guard.stopped(state, why);
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
    return true;
  }

  /** Move a running task to the step `entry` names, adding the step's bookkeeping. */
  async function start(runtime: Runtime, entry: BuildStepsEntry, context: Context): Promise<void> {
    switch (entry.phase) {
      case 'implement':
        if (entry.runs >= limits.maxImplementRuns) {
          throw new StepFailure(`Stopped after ${entry.runs} implementation attempts.`);
        }
        return goWithBaseline(
          runtime,
          entry.conversations.implement,
          (baseline) => ({ ...entry, runs: entry.runs + 1, baseline }),
          context,
        );
      case 'review':
        return runtime.commit(
          async (tx) => ({
            status: 'running',
            checkpoint: {
              ...entry,
              reviewRounds: entry.reviewRounds + 1,
              baseline: {
                standards: (await tx.doc(ReportsDoc, entry.conversations.standards)).items.length,
                spec: (await tx.doc(ReportsDoc, entry.conversations.spec)).items.length,
              },
            },
          }),
          context,
        );
      case 'verify':
        return goWithBaseline(
          runtime,
          entry.conversations.verify,
          (baseline) => ({ ...entry, verifyRounds: entry.verifyRounds + 1, baseline }),
          context,
        );
      case 'describe':
        return goWithBaseline(runtime, entry.conversations.implement, (baseline) => ({ ...entry, baseline }), context);
      default:
        return go(runtime, entry, context);
    }
  }

  /**
   * Push the verification evidence to the evidence branch, never the pull request's branch. Returns the URL of each
   * local evidence file, pinned to the evidence commit.
   */
  async function publishEvidence(issue: number, verification: Verification): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (verification.kind !== 'ran' || verification.report === null) return urls;
    const local = [
      ...new Set(verification.report.features.flatMap((result) => [...result.before, ...result.after])),
    ];
    if (local.length === 0) return urls;
    const root = paths.evidence(config, issue);
    const files = local.map((source) => ({ source, path: `issue-${issue}/${relative(root, source).replaceAll('\\', '/')}` }));
    logger.step(issue, `Publishing ${files.length} evidence file(s) to ${EVIDENCE_BRANCH}`);
    const commit = await workspaces.publishEvidence(files);
    for (const file of files) urls.set(file.source, `https://github.com/${config.repo}/blob/${commit}/${file.path}?raw=true`);
    return urls;
  }

  /** The last step before publishing: the implementer writes the pull request description. */
  const toDescribe = (runtime: Runtime, state: Work & Reviewed, verification: Verification, context: Context) =>
    start(
      runtime,
      { ...work(state), phase: 'describe', review: state.review, unresolved: state.unresolved, verification },
      context,
    );

  const phases = {
    implement: guarded<Phase<'implement', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      logger.step(state.issue.number, `Implement, run ${state.runs} (${modelFor(config, 'implement').modelId})`);
      const done = await askForReport(
        runtime,
        {
          conversation: state.conversations.implement,
          requestId: `implement-${state.runs}`,
          prompt: state.prompt,
          baseline: state.baseline,
          type: 'done',
          tool: 'report_done',
        },
        context,
      );
      await go(runtime, { ...work(state), phase: 'check', done: done ?? state.done }, context);
    }),

    check: guarded<Phase<'check', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const number = state.issue.number;
      const conflicts = await workspaces.finishMerge(state.workspace);
      if (conflicts.length > 0) {
        logger.step(number, `Conflict markers left in ${conflicts.join(', ')}`);
        await start(
          runtime,
          { ...work(state), phase: 'implement', prompt: resolveConflictsPrompt(conflicts, baseBranch, config.checkCommand) },
          context,
        );
        return;
      }
      if ((await workspaces.diff(state.workspace)).trim() === '') {
        throw new StepFailure('The implementer made no changes.');
      }
      logger.step(number, `Running checks: ${config.checkCommand}`);
      const result = await checks.run(state.workspace);
      if (result.passed) {
        logger.step(number, 'Checks pass');
        const base = await workspaces.base(state.workspace);
        const { unchecked: _checked, ...checked } = work(state);
        await start(runtime, { ...checked, base, phase: 'review' }, context);
        return;
      }
      logger.step(number, `Checks fail (fix attempt ${state.checkFixes + 1} of ${limits.maxCheckFixes})`);
      if (state.checkFixes >= limits.maxCheckFixes) {
        throw new StepFailure(
          `\`${config.checkCommand}\` still fails after ${limits.maxCheckFixes} fix attempts.\n\n<details><summary>Output</summary>\n\n\`\`\`\n${tail(result.output, 3000)}\n\`\`\`\n</details>`,
        );
      }
      await start(
        runtime,
        {
          ...work(state),
          checkFixes: state.checkFixes + 1,
          phase: 'implement',
          prompt: fixChecksPrompt(result.output, config.checkCommand),
        },
        context,
      );
    }),

    review: guarded<Phase<'review', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const number = state.issue.number;
      const round = state.reviewRounds;
      logger.step(number, `Code review, round ${round}: Standards and Spec in parallel (${modelFor(config, 'review').modelId})`);
      // The coordinator steps of the code-review skill: fixed point, spec and standards sources.
      const skill = await loadCodeReviewSkill();
      const sources = await standardsSources(state.workspace);
      const baseRef = await baseOf(state);
      const before = await workspaces.fingerprint(state.workspace);
      const diff = await workspaces.diff(state.workspace);
      // Both axes at once, each in its own conversation, so they do not pollute each other's context.
      const [standards, spec] = await Promise.all([
        askForReport(
          runtime,
          {
            conversation: state.conversations.standards,
            requestId: `standards-${round}`,
            prompt: standardsReviewPrompt({ skill, sources, baseRef, diff, round }),
            baseline: state.baseline.standards,
            type: 'standards',
            tool: 'report_standards',
          },
          context,
        ),
        askForReport(
          runtime,
          {
            conversation: state.conversations.spec,
            requestId: `spec-${round}`,
            prompt: specReviewPrompt({
              skill,
              issue: state.issue,
              spec: state.spec,
              plan: state.plan,
              departures: state.done?.departures,
              baseRef,
              diff,
              round,
            }),
            baseline: state.baseline.spec,
            type: 'spec',
            tool: 'report_spec',
          },
          context,
        ),
      ]);
      if ((await workspaces.fingerprint(state.workspace)) !== before) {
        // The reviewers are told not to edit; if files changed anyway, verify again before trusting them.
        logger.step(number, 'Files changed during review; checking again');
        await go(runtime, { ...work(state), phase: 'check' }, context);
        return;
      }
      const review: CodeReview = { round, standards: standards ?? null, spec: spec ?? null };
      const fix = mustFix(review);
      logger.step(
        number,
        `Review: Standards ${axisCount(review.standards)}, Spec ${axisCount(review.spec)}; ${fix.standards.length + fix.spec.length} must fix`,
      );
      // verifyFirst: the findings wait for the verification, and go to the implementer with its failures.
      if (!needsFixes(review) || round >= limits.maxReviewRounds || state.verifyFirst) {
        await start(
          runtime,
          { ...work(state), phase: 'verify', review, unresolved: needsFixes(review) },
          context,
        );
        return;
      }
      await start(runtime, { ...work(state), phase: 'implement', prompt: fixReviewPrompt(review, config.checkCommand) }, context);
    }),

    verify: guarded<Phase<'verify', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const number = state.issue.number;
      const round = state.verifyRounds;
      // Only one verification comes first: from here on, the steps run as in a build.
      const { verifyFirst, ...verified } = work(state);
      const reviewed: Work & Reviewed = { ...verified, review: state.review, unresolved: state.unresolved };
      /** verifyFirst: the review's must-fix findings that wait for a fix, while review rounds are left. */
      const pendingReview = verifyFirst && state.unresolved && state.review !== null && state.reviewRounds < limits.maxReviewRounds
        ? state.review
        : undefined;
      const baseRef = await baseOf(state);
      const skills = await findVerifySkills(state.workspace, baseRef);
      const skill = skills[0];
      if (skill === undefined) {
        logger.step(number, 'No verification skill in this repo; skipping verification in the app');
        if (pendingReview !== undefined) {
          await start(runtime, { ...verified, phase: 'implement', prompt: fixReviewPrompt(pendingReview, config.checkCommand) }, context);
          return;
        }
        await toDescribe(runtime, reviewed, { kind: 'skipped', reason: NO_VERIFY_SKILL }, context);
        return;
      }
      if (skills.length > 1) logger.step(number, `Several verification skills; using ${skill.name}`);
      logger.step(number, `Verifying in the app, round ${round}, with ${skill.name} (${modelFor(config, 'verify').modelId})`);
      // The skill runs as the repo defines it: protected skill files the implementer touched are reverted for good.
      const reverted = await restoreProtectedSkillFiles(state.workspace, baseRef);
      if (reverted.length > 0) logger.step(number, `Reverted changes to the verification skill: ${reverted.join(', ')}`);
      const featureMapChanged = await changedFeatureMap(state.workspace, baseRef);
      const diff = await workspaces.diff(state.workspace);
      const baseCheckout = await workspaces.prepareBase(baseRef);
      // Whatever the verifier changes in the change's files is thrown away afterwards.
      await workspaces.snapshot(state.workspace);
      const reported = await askForReport(
        runtime,
        {
          conversation: state.conversations.verify,
          requestId: `verify-${round}`,
          prompt: verifyPrompt({
            skill,
            issue: state.issue,
            spec: state.spec,
            workspace: state.workspace,
            baseCheckout,
            baseBranch,
            baseRef,
            diff,
            featureMapChanged,
            round,
          }),
          baseline: state.baseline,
          type: 'verification',
          tool: 'report_verification',
        },
        context,
      );
      let report: VerificationReport | null = null;
      if (reported !== undefined) {
        const collected = await collectEvidence(reported, {
          roots: [state.workspace, baseCheckout],
          destination: join(paths.evidence(config, number), `verify-${round}`),
        });
        if (collected.skipped.length > 0) logger.step(number, `Left out evidence: ${collected.skipped.join(', ')}`);
        report = collected.report;
      }
      const discarded = await workspaces.restoreSnapshot(state.workspace);
      if (discarded.length > 0) logger.step(number, `Discarded changes the verifier made: ${discarded.join(', ')}`);

      const failures = report === null ? [] : newFailures(report);
      logger.step(
        number,
        report === null
          ? 'The verifier did not report'
          : report.couldNotRun.trim()
            ? `Verification could not run: ${report.couldNotRun}`
            : `Verification: ${report.features.map((result) => `${result.feature} ${result.status}`).join(', ') || 'no features'}`,
      );
      if (pendingReview !== undefined) {
        // verifyFirst: the review's findings and the verification's failures, in one request.
        const prompt = [
          fixReviewPrompt(pendingReview, config.checkCommand),
          ...(failures.length > 0 ? [fixVerificationPrompt(failures, config.checkCommand)] : []),
        ].join('\n\n');
        await start(runtime, { ...verified, phase: 'implement', prompt }, context);
        return;
      }
      if (failures.length > 0 && round < limits.maxVerifyRounds) {
        await start(
          runtime,
          { ...verified, phase: 'implement', prompt: fixVerificationPrompt(failures, config.checkCommand) },
          context,
        );
        return;
      }
      const verification: Verification = {
        kind: 'ran',
        skill: skill.name,
        round,
        report,
        reverted,
        featureMapChanged,
        unresolved: failures.length > 0,
      };
      await toDescribe(runtime, reviewed, verification, context);
    }),

    describe: guarded<Phase<'describe', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const number = state.issue.number;
      logger.step(number, `Writing the pull request description (${modelFor(config, 'implement').modelId})`);
      const before = await workspaces.fingerprint(state.workspace);
      const pr = await askForReport(
        runtime,
        {
          conversation: state.conversations.implement,
          // A new request after each merge of the base branch, which describes again without a new implementer run.
          requestId: `describe-${state.runs}${state.updates ? `-${state.updates}` : ''}`,
          prompt: describePrompt(await prSkill(), state.unresolved),
          baseline: state.baseline,
          type: 'pr',
          tool: 'report_pr',
        },
        context,
      );
      if ((await workspaces.fingerprint(state.workspace)) !== before) {
        // Changes made now were neither checked, reviewed nor verified: do all three, as a new implementer run.
        logger.step(number, 'Files changed while writing the description; verifying and reviewing again');
        if (state.runs >= limits.maxImplementRuns) {
          throw new StepFailure(`Stopped after ${state.runs} implementation attempts.`);
        }
        await go(runtime, { ...work(state), runs: state.runs + 1, phase: 'check' }, context);
        return;
      }
      if (pr === undefined) logger.step(number, 'No description reported; using a plain one');
      await go(
        runtime,
        {
          ...work(state),
          phase: 'update',
          review: state.review,
          unresolved: state.unresolved,
          verification: state.verification,
          pr: pr ?? null,
        },
        context,
      );
    }),

    update: guarded<Phase<'update', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const { issue, workspace } = state;
      const updates = state.updates ?? 0;
      if (await stopped(runtime, state, context)) return;
      const toPublish = () => go(runtime, { ...state, phase: 'publish' }, context);
      if (updates >= limits.maxBranchUpdates) {
        logger.step(issue.number, `Not merging ${baseBranch} again after ${updates} merges; opening the pull request as it is`);
        if (state.unchecked) await go(runtime, { ...work(state), phase: 'check' }, context);
        else await toPublish();
        return;
      }
      // A crash during verification can leave its local snapshot commit behind.
      await workspaces.undoSnapshot(workspace);
      const checkedBase = await baseOf(state);
      logger.step(issue.number, `Updating ${branchFor(issue.number)} with ${baseBranch}`);
      const conflicts = await workspaces.updateBranch(workspace, commitMessage(issue));
      const next: Work = { ...work(state), updates: updates + 1 };
      if (conflicts.length > 0) {
        logger.step(issue.number, `${baseBranch} moved on; merging it conflicts in ${conflicts.join(', ')}`);
        await start(
          runtime,
          { ...next, phase: 'implement', prompt: resolveConflictsPrompt(conflicts, baseBranch, config.checkCommand) },
          context,
        );
        return;
      }
      // Compared with the base the change was checked against, so a merge made just before a crash still counts.
      if ((await workspaces.base(workspace)) !== checkedBase) {
        logger.step(issue.number, `${baseBranch} moved on; merged it in, checking, reviewing and verifying again`);
        await go(runtime, { ...next, phase: 'check' }, context);
        return;
      }
      if (state.unchecked) {
        logger.step(issue.number, 'Checking, reviewing and verifying');
        await go(runtime, { ...next, phase: 'check' }, context);
        return;
      }
      await toPublish();
    }),

    publish: guarded<Phase<'publish', Result>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const { issue, workspace } = state;
      const branch = branchFor(issue.number);
      // A crash during verification can leave its local snapshot commit behind.
      await workspaces.undoSnapshot(workspace);
      if (await stopped(runtime, state, context)) return;
      logger.step(issue.number, `Committing and pushing ${branch}`);
      await workspaces.commitAll(workspace, commitMessage(issue));
      if ((await workspaces.commitsAhead(workspace)) === 0) {
        throw new StepFailure('There are no changes to open a pull request with.');
      }
      const pushed =
        state.lease === undefined
          ? await workspaces.push(workspace, issue.number)
          : await workspaces.pushOver(workspace, issue.number, state.lease);
      if (pushed === undefined) {
        if (await stopped(runtime, state, context, 'commits added after phat-mode')) return;
        throw new StepFailure(`${branch} moved on while phat-mode worked; nothing was pushed.`);
      }

      const evidenceUrls = await publishEvidence(issue.number, state.verification);
      const described = pullRequestBody({
        issue,
        spec: state.spec,
        plan: state.plan,
        done: state.done ?? undefined,
        pr: state.pr ?? undefined,
        verification: state.verification,
        evidenceUrls,
        review: state.review ?? undefined,
        unresolved: state.unresolved,
        checkCommand: config.checkCommand,
      });
      const verdict = verdictFor(pushed, state);
      const body = `${described}\n\n${yoloMarker(verdict)}`;
      let pr = await github.findPullRequest(branch);
      if (pr === undefined) {
        pr = await github.createPullRequest({ branch, base: config.baseBranch, title: pullRequestTitle(issue), body });
      } else {
        await github.updatePullRequestBody(pr.number, body);
        // A pull request from before phat-mode stopped opening drafts.
        if (pr.isDraft) await github.markReadyForReview(pr.number);
      }
      // On a pull request, ready-for-human means: ready for a human to review and merge.
      await github.editLabels(pr.number, { add: [labels.readyForHuman] });
      await github.upsertComment(issue.number, RESULT_MARKER, doneComment(pr.url));
      // The issue keeps ready-for-agent until the PR closes it; phat-mode:done shows an agent already did it.
      await github.editLabels(issue.number, progressChange('done'));
      logger.step(issue.number, `Pull request: ${pr.url}`);
      const result = await published({ number: pr.number, url: pr.url, head: pushed, verdict });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);
    }),
  };

  return { phases, start };
}

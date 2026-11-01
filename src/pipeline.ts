import type { Context } from '@earendil-works/chord/context';
import {
  type ConversationId,
  configure,
  defineExtension,
  defineTask,
  type Extension,
  type RunningTask,
  type TaskRuntime,
} from '@earendil-works/pi-durable';
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
import {
  type AxisReport,
  type CodeReview,
  loadCodeReviewSkill,
  mustFix,
  needsFixes,
  standardsSources,
} from './code-review.ts';
import { eligibility, type ParentIssue, parentRef, type Spec } from './spec.ts';
import { mkdir } from 'node:fs/promises';
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
import { commentMarker, type GitHub, type Issue, mergeLabels, progressChange } from './github.ts';
import type { Logger } from './log.ts';
import {
  doneComment,
  failedComment,
  needsHumanComment,
  needsInfoComment,
  planComment,
  pullRequestBody,
  pullRequestTitle,
} from './messages.ts';
import {
  fixChecksPrompt,
  fixReviewPrompt,
  implementPrompt,
  planPrompt,
  describePrompt,
  fixVerificationPrompt,
  resolveConflictsPrompt,
  roleInstructions,
  specReviewPrompt,
  standardsReviewPrompt,
  verifyPrompt,
} from './prompts.ts';
import { askForReport, failureGuard, perRepo, StepFailure } from './task-kit.ts';
import { type Checks, EVIDENCE_BRANCH, tail, type Workspaces } from './workspace.ts';
import { verdictFor, yoloMarker } from './yolo.ts';

export type Services = {
  config: Config;
  github: GitHub;
  workspaces: Workspaces;
  checks: Checks;
  logger: Logger;
};

export type PipelineInput = { repo: string; issue: number };

type Conversations = Record<BuildAgent, ConversationId>;

/** Known once the workspace is ready. `spec`: what to build, from an Agent Brief or the issue body. */
type Setup = { issue: Issue; spec: Spec; workspace: string; conversations: Conversations };

/** Known once the planner decided to proceed. */
type Work = Setup & {
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
};

/** The outcome of the code review, carried to the pull request. */
type Reviewed = { review: CodeReview | null; unresolved: boolean };

export type PipelineState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'plan' })
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
  | (Work & Reviewed & { phase: 'publish'; verification: Verification; pr: PrReport | null })
  | { phase: 'fail'; issue: number; reason: string };

export type PipelineResult =
  | { status: 'pr_opened'; url: string }
  | { status: 'needs_info' }
  | { status: 'needs_human' }
  | { status: 'ignored'; reason: string };

type Runtime = TaskRuntime<PipelineInput, PipelineState, PipelineResult, object>;
type Phase<P extends PipelineState['phase']> = RunningTask<PipelineInput, Extract<PipelineState, { phase: P }>, PipelineResult>;

const MARKERS = { plan: commentMarker('plan'), result: commentMarker('result') };

/** A parent issue is background; long specs (PRDs) are cut so they do not crowd out the issue itself. */
const PARENT_MAX_CHARS = 20_000;

/** Where the planner and implementer keep downloads and working files: next to the workspace, never committed. */
export const scratchFor = (workspace: string) => `${workspace}-scratch`;

const NO_VERIFY_SKILL =
  'This repo has no verification skill (a `verify-*` skill in `.agents/skills`, `.claude/skills` or `.cursor/skills`). Create one with `/create-verification-skill` (`phat-mode init` installs it).';

const axisCount = (report: AxisReport<unknown> | null) =>
  report === null ? 'no report' : `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`;

/**
 * The pipeline, for every repo: each run uses the services for its own repo (`task.input.repo`), so one process works
 * on any number of repos. `servicesFor` is called once per repo; a failure is retried on the next phase.
 */
export function createPipeline(servicesFor: (repo: string) => Promise<Services>) {
  const phasesFor = perRepo(async (repo) => repoPhases(await servicesFor(repo)));
  const Pipeline = defineTask<PipelineInput, PipelineState, PipelineResult>({
    name: 'phat.pipeline',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => (await phasesFor(task.input.repo)).prepare(task, runtime, context),
      plan: async (task, runtime, context) => (await phasesFor(task.input.repo)).plan(task, runtime, context),
      implement: async (task, runtime, context) => (await phasesFor(task.input.repo)).implement(task, runtime, context),
      check: async (task, runtime, context) => (await phasesFor(task.input.repo)).check(task, runtime, context),
      review: async (task, runtime, context) => (await phasesFor(task.input.repo)).review(task, runtime, context),
      verify: async (task, runtime, context) => (await phasesFor(task.input.repo)).verify(task, runtime, context),
      describe: async (task, runtime, context) => (await phasesFor(task.input.repo)).describe(task, runtime, context),
      update: async (task, runtime, context) => (await phasesFor(task.input.repo)).update(task, runtime, context),
      publish: async (task, runtime, context) => (await phasesFor(task.input.repo)).publish(task, runtime, context),
      fail: async (task, runtime, context) => (await phasesFor(task.input.repo)).fail(task, runtime, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const extension: Extension = defineExtension({ name: 'phat.pipeline', tasks: [Pipeline] });
  return { Pipeline, extension };
}

/** Every phase of a run, for one repo. */
function repoPhases(services: Services) {
  const { config, github, workspaces, checks, logger } = services;
  const { limits, labels } = config;
  const baseBranch = `origin/${config.baseBranch}`;
  /** The code review's fixed point: the commit of the base branch the change is based on. */
  const baseOf = async (state: Work) => state.base ?? (await workspaces.base(state.workspace));
  const commitMessage = (issue: Issue) => `${pullRequestTitle(issue)}\n\nCloses #${issue.number}`;

  const go = (runtime: Runtime, next: PipelineState, context: Context) =>
    runtime.commit(() => ({ status: 'running', checkpoint: next }), context);

  const finish = (runtime: Runtime, result: PipelineResult, context: Context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);

  /** Number of reports a conversation has, read inside a transition so the baseline is stored with it. */
  const goWithBaseline = (
    runtime: Runtime,
    conversation: ConversationId,
    next: (baseline: number) => PipelineState,
    context: Context,
  ) =>
    runtime.commit(
      async (tx) => ({
        status: 'running',
        checkpoint: next((await tx.doc(ReportsDoc, conversation)).items.length),
      }),
      context,
    );

  /** Run one phase; turn a StepFailure into the `fail` phase, which reports it on the issue. */
  const guarded = failureGuard<Runtime>(logger, (runtime, issue, reason, context) =>
    go(runtime, { phase: 'fail', issue, reason }, context),
  );

  const toImplement = (runtime: Runtime, work: Work, prompt: string, context: Context) => {
    if (work.runs >= limits.maxImplementRuns) {
      throw new StepFailure(`Stopped after ${work.runs} implementation attempts.`);
    }
    return goWithBaseline(
      runtime,
      work.conversations.implement,
      (baseline) => ({ ...work, phase: 'implement', runs: work.runs + 1, prompt, baseline }),
      context,
    );
  };

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

  /**
   * The issue's parent (the larger plan it is part of: GitHub's native parent, else "## Parent #N" in its body), as
   * background for every agent. Only from a trusted author, like an Agent Brief; anything else is left out.
   */
  async function findParent(issue: Issue): Promise<ParentIssue | undefined> {
    const number = (await github.parentIssue(issue.number)) ?? parentRef(issue.body, config.repo);
    if (number === undefined || number === issue.number) return undefined;
    const parent = await github.getIssue(number).catch(() => undefined);
    if (parent === undefined) {
      logger.step(issue.number, `Parent #${number} could not be read; continuing without it`);
      return undefined;
    }
    if (!config.allowedAuthors.includes(parent.author)) {
      logger.step(issue.number, `Parent #${number} is by ${parent.author}, not a trusted author; leaving it out`);
      return undefined;
    }
    const body = parent.body.trim();
    logger.step(issue.number, `Parent #${number}: "${parent.title}" (background for the agents)`);
    return {
      number,
      title: parent.title,
      author: parent.author,
      body: body.length > PARENT_MAX_CHARS ? `${body.slice(0, PARENT_MAX_CHARS)}\n… (truncated)` : body,
    };
  }

  /** The last step before publishing: the implementer writes the pull request description. */
  const toDescribe = (runtime: Runtime, state: Work & Reviewed, verification: Verification, context: Context) =>
    goWithBaseline(
      runtime,
      state.conversations.implement,
      (baseline) => ({
        ...work(state),
        phase: 'describe',
        review: state.review,
        unresolved: state.unresolved,
        verification,
        baseline,
      }),
      context,
    );

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
  });

  return {
      prepare: guarded<Phase<'prepare'>>(async (task, runtime, context) => {
        const number = task.input.issue;
        const fetched = await github.getIssue(number);
        const eligible = eligibility(fetched, config);
        if (!eligible.ok) {
          // Not ready, or not specified by someone trusted: leave the issue alone, without any reply.
          logger.error(eligible.reason);
          await finish(runtime, { status: 'ignored', reason: eligible.reason }, context);
          return;
        }
        let { spec } = eligible;
        const blockers = await github.openBlockers(number, spec.blockedBy);
        if (blockers.length > 0) {
          const reason = `#${number} is blocked by ${blockers.map((blocker) => `#${blocker}`).join(', ')}, still open.`;
          logger.error(reason);
          await finish(runtime, { status: 'ignored', reason }, context);
          return;
        }
        const parent = await findParent(fetched);
        if (parent !== undefined) spec = { ...spec, parent };
        // The spec is kept on its own; comments are not needed again.
        const issue: Issue = { ...fetched, comments: [] };
        logger.step(
          number,
          `Preparing workspace for "${issue.title}" (spec: ${spec.source === 'brief' ? `Agent Brief by ${spec.author}` : `issue body by ${spec.author}`})`,
        );
        await github.editLabels(number, progressChange('working'));
        const workspace = await workspaces.prepare(number);
        await mkdir(scratchFor(workspace), { recursive: true });
        logger.step(number, `Workspace ready: ${workspace}`);

        await runtime.commit(async (tx) => {
          const conversations = {} as Conversations;
          for (const role of AGENTS) {
            const model = modelFor(config, modelRole(role));
            const created = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
            await configure(tx, created.id, {
              model: { provider: model.provider, modelId: model.modelId },
              thinkingLevel: model.thinkingLevel,
              tools: ROLE_TOOLS[role],
              instructions: roleInstructions(config.checkCommand)[role],
              cwd: workspace,
            });
            Object.assign(await tx.doc(RoleDoc, created.id), { role, issue: number, workspace });
            conversations[role] = created.id;
          }
          return { status: 'running', checkpoint: { phase: 'plan', issue, spec, workspace, conversations } };
        }, context);
      }),

      plan: guarded<Phase<'plan'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, spec } = state;
        logger.step(issue.number, `Plan (${modelFor(config, 'plan').modelId})`);
        const plan = await askForReport(
          runtime,
          {
            conversation: state.conversations.plan,
            requestId: 'plan',
            prompt: planPrompt(issue, spec, scratchFor(state.workspace)),
            baseline: 0,
            type: 'plan',
            tool: 'report_plan',
          },
          context,
        );
        if (plan === undefined) throw new StepFailure('The planner did not give a plan.');
        logger.step(issue.number, `Plan: ${plan.decision}: ${plan.summary}`);

        // Hand back with the triage labels; phat-mode's own progress label goes.
        if (plan.decision === 'needs_info') {
          await github.upsertComment(issue.number, MARKERS.plan, needsInfoComment(plan, issue, labels));
          await github.editLabels(
            issue.number,
            mergeLabels(progressChange(null), { add: [labels.needsInfo], remove: [labels.readyForAgent] }),
          );
          await finish(runtime, { status: 'needs_info' }, context);
          return;
        }
        if (plan.decision === 'needs_human') {
          await github.upsertComment(issue.number, MARKERS.plan, needsHumanComment(plan, labels));
          await github.editLabels(
            issue.number,
            mergeLabels(progressChange(null), { add: [labels.readyForHuman], remove: [labels.readyForAgent] }),
          );
          await finish(runtime, { status: 'needs_human' }, context);
          return;
        }
        await github.upsertComment(issue.number, MARKERS.plan, planComment(plan));
        const start: Work = { ...state, plan, runs: 0, checkFixes: 0, reviewRounds: 0, verifyRounds: 0, done: null };
        await toImplement(runtime, start, implementPrompt(issue, spec, plan, scratchFor(state.workspace)), context);
      }),

      implement: guarded<Phase<'implement'>>(async (task, runtime, context) => {
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

      check: guarded<Phase<'check'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const number = state.issue.number;
        const conflicts = await workspaces.finishMerge(state.workspace);
        if (conflicts.length > 0) {
          logger.step(number, `Conflict markers left in ${conflicts.join(', ')}`);
          await toImplement(runtime, work(state), resolveConflictsPrompt(conflicts, baseBranch, config.checkCommand), context);
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
          await runtime.commit(
            async (tx) => ({
              status: 'running',
              checkpoint: {
                ...work(state),
                base,
                phase: 'review',
                reviewRounds: state.reviewRounds + 1,
                baseline: {
                  standards: (await tx.doc(ReportsDoc, state.conversations.standards)).items.length,
                  spec: (await tx.doc(ReportsDoc, state.conversations.spec)).items.length,
                },
              },
            }),
            context,
          );
          return;
        }
        logger.step(number, `Checks fail (fix attempt ${state.checkFixes + 1} of ${limits.maxCheckFixes})`);
        if (state.checkFixes >= limits.maxCheckFixes) {
          throw new StepFailure(
            `\`${config.checkCommand}\` still fails after ${limits.maxCheckFixes} fix attempts.\n\n<details><summary>Output</summary>\n\n\`\`\`\n${tail(result.output, 3000)}\n\`\`\`\n</details>`,
          );
        }
        await toImplement(
          runtime,
          { ...work(state), checkFixes: state.checkFixes + 1 },
          fixChecksPrompt(result.output, config.checkCommand),
          context,
        );
      }),

      review: guarded<Phase<'review'>>(async (task, runtime, context) => {
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
              prompt: specReviewPrompt({ skill, issue: state.issue, spec: state.spec, baseRef, diff, round }),
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
        if (!needsFixes(review) || round >= limits.maxReviewRounds) {
          await goWithBaseline(
            runtime,
            state.conversations.verify,
            (baseline) => ({
              ...work(state),
              phase: 'verify',
              verifyRounds: state.verifyRounds + 1,
              review,
              unresolved: needsFixes(review),
              baseline,
            }),
            context,
          );
          return;
        }
        await toImplement(runtime, work(state), fixReviewPrompt(review, config.checkCommand), context);
      }),

      verify: guarded<Phase<'verify'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const number = state.issue.number;
        const round = state.verifyRounds;
        const baseRef = await baseOf(state);
        const skills = await findVerifySkills(state.workspace, baseRef);
        const skill = skills[0];
        if (skill === undefined) {
          logger.step(number, 'No verification skill in this repo; skipping verification in the app');
          await toDescribe(runtime, state, { kind: 'skipped', reason: NO_VERIFY_SKILL }, context);
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
        if (failures.length > 0 && round < limits.maxVerifyRounds) {
          await toImplement(runtime, work(state), fixVerificationPrompt(failures, config.checkCommand), context);
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
        await toDescribe(runtime, state, verification, context);
      }),

      describe: guarded<Phase<'describe'>>(async (task, runtime, context) => {
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

      update: guarded<Phase<'update'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, workspace } = state;
        const updates = state.updates ?? 0;
        const toPublish = () => go(runtime, { ...state, phase: 'publish' }, context);
        if (updates >= limits.maxBranchUpdates) {
          logger.step(issue.number, `Not merging ${baseBranch} again after ${updates} merges; opening the pull request as it is`);
          await toPublish();
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
          await toImplement(runtime, next, resolveConflictsPrompt(conflicts, baseBranch, config.checkCommand), context);
          return;
        }
        // Compared with the base the change was checked against, so a merge made just before a crash still counts.
        if ((await workspaces.base(workspace)) !== checkedBase) {
          logger.step(issue.number, `${baseBranch} moved on; merged it in, checking, reviewing and verifying again`);
          await go(runtime, { ...next, phase: 'check' }, context);
          return;
        }
        await toPublish();
      }),

      publish: guarded<Phase<'publish'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, workspace } = state;
        const branch = branchFor(issue.number);
        // A crash during verification can leave its local snapshot commit behind.
        await workspaces.undoSnapshot(workspace);
        logger.step(issue.number, `Committing and pushing ${branch}`);
        await workspaces.commitAll(workspace, commitMessage(issue));
        if ((await workspaces.commitsAhead(workspace)) === 0) {
          throw new StepFailure('There are no changes to open a pull request with.');
        }
        const pushed = await workspaces.push(workspace, issue.number);

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
        const body = `${described}\n\n${yoloMarker(verdictFor(pushed, state))}`;
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
        await github.upsertComment(issue.number, MARKERS.result, doneComment(pr.url));
        // The issue keeps ready-for-agent until the PR closes it; phat-mode:done shows an agent already did it.
        await github.editLabels(issue.number, progressChange('done'));
        logger.step(issue.number, `Pull request: ${pr.url}`);
        await finish(runtime, { status: 'pr_opened', url: pr.url }, context);
      }),

      fail: async (task: Phase<'fail'>, runtime: Runtime, context: Context) => {
        const { issue, reason } = task.state.checkpoint;
        await github.upsertComment(issue, MARKERS.result, failedComment(reason, labels));
        // An agent could not do it: a human should.
        await github.editLabels(
          issue,
          mergeLabels(progressChange('failed'), { add: [labels.readyForHuman], remove: [labels.readyForAgent] }),
        );
        await runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'failed', error: { message: reason } } }),
          context,
        );
      },
  };
}

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
  type DoneReport,
  type Report,
  ReportsDoc,
  type ReviewReport,
  type Role,
  ROLE_TOOLS,
  RoleDoc,
  type PlanReport,
} from './agents.ts';
import { eligibility, type Spec } from './spec.ts';
import { branchFor, type Config } from './config.ts';
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
  NUDGE,
  planPrompt,
  ROLE_INSTRUCTIONS,
  reviewPrompt,
} from './prompts.ts';
import { type Checks, tail, type Workspaces } from './workspace.ts';

export type Services = {
  config: Config;
  github: GitHub;
  workspaces: Workspaces;
  checks: Checks;
  logger: Logger;
};

export type PipelineInput = { repo: string; issue: number };

type Conversations = Record<Role, ConversationId>;
type ReportData = { plan: PlanReport; done: DoneReport; review: ReviewReport };

/** Known once the workspace is ready. `spec`: what to build, from an Agent Brief or the issue body. */
type Setup = { issue: Issue; spec: Spec; workspace: string; conversations: Conversations };

/** Known once the planner decided to proceed. */
type Work = Setup & {
  plan: PlanReport;
  /** Implementer runs so far; also names each run's request. */
  runs: number;
  checkFixes: number;
  reviewRounds: number;
  done: DoneReport | null;
};

export type PipelineState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'plan' })
  /** `baseline`: how many reports the agent had made before this request, so only new ones count. */
  | (Work & { phase: 'implement'; prompt: string; baseline: number })
  | (Work & { phase: 'verify' })
  | (Work & { phase: 'review'; baseline: number })
  | (Work & { phase: 'publish'; review: ReviewReport | null; unresolved: string[] })
  | { phase: 'fail'; issue: number; reason: string };

export type PipelineResult =
  | { status: 'pr_opened'; url: string }
  | { status: 'needs_info' }
  | { status: 'needs_human' }
  | { status: 'ignored'; reason: string };

type Runtime = TaskRuntime<PipelineInput, PipelineState, PipelineResult, object>;
type Phase<P extends PipelineState['phase']> = RunningTask<PipelineInput, Extract<PipelineState, { phase: P }>, PipelineResult>;

/** A failure the pipeline reports on the issue, instead of a crash. */
class StepFailure extends Error {}

const MARKERS = { plan: commentMarker('plan'), result: commentMarker('result') };

export function createPipeline(services: Services) {
  const { config, github, workspaces, checks, logger } = services;
  const { limits, labels } = config;

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
  const guarded =
    <P extends PipelineState['phase']>(body: (task: Phase<P>, runtime: Runtime, context: Context) => Promise<void>) =>
    async (task: Phase<P>, runtime: Runtime, context: Context) => {
      try {
        await body(task, runtime, context);
      } catch (error) {
        if (!(error instanceof StepFailure) || runtime.signal.aborted) throw error;
        logger.error(`#${task.input.issue}: ${error.message}`);
        await go(runtime, { phase: 'fail', issue: task.input.issue, reason: error.message }, context);
      }
    };

  /** Send one request to an agent and wait for its answer. Same request id after a restart: same request. */
  async function ask(runtime: Runtime, conversation: ConversationId, requestId: string, content: string, context: Context) {
    const handle = await runtime.conversation(conversation, context);
    if (handle === undefined) throw new Error(`Conversation ${conversation} is missing`);
    const settled = await (await handle.submit({ type: 'input', content, requestId }, context)).wait(context);
    if (settled.status !== 'done') {
      throw new StepFailure(`An agent stopped without answering (${settled.reason}).`);
    }
  }

  async function latestReport<T extends Report['type']>(
    runtime: Runtime,
    conversation: ConversationId,
    baseline: number,
    type: T,
    context: Context,
  ): Promise<ReportData[T] | undefined> {
    const doc = await runtime.snapshot(ReportsDoc, conversation, context);
    const report = (doc?.items ?? [])
      .slice(baseline)
      .filter((item) => item.type === type)
      .at(-1);
    return report?.data as ReportData[T] | undefined;
  }

  /** Ask, then read the report the agent made; nudge once if it forgot to report. */
  async function askForReport<T extends Report['type']>(
    runtime: Runtime,
    options: { conversation: ConversationId; requestId: string; prompt: string; baseline: number; type: T; tool: string },
    context: Context,
  ) {
    const { conversation, requestId, prompt, baseline, type, tool } = options;
    await ask(runtime, conversation, requestId, prompt, context);
    const report = await latestReport(runtime, conversation, baseline, type, context);
    if (report !== undefined) return report;
    await ask(runtime, conversation, `${requestId}:nudge`, NUDGE(tool), context);
    return latestReport(runtime, conversation, baseline, type, context);
  }

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

  const work = <S extends Work>(state: S): Work => ({
    issue: state.issue,
    spec: state.spec,
    workspace: state.workspace,
    conversations: state.conversations,
    plan: state.plan,
    runs: state.runs,
    checkFixes: state.checkFixes,
    reviewRounds: state.reviewRounds,
    done: state.done,
  });

  const Pipeline = defineTask<PipelineInput, PipelineState, PipelineResult>({
    name: 'phat.pipeline',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: guarded<'prepare'>(async (task, runtime, context) => {
        const number = task.input.issue;
        const fetched = await github.getIssue(number);
        const eligible = eligibility(fetched, config);
        if (!eligible.ok) {
          // Not ready, or not specified by someone trusted: leave the issue alone, without any reply.
          logger.error(eligible.reason);
          await finish(runtime, { status: 'ignored', reason: eligible.reason }, context);
          return;
        }
        const { spec } = eligible;
        const blockers = await github.openBlockers(number, spec.blockedBy);
        if (blockers.length > 0) {
          const reason = `#${number} is blocked by ${blockers.map((blocker) => `#${blocker}`).join(', ')}, still open.`;
          logger.error(reason);
          await finish(runtime, { status: 'ignored', reason }, context);
          return;
        }
        // The spec is kept on its own; comments are not needed again.
        const issue: Issue = { ...fetched, comments: [] };
        logger.step(
          number,
          `Preparing workspace for "${issue.title}" (spec: ${spec.source === 'brief' ? `Agent Brief by ${spec.author}` : `issue body by ${spec.author}`})`,
        );
        await github.editLabels(number, progressChange('working'));
        const workspace = await workspaces.prepare(number);
        logger.step(number, `Workspace ready: ${workspace}`);

        await runtime.commit(async (tx) => {
          const conversations = {} as Conversations;
          for (const role of ['plan', 'implement', 'review'] as const) {
            const model = config.models[role];
            const created = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } });
            await configure(tx, created.id, {
              model: { provider: model.provider, modelId: model.modelId },
              thinkingLevel: model.thinkingLevel ?? 'medium',
              tools: ROLE_TOOLS[role],
              instructions: ROLE_INSTRUCTIONS[role],
              cwd: workspace,
            });
            Object.assign(await tx.doc(RoleDoc, created.id), { role, issue: number, workspace });
            conversations[role] = created.id;
          }
          return { status: 'running', checkpoint: { phase: 'plan', issue, spec, workspace, conversations } };
        }, context);
      }),

      plan: guarded<'plan'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, spec } = state;
        logger.step(issue.number, `Plan (${config.models.plan.modelId})`);
        const plan = await askForReport(
          runtime,
          {
            conversation: state.conversations.plan,
            requestId: 'plan',
            prompt: planPrompt(issue, spec),
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
        const start: Work = { ...state, plan, runs: 0, checkFixes: 0, reviewRounds: 0, done: null };
        await toImplement(runtime, start, implementPrompt(issue, spec, plan), context);
      }),

      implement: guarded<'implement'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        logger.step(state.issue.number, `Implement, run ${state.runs} (${config.models.implement.modelId})`);
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
        await go(runtime, { ...work(state), phase: 'verify', done: done ?? state.done }, context);
      }),

      verify: guarded<'verify'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const number = state.issue.number;
        if ((await workspaces.diff(state.workspace)).trim() === '') {
          throw new StepFailure('The implementer made no changes.');
        }
        logger.step(number, `Running checks: ${config.checkCommand}`);
        const result = await checks.run(state.workspace);
        if (result.passed) {
          logger.step(number, 'Checks pass');
          await goWithBaseline(
            runtime,
            state.conversations.review,
            (baseline) => ({ ...work(state), phase: 'review', reviewRounds: state.reviewRounds + 1, baseline }),
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
          fixChecksPrompt(result.output),
          context,
        );
      }),

      review: guarded<'review'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const number = state.issue.number;
        logger.step(number, `Review, round ${state.reviewRounds} (${config.models.review.modelId})`);
        const before = await workspaces.fingerprint(state.workspace);
        const diff = await workspaces.diff(state.workspace);
        const review = await askForReport(
          runtime,
          {
            conversation: state.conversations.review,
            requestId: `review-${state.reviewRounds}`,
            prompt: reviewPrompt(state.issue, state.spec, state.plan, state.done ?? undefined, diff),
            baseline: state.baseline,
            type: 'review',
            tool: 'report_review',
          },
          context,
        );
        if ((await workspaces.fingerprint(state.workspace)) !== before) {
          // The reviewer is told not to edit; if files changed anyway, verify again before trusting them.
          logger.step(number, 'Files changed during review; verifying again');
          await go(runtime, { ...work(state), phase: 'verify' }, context);
          return;
        }
        if (review === undefined) {
          await go(
            runtime,
            { ...work(state), phase: 'publish', review: null, unresolved: ['The reviewer agent did not give a verdict.'] },
            context,
          );
          return;
        }
        logger.step(number, `Review: ${review.verdict}${review.findings.length ? `, ${review.findings.length} finding(s)` : ''}`);
        if (review.verdict === 'approve' || review.findings.length === 0) {
          await go(runtime, { ...work(state), phase: 'publish', review, unresolved: [] }, context);
          return;
        }
        if (state.reviewRounds >= limits.maxReviewRounds) {
          await go(runtime, { ...work(state), phase: 'publish', review, unresolved: review.findings }, context);
          return;
        }
        await toImplement(runtime, work(state), fixReviewPrompt(review.findings), context);
      }),

      publish: guarded<'publish'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, workspace } = state;
        const branch = branchFor(issue.number);
        logger.step(issue.number, `Committing and pushing ${branch}`);
        await workspaces.commitAll(workspace, `${pullRequestTitle(issue)}\n\nCloses #${issue.number}`);
        if ((await workspaces.commitsAhead(workspace)) === 0) {
          throw new StepFailure('There are no changes to open a pull request with.');
        }
        await workspaces.push(workspace, issue.number);

        const body = pullRequestBody({
          issue,
          spec: state.spec,
          plan: state.plan,
          done: state.done ?? undefined,
          review: state.review ?? undefined,
          unresolved: state.unresolved,
          checkCommand: config.checkCommand,
        });
        let pr = await github.findPullRequest(branch);
        if (pr === undefined) {
          pr = await github.createDraftPullRequest({ branch, base: config.baseBranch, title: pullRequestTitle(issue), body });
        } else {
          await github.updatePullRequestBody(pr.number, body);
        }
        // On a pull request, ready-for-human means: ready for a human to review and merge.
        await github.editLabels(pr.number, { add: [labels.readyForHuman] });
        await github.upsertComment(issue.number, MARKERS.result, doneComment(pr.url));
        // The issue keeps ready-for-agent until the PR closes it; phat-mode:done shows an agent already did it.
        await github.editLabels(issue.number, progressChange('done'));
        logger.step(issue.number, `Draft pull request: ${pr.url}`);
        await finish(runtime, { status: 'pr_opened', url: pr.url }, context);
      }),

      fail: async (task, runtime, context) => {
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
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const extension: Extension = defineExtension({ name: 'phat.pipeline', tasks: [Pipeline] });
  return { Pipeline, extension };
}

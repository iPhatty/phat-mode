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
  type TriageReport,
} from './agents.ts';
import { branchFor, type Config } from './config.ts';
import { commentMarker, type GitHub, type Issue } from './github.ts';
import type { Logger } from './log.ts';
import {
  doneComment,
  failedComment,
  needsInfoComment,
  planComment,
  pullRequestBody,
  pullRequestTitle,
  rejectedComment,
} from './messages.ts';
import {
  fixChecksPrompt,
  fixReviewPrompt,
  implementPrompt,
  NUDGE,
  ROLE_INSTRUCTIONS,
  reviewPrompt,
  triagePrompt,
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
type ReportData = { triage: TriageReport; done: DoneReport; review: ReviewReport };

/** Known once the workspace is ready. */
type Setup = { issue: Issue; workspace: string; conversations: Conversations };

/** Known once triage decided to proceed. */
type Work = Setup & {
  triage: TriageReport;
  /** Implementer runs so far; also names each run's request. */
  runs: number;
  checkFixes: number;
  reviewRounds: number;
  done: DoneReport | null;
};

export type PipelineState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'triage' })
  /** `baseline`: how many reports the agent had made before this request, so only new ones count. */
  | (Work & { phase: 'implement'; prompt: string; baseline: number })
  | (Work & { phase: 'verify' })
  | (Work & { phase: 'review'; baseline: number })
  | (Work & { phase: 'publish'; review: ReviewReport | null; unresolved: string[] })
  | { phase: 'fail'; issue: number; reason: string };

export type PipelineResult =
  | { status: 'pr_opened'; url: string }
  | { status: 'needs_info' }
  | { status: 'rejected' }
  | { status: 'ignored'; reason: string };

type Runtime = TaskRuntime<PipelineInput, PipelineState, PipelineResult, object>;
type Phase<P extends PipelineState['phase']> = RunningTask<PipelineInput, Extract<PipelineState, { phase: P }>, PipelineResult>;

/** A failure the pipeline reports on the issue, instead of a crash. */
class StepFailure extends Error {}

const MARKERS = { triage: commentMarker('triage'), result: commentMarker('result') };

export function createPipeline(services: Services) {
  const { config, github, workspaces, checks, logger } = services;
  const { limits } = config;

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
    workspace: state.workspace,
    conversations: state.conversations,
    triage: state.triage,
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
        const issue = await github.getIssue(number);
        if (!config.allowedAuthors.includes(issue.author)) {
          // Never engage with issues from people who are not allowed to use phat-mode.
          const reason = `#${number} was opened by ${issue.author}, who is not in allowedAuthors.`;
          logger.error(reason);
          await finish(runtime, { status: 'ignored', reason }, context);
          return;
        }
        if (issue.state !== 'OPEN') {
          await finish(runtime, { status: 'ignored', reason: `#${number} is closed.` }, context);
          return;
        }
        logger.step(number, `Preparing workspace for "${issue.title}"`);
        await github.setStatus(number, 'working');
        const workspace = await workspaces.prepare(number);
        logger.step(number, `Workspace ready: ${workspace}`);

        await runtime.commit(async (tx) => {
          const conversations = {} as Conversations;
          for (const role of ['triage', 'implement', 'review'] as const) {
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
          return { status: 'running', checkpoint: { phase: 'triage', issue, workspace, conversations } };
        }, context);
      }),

      triage: guarded<'triage'>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue } = state;
        logger.step(issue.number, `Triage (${config.models.triage.modelId})`);
        const triage = await askForReport(
          runtime,
          {
            conversation: state.conversations.triage,
            requestId: 'triage',
            prompt: triagePrompt(issue),
            baseline: 0,
            type: 'triage',
            tool: 'report_triage',
          },
          context,
        );
        if (triage === undefined) throw new StepFailure('The triage agent did not give a decision.');
        logger.step(issue.number, `Triage: ${triage.decision} (${triage.kind}): ${triage.summary}`);

        if (triage.decision === 'needs_info') {
          await github.upsertComment(issue.number, MARKERS.triage, needsInfoComment(triage));
          await github.setStatus(issue.number, 'needsInfo');
          await finish(runtime, { status: 'needs_info' }, context);
          return;
        }
        if (triage.decision === 'reject') {
          await github.upsertComment(issue.number, MARKERS.triage, rejectedComment(triage));
          await github.setStatus(issue.number, 'failed');
          await finish(runtime, { status: 'rejected' }, context);
          return;
        }
        await github.upsertComment(issue.number, MARKERS.triage, planComment(triage));
        const start: Work = { ...state, triage, runs: 0, checkFixes: 0, reviewRounds: 0, done: null };
        await toImplement(runtime, start, implementPrompt(issue, triage), context);
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
            prompt: reviewPrompt(state.issue, state.triage, state.done ?? undefined, diff),
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
          triage: state.triage,
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
        await github.upsertComment(issue.number, MARKERS.result, doneComment(pr.url));
        await github.setStatus(issue.number, 'done');
        logger.step(issue.number, `Draft pull request: ${pr.url}`);
        await finish(runtime, { status: 'pr_opened', url: pr.url }, context);
      }),

      fail: async (task, runtime, context) => {
        const { issue, reason } = task.state.checkpoint;
        await github.upsertComment(issue, MARKERS.result, failedComment(reason));
        await github.setStatus(issue, 'failed');
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

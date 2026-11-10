import type { Context } from '@earendil-works/chord/context';
import { defineExtension, defineTask, type Extension, type RunningTask, type TaskRuntime } from '@earendil-works/pi-durable';
import { eligibility, type ParentIssue, parentRef } from './spec.ts';
import { mkdir } from 'node:fs/promises';
import { modelFor } from './config.ts';
import { commentMarker, type Issue, mergeLabels, progressChange } from './github.ts';
import { failedComment, needsHumanComment, needsInfoComment, planComment } from './messages.ts';
import { implementPrompt, planPrompt } from './prompts.ts';
import {
  askForReport,
  failureGuard,
  type OnPhase,
  perRepo,
  phasesWith,
  type Services,
  StepFailure,
} from './task-kit.ts';
import { scratchFor } from './workspace.ts';
import {
  type BuildStepsState,
  buildSteps,
  createConversations,
  type FailState,
  RESULT_MARKER,
  type Setup,
  type Work,
} from './build-steps.ts';

/** Every task gets these per repo; defined in src/task-kit.ts. */
export type { Services };

export type PipelineInput = { repo: string; issue: number };

export type PipelineState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'plan' })
  /** After planning: the build's finishing steps, src/build-steps.ts. */
  | BuildStepsState
  | FailState;

export type PipelineResult =
  | { status: 'pr_opened'; url: string }
  | { status: 'needs_info' }
  | { status: 'needs_human' }
  | { status: 'ignored'; reason: string };

type Runtime = TaskRuntime<PipelineInput, PipelineState, PipelineResult, object>;
type Phase<P extends PipelineState['phase']> = RunningTask<PipelineInput, Extract<PipelineState, { phase: P }>, PipelineResult>;

const MARKERS = { plan: commentMarker('plan'), result: RESULT_MARKER };

/** A parent issue is background; long specs (PRDs) are cut so they do not crowd out the issue itself. */
const PARENT_MAX_CHARS = 20_000;

/**
 * The pipeline, for every repo: each run uses the services for its own repo (`task.input.repo`), so one process works
 * on any number of repos. `servicesFor` is called once per repo; a failure is retried on the next phase.
 * `onPhase` is told as each phase starts.
 */
export function createPipeline(servicesFor: (repo: string) => Promise<Services>, onPhase?: OnPhase<PipelineInput>) {
  const phase = phasesWith<PipelineInput, ReturnType<typeof repoPhases>>(
    perRepo(async (repo) => repoPhases(await servicesFor(repo))),
    onPhase,
  );
  const Pipeline = defineTask<PipelineInput, PipelineState, PipelineResult>({
    name: 'phat.pipeline',
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: phase('prepare'),
      plan: phase('plan'),
      implement: phase('implement'),
      check: phase('check'),
      review: phase('review'),
      verify: phase('verify'),
      describe: phase('describe'),
      update: phase('update'),
      publish: phase('publish'),
      fail: phase('fail'),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const extension: Extension = defineExtension({ name: 'phat.pipeline', tasks: [Pipeline] });
  return { Pipeline, extension };
}

/** Every phase of a run, for one repo. */
function repoPhases(services: Services) {
  const { config, github, workspaces, logger } = services;
  const { labels } = config;
  const steps = buildSteps(services, { published: (pr): PipelineResult => ({ status: 'pr_opened', url: pr.url }) });

  const finish = (runtime: Runtime, result: PipelineResult, context: Context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);

  /** Run one phase; turn a StepFailure into the `fail` phase, which reports it on the issue. */
  const guarded = failureGuard<Runtime>(logger, (runtime, issue, reason, context) =>
    runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'fail', issue, reason } }), context),
  );

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
          const conversations = await createConversations(tx, { taskId: runtime.taskId, config, issue: number, workspace });
          return { status: 'running', checkpoint: { phase: 'plan', issue, spec, workspace, conversations } };
        }, context);
      }),

      plan: guarded<Phase<'plan'>>(async (task, runtime, context) => {
        const state = task.state.checkpoint;
        const { issue, spec } = state;
        logger.step(issue.number, `Plan (${modelFor(config, 'plan').modelId})`);
        // A run saved before the spec's time was recorded cannot tell what changed since: undefined.
        const changes = spec.writtenAt === undefined ? undefined : await workspaces.docChanges(state.workspace, spec.writtenAt);
        if (changes !== undefined && changes.length > 0) {
          logger.step(issue.number, `${changes.length} ADR or glossary change(s) since the spec was written`);
        }
        const plan = await askForReport(
          runtime,
          {
            conversation: state.conversations.plan,
            requestId: 'plan',
            prompt: planPrompt(issue, spec, scratchFor(state.workspace), changes),
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
        await steps.start(
          runtime,
          { ...start, phase: 'implement', prompt: implementPrompt(issue, spec, plan, scratchFor(state.workspace)) },
          context,
        );
      }),

      ...steps.phases,

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

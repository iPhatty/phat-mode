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
import { modelRole, ROLE_TOOLS, RoleDoc, SHAPE_AGENTS, type ShapeAgent } from './agents.ts';
import { modelFor } from './config.ts';
import { commentMarker, type Issue, mergeLabels, progressChange } from './github.ts';
import {
  shapeFailedComment,
  shapeFoundComment,
  shapeNeedsHumanComment,
  shapeNeedsInfoComment,
  shapeRefusedComment,
} from './messages.ts';
import type { PipelineInput, Services } from './pipeline.ts';
import { roleInstructions, triagePrompt } from './prompts.ts';
import { pinnedSkill } from './skills.ts';
import { shapingEligibility, trustedComments } from './spec.ts';
import { InstallError } from './workspace.ts';
import { askForReport, failureGuard, perRepo, StepFailure } from './task-kit.ts';

/**
 * Shaping: turning a vague `agent-mode` issue into a spec and tickets, with no human answering questions. Its own
 * durable task, next to the build pipeline: prepare (eligibility, a read-only checkout), triage (the answerer runs the
 * pinned `triage` skill's checks), and fail. Only this code touches GitHub; the agents only read and report.
 */

export type ShapingInput = PipelineInput;

type Conversations = Record<ShapeAgent, ConversationId>;

/** `issue`: the issue as the agents may see it, with only trusted authors' comments. */
type Setup = { issue: Issue; workspace: string; conversations: Conversations };

export type ShapingState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'triage' })
  | { phase: 'fail'; issue: number; reason: string };

export type ShapingResult =
  | { status: 'ignored'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'needs_info' }
  | { status: 'needs_human' }
  | { status: 'already_implemented' }
  | { status: 'previously_rejected' }
  /** Triage found nothing in the way. A placeholder until grilling, the spec and the tickets are built. */
  | { status: 'triaged'; summary: string };

/** The name runs of this task are recorded under; `status` tells shaping from building by it. */
export const SHAPING_TASK = 'phat.shape';

type Runtime = TaskRuntime<ShapingInput, ShapingState, ShapingResult, object>;
type Phase<P extends ShapingState['phase']> = RunningTask<ShapingInput, Extract<ShapingState, { phase: P }>, ShapingResult>;

const MARKERS = { result: commentMarker('shape'), refused: commentMarker('shape-refused') };

/** Shaping, for every repo: each run uses the services of its own repo, as the build pipeline does. */
export function createShaping(servicesFor: (repo: string) => Promise<Services>) {
  const phasesFor = perRepo(async (repo) => repoPhases(await servicesFor(repo)));
  const Shaping = defineTask<ShapingInput, ShapingState, ShapingResult>({
    name: SHAPING_TASK,
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: async (task, runtime, context) => (await phasesFor(task.input.repo)).prepare(task, runtime, context),
      triage: async (task, runtime, context) => (await phasesFor(task.input.repo)).triage(task, runtime, context),
      fail: async (task, runtime, context) => (await phasesFor(task.input.repo)).fail(task, runtime, context),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const extension: Extension = defineExtension({ name: SHAPING_TASK, tasks: [Shaping] });
  return { Shaping, extension };
}

/** Every phase of shaping, for one repo. */
function repoPhases(services: Services) {
  const { config, github, workspaces, logger } = services;
  const { labels } = config;

  const go = (runtime: Runtime, next: ShapingState, context: Context) =>
    runtime.commit(() => ({ status: 'running', checkpoint: next }), context);

  const finish = (runtime: Runtime, result: ShapingResult, context: Context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), context);

  /** Run one phase; turn a StepFailure into the `fail` phase, which reports it on the issue. */
  const guarded = failureGuard<Runtime>(logger, (runtime, issue, reason, context) =>
    go(runtime, { phase: 'fail', issue, reason }, context),
  );

  /** A way out: the outcome's triage label and comment; agent-mode goes, and never wontfix. */
  const handBack = async (issue: number, add: string, comment: string) => {
    await github.upsertComment(issue, MARKERS.result, comment);
    await github.editLabels(issue, mergeLabels(progressChange(null), { add: [add], remove: [labels.agentMode] }));
  };

  return {
    prepare: guarded<Phase<'prepare'>>(async (task, runtime, context) => {
      const number = task.input.issue;
      const fetched = await github.getIssue(number);
      const eligible = shapingEligibility(fetched, config);
      if (!eligible.ok) {
        logger.error(eligible.reason);
        if (eligible.kind === 'refused') {
          await github.upsertComment(number, MARKERS.refused, shapeRefusedComment(number, eligible.reason, labels));
        }
        await finish(runtime, { status: eligible.kind, reason: eligible.reason }, context);
        return;
      }
      // Anyone else's comments never reach the agents.
      const issue: Issue = { ...fetched, comments: trustedComments(fetched, config.allowedAuthors) };
      logger.step(number, `Shaping "${issue.title}": preparing a read-only checkout of ${config.baseBranch}`);
      // A failing install is the repo's problem: hand it back. Git or network trouble propagates, to be tried again.
      const workspace = await workspaces.prepareShaping(number).catch((error: unknown) => {
        if (error instanceof InstallError) throw new StepFailure(`Could not prepare the workspace: ${error.message}`);
        throw error;
      });
      logger.step(number, `Workspace ready: ${workspace}`);

      await runtime.commit(async (tx) => {
        const conversations = {} as Conversations;
        for (const role of SHAPE_AGENTS) {
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
        return { status: 'running', checkpoint: { phase: 'triage', issue, workspace, conversations } };
      }, context);
    }),

    triage: guarded<Phase<'triage'>>(async (task, runtime, context) => {
      const { issue, conversations } = task.state.checkpoint;
      logger.step(issue.number, `Triage checks (${modelFor(config, 'shape').modelId})`);
      const skill = await pinnedSkill('triage', ['OUT-OF-SCOPE.md']);
      const report = await askForReport(
        runtime,
        {
          conversation: conversations.answer,
          requestId: 'triage',
          prompt: triagePrompt(issue, issue.comments, skill),
          baseline: 0,
          type: 'triage',
          tool: 'report_triage',
        },
        context,
      );
      if (report === undefined) throw new StepFailure('The answering agent did not report the triage checks.');
      logger.step(issue.number, `Triage: ${report.decision}: ${report.summary}`);
      switch (report.decision) {
        case 'needs_info':
          await handBack(issue.number, labels.needsInfo, shapeNeedsInfoComment(issue, report, labels));
          await finish(runtime, { status: 'needs_info' }, context);
          return;
        case 'needs_human':
          await handBack(issue.number, labels.readyForHuman, shapeNeedsHumanComment(issue.number, report, labels));
          await finish(runtime, { status: 'needs_human' }, context);
          return;
        case 'already_implemented':
        case 'previously_rejected':
          await handBack(issue.number, labels.readyForHuman, shapeFoundComment(issue.number, report, labels));
          await finish(runtime, { status: report.decision }, context);
          return;
        case 'proceed':
          // A placeholder: grilling, the spec and the tickets come later. Nothing is written, agent-mode stays.
          await finish(runtime, { status: 'triaged', summary: report.summary }, context);
          return;
      }
    }),

    fail: async (task: Phase<'fail'>, runtime: Runtime, context: Context) => {
      const { issue, reason } = task.state.checkpoint;
      await github.upsertComment(issue, MARKERS.result, shapeFailedComment(issue, reason, labels));
      // As a failed build looks: a human should look at it.
      await github.editLabels(
        issue,
        mergeLabels(progressChange('failed'), { add: [labels.readyForHuman], remove: [labels.agentMode] }),
      );
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'failed', error: { message: reason } } }),
        context,
      );
    },
  };
}

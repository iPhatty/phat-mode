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
  type GrillQuestion,
  type GrillRound,
  modelRole,
  ReportsDoc,
  ROLE_TOOLS,
  RoleDoc,
  SHAPE_AGENTS,
  type ShapeAgent,
  type ShapeSpecReport,
  type TicketsReport,
} from './agents.ts';
import { modelFor } from './config.ts';
import { commentMarker, type Issue, mergeLabels, PROGRESS_LABELS, progressChange } from './github.ts';
import {
  breakdownCriteria,
  grillComment,
  LIMIT_NOTE,
  NO_ANSWER_NOTE,
  shapedBody,
  shapedCriteria,
  shapeFailedComment,
  shapeFoundComment,
  shapeNeedsHumanComment,
  shapeNeedsInfoComment,
  shapeRefusedComment,
  shapeTooBigComment,
  ticketBody,
  ticketMarker,
  ticketTitle,
} from './messages.ts';
import type { PipelineInput, Services } from './pipeline.ts';
import {
  answerPrompt,
  grillPrompt,
  roleInstructions,
  shapeSpecPrompt,
  ticketsPrompt,
  triagePrompt,
} from './prompts.ts';
import { pinnedSkill } from './skills.ts';
import { shapingEligibility, trustedComments } from './spec.ts';
import { InstallError } from './workspace.ts';
import { askForReport, failureGuard, perRepo, StepFailure } from './task-kit.ts';

/**
 * Shaping: turning a vague `agent-mode` issue into a spec and tickets, with no human answering questions. Its own
 * durable task, next to the build pipeline: prepare (eligibility, a read-only checkout), triage (the answerer runs the
 * pinned `triage` skill's checks), grill (the questioner and the answerer, in rounds), spec and tickets (the answerer
 * synthesises), publish, and fail. Only this code touches GitHub; the agents only read and report.
 */

export type ShapingInput = PipelineInput;

type Conversations = Record<ShapeAgent, ConversationId>;

/** `issue`: the issue as the agents may see it, with only trusted authors' comments. */
type Setup = { issue: Issue; workspace: string; conversations: Conversations };

/** `rounds`: the grilling so far. `baseline`: how many reports the agent asked next had made before, so only new ones count. */
type Grilled = Setup & { rounds: GrillRound[] };

export type ShapingState =
  | { phase: 'prepare' }
  | (Setup & { phase: 'triage' })
  | (Grilled & { phase: 'grill'; round: number; step: 'ask'; baseline: number })
  | (Grilled & { phase: 'grill'; round: number; step: 'answer'; questions: GrillQuestion[]; baseline: number })
  | (Grilled & { phase: 'spec'; baseline: number })
  | (Grilled & { phase: 'tickets'; spec: ShapeSpecReport; baseline: number })
  /** `shapedAt`: when shaping finished, fixed so a rerun writes the same body. */
  | (Grilled & { phase: 'publish'; spec: ShapeSpecReport; tickets: TicketsReport['tickets']; shapedAt: string })
  | { phase: 'fail'; issue: number; reason: string };

export type ShapingResult =
  | { status: 'ignored'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'needs_info' }
  | { status: 'needs_human' }
  | { status: 'already_implemented' }
  | { status: 'previously_rejected' }
  /**
   * One ticket: the issue's body is the spec, and it is ready-for-agent. Several: the issue's body is the spec, and
   * `numbers` are its tickets (sub-issues, each ready-for-agent), in dependency order.
   */
  | { status: 'shaped'; tickets: number; numbers?: number[] }
  /** More tickets than `maxTickets`: handed to a human with the draft breakdown, and no tickets opened. */
  | { status: 'too_big'; tickets: number };

/** The name runs of this task are recorded under; `status` tells shaping from building by it. */
export const SHAPING_TASK = 'phat.shape';

type Runtime = TaskRuntime<ShapingInput, ShapingState, ShapingResult, object>;
type Phase<P extends ShapingState['phase']> = RunningTask<ShapingInput, Extract<ShapingState, { phase: P }>, ShapingResult>;

const MARKERS = {
  result: commentMarker('shape'),
  refused: commentMarker('shape-refused'),
  qa: commentMarker('shape-qa'),
};

/**
 * Every decision taken with no answer from the answerer (at the round limit, or left unanswered) is an assumption,
 * whatever the answerer wrote in the spec.
 */
export function withRoundAssumptions(spec: ShapeSpecReport, rounds: readonly GrillRound[]): ShapeSpecReport {
  const decided = rounds.flatMap((round, index) =>
    round.questions.flatMap((question, number) => {
      const answer = round.answers[number];
      if (answer === undefined || !(round.atLimit || answer.recommended)) return [];
      return [
        {
          decision: `${question.title}: ${answer.answer}`,
          why: `Round ${index + 1}, Q${number + 1}: ${round.atLimit ? LIMIT_NOTE : NO_ANSWER_NOTE}.`,
          door: answer.door,
        },
      ];
    }),
  );
  return { ...spec, assumptions: [...spec.assumptions, ...decided] };
}

/**
 * The order to publish tickets in: every ticket after the ones that block it, otherwise as listed. A reason instead
 * when `blockedBy` is not usable: an index out of range, a ticket blocking itself, or a cycle.
 */
export function dependencyOrder(tickets: TicketsReport['tickets']): number[] | { invalid: string } {
  for (const [index, ticket] of tickets.entries()) {
    for (const blocker of ticket.blockedBy) {
      if (!Number.isInteger(blocker) || blocker < 0 || blocker >= tickets.length) {
        return { invalid: `Ticket ${index + 1} ("${ticket.title}") is blocked by ticket index ${blocker}, which is not in the breakdown.` };
      }
      if (blocker === index) return { invalid: `Ticket ${index + 1} ("${ticket.title}") is blocked by itself.` };
    }
  }
  const order: number[] = [];
  while (order.length < tickets.length) {
    const next = tickets.findIndex(
      (ticket, index) => !order.includes(index) && ticket.blockedBy.every((blocker) => order.includes(blocker)),
    );
    if (next === -1) {
      const stuck = tickets.flatMap((ticket, index) => (order.includes(index) ? [] : [`${index + 1} ("${ticket.title}")`]));
      return { invalid: `The tickets' blocking edges form a cycle, among tickets ${stuck.join(', ')}.` };
    }
    order.push(next);
  }
  return order;
}

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
      grill: async (task, runtime, context) => (await phasesFor(task.input.repo)).grill(task, runtime, context),
      spec: async (task, runtime, context) => (await phasesFor(task.input.repo)).spec(task, runtime, context),
      tickets: async (task, runtime, context) => (await phasesFor(task.input.repo)).tickets(task, runtime, context),
      publish: async (task, runtime, context) => (await phasesFor(task.input.repo)).publish(task, runtime, context),
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

  /** Number of reports a conversation has, read inside a transition so the baseline is stored with it. */
  const goWithBaseline = (
    runtime: Runtime,
    conversation: ConversationId,
    next: (baseline: number) => ShapingState,
    context: Context,
  ) =>
    runtime.commit(
      async (tx) => ({ status: 'running', checkpoint: next((await tx.doc(ReportsDoc, conversation)).items.length) }),
      context,
    );

  const setupOf = ({ issue, workspace, conversations }: Setup): Setup => ({ issue, workspace, conversations });

  /** Grilling is done: the answerer writes the spec next. */
  const toSpec = (runtime: Runtime, setup: Setup, rounds: GrillRound[], context: Context) =>
    goWithBaseline(runtime, setup.conversations.answer, (baseline) => ({ ...setupOf(setup), phase: 'spec', rounds, baseline }), context);

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
          await goWithBaseline(
            runtime,
            conversations.question,
            (baseline) => ({ ...setupOf(task.state.checkpoint), phase: 'grill', round: 1, step: 'ask', rounds: [], baseline }),
            context,
          );
          return;
      }
    }),

    /**
     * The questioner asks a round (the whole frontier), the answerer answers it, until the frontier is empty or
     * `maxGrillRounds` rounds were asked. The last round allowed is decided with the questioner's recommendations.
     */
    grill: guarded<Phase<'grill'>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const { issue, conversations, rounds, round } = state;
      const maxRounds = config.limits.maxGrillRounds;
      if (state.step === 'ask') {
        logger.step(issue.number, `Grilling, round ${round} of at most ${maxRounds} (${modelFor(config, 'grill').modelId})`);
        const report = await askForReport(
          runtime,
          {
            conversation: conversations.question,
            requestId: `grill-${round}`,
            prompt: grillPrompt({
              issue,
              comments: issue.comments,
              skill: await pinnedSkill('grilling'),
              round,
              maxRounds,
              previous: rounds.at(-1),
            }),
            baseline: state.baseline,
            type: 'questions',
            tool: 'report_questions',
          },
          context,
        );
        if (report === undefined) throw new StepFailure(`The questioner did not report round ${round} of grilling.`);
        if (report.frontierEmpty || report.questions.length === 0) {
          logger.step(issue.number, 'Grilling: the frontier is empty');
          await toSpec(runtime, state, rounds, context);
          return;
        }
        await goWithBaseline(
          runtime,
          conversations.answer,
          (baseline) => ({ ...setupOf(state), phase: 'grill', round, step: 'answer', questions: report.questions, rounds, baseline }),
          context,
        );
        return;
      }

      const atLimit = round >= maxRounds;
      logger.step(issue.number, `Answering round ${round}${atLimit ? ', the last one allowed' : ''} (${modelFor(config, 'shape').modelId})`);
      const report = await askForReport(
        runtime,
        {
          conversation: conversations.answer,
          requestId: `answer-${round}`,
          prompt: answerPrompt(round, state.questions, atLimit),
          baseline: state.baseline,
          type: 'answers',
          tool: 'report_answers',
        },
        context,
      );
      if (report === undefined) throw new StepFailure(`The answering agent did not answer round ${round} of grilling.`);
      const answers = state.questions.map((question, index) => {
        const answer = report.answers.find((candidate) => candidate.question === index + 1);
        return answer !== undefined && answer.answer.trim() !== ''
          ? { answer: answer.answer, door: answer.door, recommended: false }
          : { answer: question.recommendation, door: question.door, recommended: true };
      });
      const grilled = [...rounds, { questions: state.questions, answers, atLimit }];
      // Before moving on, so a crash here only repeats this (harmless) update.
      await github.upsertComment(issue.number, MARKERS.qa, grillComment(issue.number, grilled));
      if (atLimit) {
        await toSpec(runtime, state, grilled, context);
        return;
      }
      await goWithBaseline(
        runtime,
        conversations.question,
        (baseline) => ({ ...setupOf(state), phase: 'grill', round: round + 1, step: 'ask', rounds: grilled, baseline }),
        context,
      );
    }),

    spec: guarded<Phase<'spec'>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const { issue, conversations, rounds } = state;
      logger.step(issue.number, 'Writing the spec');
      const [toSpecSkill, domainModeling] = await Promise.all([
        pinnedSkill('to-spec'),
        pinnedSkill('domain-modeling', ['GLOSSARY-FORMAT.md', 'ADR-FORMAT.md']),
      ]);
      const report = await askForReport(
        runtime,
        {
          conversation: conversations.answer,
          requestId: 'spec',
          prompt: shapeSpecPrompt(toSpecSkill, domainModeling),
          baseline: state.baseline,
          type: 'shape_spec',
          tool: 'report_shape_spec',
        },
        context,
      );
      if (report === undefined) throw new StepFailure('The answering agent did not report the spec.');
      const spec = withRoundAssumptions(report, rounds);
      await goWithBaseline(
        runtime,
        conversations.answer,
        (baseline) => ({ ...setupOf(state), phase: 'tickets', rounds, spec, baseline }),
        context,
      );
    }),

    tickets: guarded<Phase<'tickets'>>(async (task, runtime, context) => {
      const state = task.state.checkpoint;
      const { issue, conversations } = state;
      logger.step(issue.number, 'Breaking the spec into tickets');
      const report = await askForReport(
        runtime,
        {
          conversation: conversations.answer,
          requestId: 'tickets',
          prompt: ticketsPrompt(await pinnedSkill('to-tickets')),
          baseline: state.baseline,
          type: 'tickets',
          tool: 'report_tickets',
        },
        context,
      );
      if (report === undefined) throw new StepFailure('The answering agent did not report the ticket breakdown.');
      if (report.tickets.length === 0) throw new StepFailure('The answering agent broke the spec into no tickets at all.');
      const order = dependencyOrder(report.tickets);
      if ('invalid' in order) throw new StepFailure(`The answering agent's ticket breakdown is not usable: ${order.invalid}`);
      logger.step(issue.number, `Tickets: ${report.tickets.length}`);
      const max = config.limits.maxTickets;
      if (report.tickets.length > max) {
        logger.step(issue.number, `More than ${max} tickets: handing it to a human with the draft breakdown`);
        await github.upsertComment(issue.number, MARKERS.qa, grillComment(issue.number, state.rounds));
        await handBack(issue.number, labels.readyForHuman, shapeTooBigComment(issue.number, report.tickets, max, labels));
        await finish(runtime, { status: 'too_big', tickets: report.tickets.length }, context);
        return;
      }
      await go(runtime, { ...setupOf(state), phase: 'publish', rounds: state.rounds, spec: state.spec, tickets: report.tickets, shapedAt: new Date().toISOString() }, context);
    }),

    publish: guarded<Phase<'publish'>>(async (task, runtime, context) => {
      const { issue, rounds, spec, tickets, shapedAt } = task.state.checkpoint;
      const [ticket] = tickets;
      if (ticket === undefined) throw new StepFailure('The answering agent broke the spec into no tickets at all.');
      if (tickets.length === 1) {
        // The body as it was when shaping began (never refetched), so a rerun after a crash still keeps the original.
        await github.editIssueBody(issue.number, shapedBody(issue.number, spec, shapedCriteria(spec, ticket), issue.body, shapedAt));
        await github.upsertComment(issue.number, MARKERS.qa, grillComment(issue.number, rounds));
        // Labels last: ready-for-agent lets a build start.
        await github.editLabels(
          issue.number,
          mergeLabels(progressChange(null), {
            add: [labels.readyForAgent, PROGRESS_LABELS.shaped.name],
            remove: [labels.agentMode],
          }),
        );
        logger.step(issue.number, `Shaped into one ticket: now ${labels.readyForAgent}`);
        await finish(runtime, { status: 'shaped', tickets: 1 }, context);
        return;
      }

      // Several tickets. Every step can be repeated after a crash: tickets are found again by their marker.
      const order = dependencyOrder(tickets);
      if ('invalid' in order) throw new StepFailure(`The ticket breakdown is not usable: ${order.invalid}`);
      const criteria = breakdownCriteria(spec, tickets, order);
      await github.editIssueBody(issue.number, shapedBody(issue.number, spec, undefined, issue.body, shapedAt));
      const issueNumberByTicketIndex = new Map<number, number>();
      const numberOf = (index: number) => {
        const number = issueNumberByTicketIndex.get(index);
        if (number === undefined) throw new Error(`Ticket ${index + 1} is not published yet`);
        return number;
      };
      for (const index of order) {
        const current = tickets[index]!;
        // Blockers come first in dependency order, so they are published already.
        const blockers = current.blockedBy.map(numberOf);
        const found = await github.findIssueByMarker(ticketMarker(issue.number, index));
        const number =
          (found !== issue.number ? found : undefined) ??
          (await github.createIssue({
            title: ticketTitle(issue.number, index, current),
            body: ticketBody(issue.number, index, current, criteria[index]!, blockers),
          }));
        logger.step(issue.number, `Ticket ${index + 1}: #${number}`);
        issueNumberByTicketIndex.set(index, number);
      }
      /** The tickets' issue numbers, in dependency order. */
      const numbers = order.map(numberOf);
      for (const number of numbers) await github.addSubIssue(issue.number, number);
      for (const index of order) {
        for (const blocker of tickets[index]!.blockedBy) await github.addBlockedBy(numberOf(index), numberOf(blocker));
      }
      await github.upsertComment(issue.number, MARKERS.qa, grillComment(issue.number, rounds));
      for (const number of numbers) await github.editLabels(number, { add: [labels.readyForAgent] });
      // The Parent last: it is never built itself, so never ready-for-agent, and it has no triage state label.
      await github.editLabels(
        issue.number,
        mergeLabels(progressChange(null), {
          add: [PROGRESS_LABELS.shaped.name],
          remove: [labels.agentMode, labels.readyForAgent, labels.needsTriage, labels.needsInfo, labels.readyForHuman],
        }),
      );
      logger.step(issue.number, `Shaped into ${numbers.length} tickets: ${numbers.map((n) => `#${n}`).join(', ')}`);
      await finish(runtime, { status: 'shaped', tickets: numbers.length, numbers }, context);
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

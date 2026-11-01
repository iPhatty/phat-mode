import type { Context } from '@earendil-works/chord/context';
import type { ConversationId, TaskRuntime } from '@earendil-works/pi-durable';
import { type Report, type ReportData, ReportsDoc } from './agents.ts';
import type { Logger } from './log.ts';
import { NUDGE } from './prompts.ts';

/**
 * What every durable task of phat-mode shares: the build pipeline (src/pipeline.ts) and shaping (src/shaping.ts).
 */

/** A failure a task reports on the issue, instead of a crash. */
export class StepFailure extends Error {}

/** What asking an agent needs from a task's runtime; the same for every kind of task. */
type AgentRuntime = Pick<TaskRuntime<unknown, unknown, unknown, object>, 'conversation' | 'snapshot'>;

/** Send one request to an agent and wait for its answer. Same request id after a restart: same request. */
export async function ask(
  runtime: AgentRuntime,
  conversation: ConversationId,
  requestId: string,
  content: string,
  context: Context,
) {
  const handle = await runtime.conversation(conversation, context);
  if (handle === undefined) throw new Error(`Conversation ${conversation} is missing`);
  const settled = await (await handle.submit({ type: 'input', content, requestId }, context)).wait(context);
  if (settled.status !== 'done') {
    throw new StepFailure(`An agent stopped without answering (${settled.reason}).`);
  }
}

/** The newest report of `type` an agent made after `baseline` reports. */
export async function latestReport<T extends Report['type']>(
  runtime: AgentRuntime,
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
export async function askForReport<T extends Report['type']>(
  runtime: AgentRuntime,
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

/**
 * Something loaded once per repo, such as a task's phases with that repo's services. A failure (offline, say) is not
 * remembered: the next call tries again.
 */
export function perRepo<T>(load: (repo: string) => Promise<T>): (repo: string) => Promise<T> {
  const loaded = new Map<string, Promise<T>>();
  return (repo) => {
    let value = loaded.get(repo);
    if (value === undefined) {
      value = load(repo);
      loaded.set(repo, value);
      value.catch(() => loaded.delete(repo));
    }
    return value;
  };
}

/**
 * Wrap a task's phases so that a StepFailure goes to the task's `fail` phase, which reports it on the issue. Anything
 * else (a cancelled run, a passing problem such as being offline) propagates, as before. `toFail`: the task's own
 * transition to its fail phase.
 */
export function failureGuard<Runtime extends { signal: AbortSignal }>(
  logger: Pick<Logger, 'error'>,
  toFail: (runtime: Runtime, issue: number, reason: string, context: Context) => Promise<void>,
) {
  return <Task extends { input: { repo: string; issue: number } }>(
      body: (task: Task, runtime: Runtime, context: Context) => Promise<void>,
    ) =>
    async (task: Task, runtime: Runtime, context: Context) => {
      try {
        await body(task, runtime, context);
      } catch (error) {
        if (!(error instanceof StepFailure) || runtime.signal.aborted) throw error;
        logger.error(`${task.input.repo}#${task.input.issue}: ${error.message}`);
        await toFail(runtime, task.input.issue, error.message, context);
      }
    };
}

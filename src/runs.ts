import { PROGRESS_LABELS } from './github.ts';
import type { RunKind } from './harness.ts';
import type { PipelineResult } from './pipeline.ts';
import { REPAIR_TASK, type RepairResult } from './repair.ts';
import { SHAPING_TASK, type ShapingResult } from './shaping.ts';

/**
 * How the CLI describes runs, of any kind: building an issue into a pull request (`phat.pipeline`), shaping an
 * `agent-mode` issue (`phat.shape`), or repairing an issue's stuck pull request (`phat.repair`). `taskKind`: the task
 * definition's name, from the task record.
 */

export const isShaping = (taskKind: string | undefined) => taskKind === SHAPING_TASK;

/** How each kind of run is named: "building", "shaping" or "repairing". */
const RUN_VERBS: Record<RunKind, string> = { build: 'building', shape: 'shaping', repair: 'repairing' };

/** The kind of run a task definition's name is; any other task is a build (`phat.pipeline`). */
export const kindOfTask = (taskKind: string | undefined): RunKind =>
  taskKind === SHAPING_TASK ? 'shape' : taskKind === REPAIR_TASK ? 'repair' : 'build';

/** "building", "shaping" or "repairing", for a run's kind. */
export const verbFor = (kind: RunKind) => RUN_VERBS[kind];

/** The verb for a task definition's name. */
export const runVerb = (taskKind: string | undefined) => verbFor(kindOfTask(taskKind));

/** One line on how a finished run ended. */
export function describeResult(result: PipelineResult | ShapingResult | RepairResult, taskKind?: string): string {
  if (result.status === 'ignored') return `⏭️  Ignored: ${result.reason}`;
  if (taskKind === REPAIR_TASK) {
    const repair = result as RepairResult;
    switch (repair.status) {
      case 'repaired':
        return `🔧 Repaired: ${repair.url}`;
      case 'stuck':
        return `🛑 Gave up on ${repair.url}: ${repair.reason.replace(/\.$/, '')}. It is labelled ${PROGRESS_LABELS.stuck.name}; remove the label to let phat-mode repair it again.`;
      case 'waiting':
        return `⏳ Waiting: ${repair.url}: ${repair.reason}. No repair spent.`;
    }
  }
  if (isShaping(taskKind)) {
    const shaping = result as ShapingResult;
    switch (shaping.status) {
      case 'refused':
        return `🚫 Not shaped: ${shaping.reason} phat-mode said so on the issue and left its labels alone.`;
      case 'needs_info':
        return '❓ The request is unclear. phat-mode posted triage notes and moved the issue to needs-info.';
      case 'needs_human':
        return '🧑 phat-mode decided a human should take this and moved the issue to ready-for-human.';
      case 'already_implemented':
        return '♻️  Already implemented. phat-mode posted where it found it and moved the issue to ready-for-human.';
      case 'previously_rejected':
        return '🗂️  Rejected before (.out-of-scope/). phat-mode posted what it found and moved the issue to ready-for-human.';
      case 'shaped':
        if (shaping.tickets === 1) return '✅ Shaped into one ticket: the issue\'s body is now the spec, and it is ready-for-agent.';
        return `✅ Shaped into ${shaping.tickets} tickets${
          shaping.numbers && shaping.numbers.length > 0 ? ` (${shaping.numbers.map((n) => `#${n}`).join(', ')})` : ''
        }, each ready-for-agent; the issue is phat-mode:shaped.`;
    }
  }
  const build = result as PipelineResult;
  switch (build.status) {
    case 'pr_opened':
      return `✅ Pull request opened: ${build.url}`;
    case 'needs_info':
      return '❓ The spec has gaps. phat-mode posted triage notes and moved the issue to needs-info.';
    case 'needs_human':
      return '🧑 phat-mode decided a human should do this and moved the issue to ready-for-human.';
  }
  return `${result.status}`;
}

/** What `status` needs of a task record. */
export type RunRecord = {
  kind: string;
  state:
    | { status: 'terminal'; outcome: { status: string; result?: unknown; error?: { message: string } } }
    | { status: string; checkpoint?: unknown };
};

/** `status`'s text for one run: its kind, and where it is, e.g. "shaping: running (triage), …". */
export function runStatus(record: RunRecord | undefined): string {
  if (record === undefined) return 'unknown';
  const verb = runVerb(record.kind);
  const { state } = record;
  if (state.status === 'terminal' && 'outcome' in state) {
    const { outcome } = state;
    if (outcome.status === 'completed') {
      return `${verb}: ${describeResult(outcome.result as PipelineResult | ShapingResult | RepairResult, record.kind)}`;
    }
    return `${verb}: ${outcome.status}${outcome.status === 'failed' && outcome.error ? `: ${outcome.error.message.split('\n')[0]}` : ''}`;
  }
  const phase = 'checkpoint' in state ? (state.checkpoint as { phase?: string } | undefined)?.phase : undefined;
  return `${verb}: ${state.status}${phase ? ` (${phase})` : ''}, run \`phat-mode resume\` to continue`;
}

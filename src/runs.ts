import type { PipelineResult } from './pipeline.ts';
import { SHAPING_TASK, type ShapingResult } from './shaping.ts';

/**
 * How the CLI describes runs, of either kind: building an issue into a pull request (`phat.pipeline`), or shaping an
 * `agent-mode` issue (`phat.shape`). `taskKind`: the task definition's name, from the task record.
 */

export const isShaping = (taskKind: string | undefined) => taskKind === SHAPING_TASK;

/** "shaping" or "building". */
export const runVerb = (taskKind: string | undefined) => (isShaping(taskKind) ? 'shaping' : 'building');

/** One line on how a finished run ended. */
export function describeResult(result: PipelineResult | ShapingResult, taskKind?: string): string {
  if (result.status === 'ignored') return `⏭️  Ignored: ${result.reason}`;
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
    if (outcome.status === 'completed') return `${verb}: ${describeResult(outcome.result as PipelineResult | ShapingResult, record.kind)}`;
    return `${verb}: ${outcome.status}${outcome.status === 'failed' && outcome.error ? `: ${outcome.error.message.split('\n')[0]}` : ''}`;
  }
  const phase = 'checkpoint' in state ? (state.checkpoint as { phase?: string } | undefined)?.phase : undefined;
  return `${verb}: ${state.status}${phase ? ` (${phase})` : ''}, run \`phat-mode resume\` to continue`;
}

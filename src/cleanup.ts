import type { Context } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import type { GitHub } from './github.ts';
import { type PhatMode, type RunResult, RunsDoc } from './harness.ts';
import type { WorkspaceFolder, Workspaces, WorkspaceTarget } from './workspace.ts';

/**
 * When a project's workspaces go (see README, "Workspaces"). An issue's folders are kept while any run for it, build
 * or shaping, is unfinished. Otherwise its build workspace and scratch folder go once the issue is closed; its shaping
 * checkout goes once its shaping run has shaped the issue, or once the issue is closed. A failed or handed-back run's
 * folders stay until then, to be looked at. The "before" checkout (`base`) is never touched.
 */

/** One issue's workspace removed (or, on a dry run, that would be). */
export type Removal = { issue: number; kind: WorkspaceTarget['kind']; paths: string[]; bytes: number };

export type CleanupReport = {
  removed: Removal[];
  /** Folders whose name is not a workspace phat-mode makes: left alone. */
  unknown: string[];
  /** Issues whose folders could not be looked at or removed this time (e.g. GitHub was unreachable): left alone. */
  errors: { issue: number; message: string }[];
};

export type CleanupOptions = {
  /** Say what would be removed, and remove nothing. */
  dryRun?: boolean;
  /** Only this issue's folders (what `run` cleans after its run). */
  issue?: number;
};

/** What the project's run records say about an issue. */
type RunFacts = { unfinished: boolean; shaped: boolean };

async function runFacts(phat: Pick<PhatMode, 'repo' | 'harness' | 'root'>, issue: number, context: Context): Promise<RunFacts> {
  const runs = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs[`${phat.repo}#${issue}`] ?? [];
  let unfinished = false;
  for (const run of runs) {
    const record = await phat.harness.getTask(run.taskId as unknown as TaskId<RunResult>, context);
    if (record !== undefined && record.state.status !== 'terminal') unfinished = true;
  }
  const lastShaping = runs.filter((run) => run.kind === 'shape').at(-1);
  let shaped = false;
  if (lastShaping !== undefined) {
    const record = await phat.harness.getTask(lastShaping.taskId as unknown as TaskId<RunResult>, context);
    const outcome = record?.state.status === 'terminal' ? record.state.outcome : undefined;
    shaped = outcome?.status === 'completed' && outcome.result.status === 'shaped';
  }
  return { unfinished, shaped };
}

/**
 * Remove the workspaces of `phat`'s project that nothing can need any more (see above). Call it holding the project's
 * lock, so no run starts meanwhile. Looks at GitHub only for issues that have folders, and only when it must. An issue
 * that cannot be looked at is left alone and reported; the others go on.
 */
export async function cleanWorkspaces(
  phat: Pick<PhatMode, 'repo' | 'harness' | 'root'>,
  services: { github: Pick<GitHub, 'getIssue'>; workspaces: Workspaces },
  context: Context,
  options: CleanupOptions = {},
): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], unknown: [], errors: [] };
  const byIssue = new Map<number, WorkspaceFolder[]>();
  for (const folder of await services.workspaces.folders()) {
    if (folder.kind === 'base') continue;
    if (folder.kind === 'unknown' || folder.issue === undefined) {
      if (options.issue === undefined) report.unknown.push(folder.name);
      continue;
    }
    if (options.issue !== undefined && folder.issue !== options.issue) continue;
    byIssue.set(folder.issue, [...(byIssue.get(folder.issue) ?? []), folder]);
  }
  for (const [issue, folders] of [...byIssue].sort(([a], [b]) => a - b)) {
    try {
      const facts = await runFacts(phat, issue, context);
      if (facts.unfinished) continue;
      let closed: boolean | undefined;
      const isClosed = async () => (closed ??= (await services.github.getIssue(issue)).state === 'CLOSED');
      const targets: WorkspaceTarget['kind'][] = [];
      if (folders.some((folder) => folder.kind === 'build' || folder.kind === 'scratch') && (await isClosed())) targets.push('build');
      if (folders.some((folder) => folder.kind === 'shape') && (facts.shaped || (await isClosed()))) targets.push('shape');
      for (const kind of targets) {
        const removed = await services.workspaces.remove({ kind, issue }, { dryRun: options.dryRun });
        if (removed.paths.length > 0) report.removed.push({ issue, kind, ...removed });
      }
    } catch (error) {
      report.errors.push({ issue, message: error instanceof Error ? error.message.split('\n')[0]! : String(error) });
    }
  }
  return report;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** `785 MB`, `1.4 GB`; `12 KB` below a megabyte. */
export function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** What was removed, without the issue: `removed workspace (785 MB)`, or `would remove shaping checkout (…)`. */
export function removalText(removal: Removal, dryRun = false): string {
  const what = removal.kind === 'shape' ? 'shaping checkout' : 'workspace';
  return `${dryRun ? 'would remove' : 'removed'} ${what} (${formatSize(removal.bytes)})`;
}

/** `#72: removed workspace (785 MB)`. */
export function describeRemoval(removal: Removal, dryRun = false): string {
  return `#${removal.issue}: ${removalText(removal, dryRun)}`;
}

/** The total size of `removals`. */
export const totalBytes = (removals: readonly Removal[]) => removals.reduce((sum, removal) => sum + removal.bytes, 0);

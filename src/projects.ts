import { randomUUID } from 'node:crypto';
import { access, link, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { paths } from './config.ts';
import { type OpenOptions, openHarness, openPhatMode, type PhatMode, type RunKind, type RunResult, RunsDoc } from './harness.ts';
import { acquireLock, isAlive, LockedError, type LockInfo, readLock } from './lock.ts';
import { type RunRecord, runStatus } from './runs.ts';

/**
 * Each project has its own lock (`<home>/locks/<owner>__<name>.lock`) and durable database
 * (`<home>/state/<owner>__<name>.sqlite`), opened only by the process holding the lock. See ADR 0004.
 */

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Status and the old database never run anything, so they need no services. */
const noServices = async (repo: string): Promise<never> => {
  throw new Error(`No services for ${repo} here: nothing runs`);
};

/** A project's state: held by another process (what its lock file says), or its runs, by `owner/name#issue`. */
export type ProjectStatus = { held: LockInfo } | { runs: { key: string; status: string }[] };

/**
 * What `status` shows for a project. Held by another process: its lock file, and its database is never opened. Free:
 * its runs, read under its lock, taken briefly. A project with no database has no runs, and gets no database.
 */
export async function projectStatus(home: string, repo: string, context: Context, options: OpenOptions = {}): Promise<ProjectStatus> {
  const holder = await readLock(paths.projectLock(home, repo));
  if (holder !== undefined) return { held: holder };
  if (!(await exists(paths.projectState(home, repo)))) return { runs: [] };
  let phat;
  try {
    phat = await openPhatMode({ home, repo, servicesFor: noServices }, context, options);
  } catch (error) {
    // Taken by another process in the meantime.
    if (error instanceof LockedError) return { held: error.holder };
    throw error;
  }
  try {
    const all = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs ?? {};
    const runs: { key: string; status: string }[] = [];
    for (const [key, list] of Object.entries(all)) {
      const record = await phat.harness.getTask(list.at(-1)!.taskId as unknown as TaskId<RunResult>, context);
      runs.push({ key, status: runStatus(record as RunRecord | undefined) });
    }
    return { runs };
  } finally {
    await phat.close(context);
  }
}

/** A run left unfinished in the old shared database. `phase`: where it stopped, when known. */
export type UnfinishedRun = { repo: string; issue: number; kind: RunKind; phase?: string };

export type Retirement = { status: 'none' } | { status: 'archived' } | { status: 'unfinished'; runs: UnfinishedRun[] };

/**
 * Retire the database every project shared before per-project databases (`<home>/state.sqlite`), once. With no
 * unfinished runs it is renamed to `state.sqlite.legacy`; with some, it stays, and they are listed, to finish or abort
 * with the previous phat-mode version. Inspected under its old lock, in their format, so an old phat-mode still using it
 * is refused (LockedError). Nothing in it runs.
 */
export async function retireLegacyState(home: string, context: Context): Promise<Retirement> {
  const database = paths.legacyState(home);
  if (!(await exists(database))) return { status: 'none' };
  const lock = await acquireLock(paths.retireLock(home), 'phat-mode (upgrading)', { what: database });
  try {
    if (!(await exists(database))) return { status: 'none' };
    const old = await claimOldLock(paths.legacyLock(home), database);
    try {
      return await archiveIfFinished(home, database, context);
    } finally {
      await old.release();
    }
  } finally {
    await lock.release();
  }
}

async function archiveIfFinished(home: string, database: string, context: Context): Promise<Retirement> {
  const runs = await unfinishedRuns(home, database, context);
  if (runs.length > 0) return { status: 'unfinished', runs };
  for (const suffix of ['', '-wal', '-shm']) {
    await rename(`${database}${suffix}`, `${database}.legacy${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { status: 'archived' };
}

/**
 * Take the lock earlier versions used for the shared database (a plain file, in their format), so an old phat-mode still
 * using it is refused (LockedError), and one starting meanwhile is refused too. A lock its process left behind is
 * replaced. Only called holding `retireLock`, so no two processes of this version replace it at once.
 */
/** The holder in an old-format lock file; undefined when it is missing, empty or not valid. */
async function readOldHolder(path: string): Promise<LockInfo | undefined> {
  try {
    const holder = JSON.parse(await readFile(path, 'utf8')) as Partial<LockInfo>;
    return typeof holder?.pid === 'number' ? (holder as LockInfo) : undefined;
  } catch {
    return undefined;
  }
}

async function claimOldLock(path: string, database: string): Promise<{ release(): Promise<void> }> {
  const info: LockInfo = { pid: process.pid, token: randomUUID(), command: 'phat-mode (upgrading)', startedAt: Date.now() };
  const temp = `${path}.${process.pid}.${info.token}.tmp`;
  await writeFile(temp, JSON.stringify(info), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(temp, path);
        return {
          async release() {
            if ((await readOldHolder(path))?.token === info.token) await unlink(path).catch(() => {});
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // Earlier versions created the file, then wrote it: give one that is still writing a moment.
      let holder = await readOldHolder(path);
      if (holder === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        holder = await readOldHolder(path);
      }
      if (holder !== undefined && isAlive(holder.pid)) throw new LockedError(path, holder, database);
      // Its process is gone, or it is empty or cut short (a crash while writing it): stale.
      await unlink(path).catch(() => {});
    }
    throw new Error(`Could not take the lock ${path}`);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function unfinishedRuns(home: string, database: string, context: Context): Promise<UnfinishedRun[]> {
  const storage = await openNodeSqliteStorage(database);
  const { harness, root } = await openHarness({ home, servicesFor: noServices, storage }, context);
  try {
    const all = (await harness.snapshot(RunsDoc, root.id, context))?.runs ?? {};
    const runs: UnfinishedRun[] = [];
    for (const [key, list] of Object.entries(all)) {
      const latest = list.at(-1)!;
      const record = await harness.getTask(latest.taskId as unknown as TaskId<RunResult>, context);
      if (record === undefined || record.state.status === 'terminal') continue;
      const hash = key.lastIndexOf('#');
      const state = record.state as { checkpoint?: { phase?: unknown } };
      const phase = typeof state.checkpoint?.phase === 'string' ? state.checkpoint.phase : undefined;
      runs.push({
        repo: key.slice(0, hash),
        issue: Number(key.slice(hash + 1)),
        kind: latest.kind ?? 'build',
        ...(phase === undefined ? {} : { phase }),
      });
    }
    return runs;
  } finally {
    await harness.close(context);
  }
}

/** What to tell the user about runs left in the old shared database, and how to finish them. */
export function describeUnfinished(runs: readonly UnfinishedRun[], home: string): string {
  const lines = runs.map(
    (run) => `  - ${run.repo}#${run.issue}: ${run.kind === 'shape' ? 'shaping' : 'building'}${run.phase ? ` (${run.phase})` : ''}`,
  );
  return [
    `${paths.legacyState(home)}, the database of earlier phat-mode versions, has unfinished runs:`,
    ...lines,
    'This version keeps a database per project instead. Finish or abort these runs with the previous phat-mode version',
    'first (`phat-mode resume`, or `phat-mode abort <issue>`, from a checkout of it), then start this one again: it archives',
    `the old database to ${paths.legacyState(home)}.legacy once no run in it is unfinished.`,
  ].join('\n');
}

/** Runs of a project that have not finished (interrupted, or still going), by `owner/name#issue`. */
export async function liveRuns(phat: PhatMode, context: Context): Promise<{ key: string; taskId: TaskId<RunResult> }[]> {
  const runs = (await phat.harness.snapshot(RunsDoc, phat.root.id, context))?.runs ?? {};
  const live: { key: string; taskId: TaskId<RunResult> }[] = [];
  for (const [key, list] of Object.entries(runs)) {
    const taskId = list.at(-1)!.taskId as unknown as TaskId<RunResult>;
    const record = await phat.harness.getTask(taskId, context);
    if (record !== undefined && record.state.status !== 'terminal') live.push({ key, taskId });
  }
  return live;
}

const resumed = new WeakSet<PhatMode>();

/**
 * Let a project's runs go ahead (`harness.resume()`), once. Until then they stay where they are: resuming a project
 * runs every run it has pending, so a watch resumes a project only when the project gets a run slot (src/scheduler.ts).
 */
export function resumeOnce(phat: PhatMode): void {
  if (resumed.has(phat)) return;
  resumed.add(phat);
  phat.harness.resume();
}

/**
 * A watch's look at a project's interrupted runs. None: undefined, and the project is left as it is. Otherwise the
 * project is resumed, which lets every one of them go ahead (one at a time, see takeSlot in harness.ts), and the result
 * waits until all of them have settled, calling `each` for every one: the project keeps its one slot until then, so a
 * watch never has more runs going than it counts.
 */
export async function resumeInterrupted(
  phat: PhatMode,
  context: Context,
  each: (key: string, taskId: TaskId<RunResult>) => Promise<void>,
): Promise<(() => Promise<void>) | undefined> {
  const live = await liveRuns(phat, context);
  if (live.length === 0) return undefined;
  resumeOnce(phat);
  return async () => {
    const results = await Promise.allSettled(live.map(({ key, taskId }) => each(key, taskId)));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  };
}

/**
 * Finish the interrupted runs of `phats`, one project after another: each project is resumed only when its turn comes,
 * and `each` waits for a run to settle. Returns how many runs there were.
 */
export async function finishInterrupted(
  phats: Iterable<PhatMode>,
  context: Context,
  each: (phat: PhatMode, key: string, taskId: TaskId<RunResult>) => Promise<void>,
): Promise<number> {
  let count = 0;
  for (const phat of phats) {
    const live = await liveRuns(phat, context);
    if (live.length === 0) continue;
    resumeOnce(phat);
    for (const { key, taskId } of live) {
      await each(phat, key, taskId);
      count++;
    }
  }
  return count;
}

/** The projects of one watch: those it holds, in list order, and those another process holds (skipped). */
export type WatchedProjects = {
  /** The projects this watch holds, in the order of its list. */
  held(): PhatMode[];
  get(repo: string): PhatMode | undefined;
  /** The projects another process holds, with the holder last seen. */
  readonly skipped: ReadonlyMap<string, LockInfo>;
  /**
   * Try each skipped project once more: those whose holder has exited are taken over and returned, with the holder they
   * had; for the others, the holder seen now is recorded. Any error but LockedError closes everything and is rethrown.
   */
  retake(): Promise<{ repo: string; phat: PhatMode; previous: LockInfo }[]>;
  /** Close every project held, releasing their locks. */
  close(context: Context): Promise<void>;
};

/**
 * Take every project of `repos` that is free, with `take` (which throws LockedError when another process holds the
 * project), and skip the held ones. Any other error closes what was taken and is rethrown.
 */
export async function takeProjects(repos: readonly string[], take: (repo: string) => Promise<PhatMode>): Promise<WatchedProjects> {
  const held = new Map<string, PhatMode>();
  const skipped = new Map<string, LockInfo>();
  const close = async (context: Context) => {
    const all = [...held.values()];
    held.clear();
    await Promise.allSettled(all.map((phat) => phat.close(context)));
  };
  /** Take `repo`, or record its holder. Undefined when another process holds it. */
  const tryTake = async (repo: string): Promise<PhatMode | undefined> => {
    try {
      const phat = await take(repo);
      held.set(repo, phat);
      skipped.delete(repo);
      return phat;
    } catch (error) {
      if (!(error instanceof LockedError)) {
        await close(BACKGROUND_CONTEXT);
        throw error;
      }
      skipped.set(repo, error.holder);
      return undefined;
    }
  };
  for (const repo of repos) await tryTake(repo);
  return {
    held: () => repos.flatMap((repo) => held.get(repo) ?? []),
    get: (repo) => held.get(repo),
    skipped,
    async retake() {
      const taken: { repo: string; phat: PhatMode; previous: LockInfo }[] = [];
      for (const [repo, previous] of [...skipped]) {
        const phat = await tryTake(repo);
        if (phat !== undefined) taken.push({ repo, phat, previous });
      }
      return taken;
    },
    close,
  };
}

/** "owner/x is watched by pid 123 (phat-mode watch owner/x)" */
export function watchedBy(repo: string, holder: LockInfo): string {
  return `${repo} is watched by pid ${holder.pid} (${holder.command})`;
}

/** "Now watching owner/x: pid 123 (phat-mode watch owner/x) has stopped." */
export function takenOver(repo: string, previous: LockInfo): string {
  return `Now watching ${repo}: pid ${previous.pid} (${previous.command}) has stopped.`;
}

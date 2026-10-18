import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type LockInfo = {
  pid: number;
  /** Unique per lock, so release() only removes its own lock file. */
  token: string;
  /** What the owner is doing, e.g. "run 12". */
  command: string;
  startedAt: number;
};

/** Another live process holds the lock. */
export class LockedError extends Error {
  readonly holder: LockInfo;
  readonly path: string;
  constructor(path: string, holder: LockInfo) {
    const since = new Date(holder.startedAt).toLocaleTimeString('en-GB', { hour12: false });
    super(
      `phat-mode is already running (\`${holder.command}\`, pid ${holder.pid}, since ${since}). ` +
        `Only one phat-mode process may use ${dirname(path)} at a time. ` +
        `If that process is gone, delete ${path}.`,
    );
    this.holder = holder;
    this.path = path;
  }
}

export type Lock = {
  readonly path: string;
  release(): Promise<void>;
};

/** True when a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(path: string): Promise<LockInfo | undefined> {
  try {
    const holder = JSON.parse(await readFile(path, 'utf8')) as Partial<LockInfo>;
    return typeof holder.pid === 'number' ? (holder as LockInfo) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Unreadable or half-written: treat as stale.
    return undefined;
  }
}

/**
 * Take the lock at `path`, or throw LockedError when a live process holds it. A lock left by a dead process (a crash,
 * `kill -9`) is taken over. Released by `release()` and, as a fallback, when the process exits.
 */
export async function acquireLock(path: string, command: string, alive: (pid: number) => boolean = isAlive): Promise<Lock> {
  await mkdir(dirname(path), { recursive: true });
  const info: LockInfo = { pid: process.pid, token: randomUUID(), command, startedAt: Date.now() };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // `wx`: create only if absent, atomically. Two processes can never both succeed.
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify(info));
      await file.close();
      return held(path, info.token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readHolder(path);
    if (holder !== undefined && alive(holder.pid)) {
      throw new LockedError(path, holder);
    }
    // Stale: its process is gone. Remove it and try again.
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  throw new Error(`Could not take the lock ${path}`);
}

function held(path: string, token: string): Lock {
  let released = false;
  // Last resort for exits that skip release(), such as an uncaught error. Must be synchronous.
  const onExit = () => {
    if (!released && readHolderSync(path)?.token === token) {
      try {
        unlinkSync(path);
      } catch {}
    }
  };
  process.on('exit', onExit);
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      process.off('exit', onExit);
      // Only remove the lock if it is still ours.
      const holder = await readHolder(path);
      if (holder?.token === token) await unlink(path).catch(() => {});
    },
  };
}

function readHolderSync(path: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

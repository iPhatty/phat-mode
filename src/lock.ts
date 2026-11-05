import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** What a lock's holder is doing right now: a run of an issue, and its phase. */
export type Doing = { issue: number; kind: 'build' | 'shape'; phase: string };

export type LockInfo = {
  pid: number;
  /** Unique per lock taken. */
  token: string;
  /** The holder's command, e.g. "phat-mode run 12". */
  command: string;
  startedAt: number;
  /** What the holder is doing right now; missing while it is idle. */
  doing?: Doing;
};

/** Another live process holds the lock. */
export class LockedError extends Error {
  readonly holder: LockInfo;
  readonly path: string;
  /** `what`: what the lock protects, e.g. "owner/name". Default: the lock's path. */
  constructor(path: string, holder: LockInfo, what: string = path) {
    super(`${what} is held by ${describeHolder(holder)}. If that process is gone, remove the folder ${path}.`);
    this.holder = holder;
    this.path = path;
  }
}

/** "pid 123 (`phat-mode watch`, since 10:04:12)" */
export function describeHolder(holder: LockInfo): string {
  const since = new Date(holder.startedAt).toLocaleTimeString('en-GB', { hour12: false });
  return `pid ${holder.pid} (\`${holder.command}\`, since ${since})`;
}

export type Lock = {
  readonly path: string;
  /** Record what the holder is doing (`undefined`: idle). The file is replaced atomically, so readers never see half. */
  update(doing: Doing | undefined): Promise<void>;
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

/*
 * A lock is a folder of claims: files with unique names, each written in full and then renamed into place. To take the
 * lock, a process puts its claim in, marked `claiming`, and then lists every claim. It holds the lock only if no other
 * claim belongs to a live process; then it rewrites its claim without the mark. Otherwise it takes its claim out again:
 * another live holder is a refusal (LockedError), another live claimant means trying again shortly.
 *
 * Why two processes can never both hold it: of two that would, the one that listed later did so after the other's claim
 * was in place, and that claim stays until its owner releases, so the later one saw a live claim and stepped back. A
 * process that dies, at any point, leaves only a claim of a dead process, which every other process ignores (and may
 * remove: its name is never used again). Nothing depends on the order of claims, so none can hide a live holder.
 */

type Claim = LockInfo & {
  /** Put in place, but not yet checked against the other claims. */
  claiming?: true;
};

const CLAIM = /\.json$/;

/** The claims in the lock's folder, as file names. A missing folder: none. */
async function claimNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((file) => CLAIM.test(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

function parseClaim(text: string): Claim | undefined {
  try {
    const claim = JSON.parse(text) as Partial<Claim>;
    return typeof claim.pid === 'number' ? (claim as Claim) : undefined;
  } catch {
    return undefined;
  }
}

/** Every claim still there: its file name, and what it says (undefined when unreadable, which only damage causes). */
async function claims(path: string): Promise<{ name: string; claim: Claim | undefined }[]> {
  const found: { name: string; claim: Claim | undefined }[] = [];
  for (const name of await claimNames(path)) {
    try {
      found.push({ name, claim: parseClaim(await readFile(join(path, name), 'utf8')) });
    } catch (error) {
      // Gone meanwhile: taken out or released.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return found;
}

/** The live holder of the lock at `path`, or undefined when it is free or its holder is gone. Changes nothing. */
export async function readLock(path: string, alive: (pid: number) => boolean = isAlive): Promise<LockInfo | undefined> {
  const holder = (await claims(path)).find(({ claim }) => claim !== undefined && !claim.claiming && alive(claim.pid));
  if (holder === undefined) return undefined;
  const { claiming: _claiming, ...info } = holder.claim!;
  return info;
}

const tempName = (path: string) => join(path, `.${process.pid}.${randomUUID()}.tmp`);

/** Replace (or create) the file `name` in the lock's folder with `content`, atomically. */
async function writeClaim(path: string, name: string, content: Claim) {
  const temp = tempName(path);
  await writeFile(temp, JSON.stringify(content), { mode: 0o600 });
  await rename(temp, join(path, name)).catch(async (error) => {
    await unlink(temp).catch(() => {});
    throw error;
  });
}

export type AcquireOptions = {
  /** Whether a pid is a live process. Default: isAlive. */
  alive?: (pid: number) => boolean;
  /** What the lock protects, e.g. "owner/name", for the refusal's message. Default: the lock's path. */
  what?: string;
  /** Tests only: called once the claim is in place, before it is checked against the others. */
  afterClaim?: () => Promise<void>;
};

const ATTEMPTS = 500;

/**
 * Take the lock at `path` (a folder), or throw LockedError when a live process holds it. A lock left by a dead process
 * (a crash, `kill -9`) is taken over. Released by `release()` and, as a fallback, when the process exits.
 */
export async function acquireLock(path: string, command: string, options: AcquireOptions = {}): Promise<Lock> {
  const alive = options.alive ?? isAlive;
  await mkdir(path, { recursive: true });
  const info: LockInfo = { pid: process.pid, token: randomUUID(), command, startedAt: Date.now() };
  const name = `${process.pid}-${info.token}.json`;
  let claimant: LockInfo | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await writeClaim(path, name, { ...info, claiming: true });
    let claimed = false;
    try {
      await options.afterClaim?.();
      const others = (await claims(path)).filter((other) => other.name !== name);
      const live = others.filter(({ claim }) => claim !== undefined && alive(claim.pid));
      // Claims of processes that are gone, or damaged ones, never count again: tidy them away.
      for (const other of others) {
        if (!live.includes(other)) await unlink(join(path, other.name)).catch(() => {});
      }
      const holder = live.find(({ claim }) => !claim!.claiming);
      if (holder !== undefined) {
        const { claiming: _claiming, ...held } = holder.claim!;
        throw new LockedError(path, held, options.what);
      }
      if (live.length === 0) {
        await writeClaim(path, name, info);
        claimed = true;
        return held(path, name, info);
      }
      claimant = live[0]!.claim;
    } finally {
      if (!claimed) await unlink(join(path, name)).catch(() => {});
    }
    // Another process is taking it at the same moment: both stepped back. Try again after a random moment.
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 20));
  }
  if (claimant !== undefined) throw new LockedError(path, claimant, options.what);
  throw new Error(`Could not take the lock ${path}`);
}

function held(path: string, name: string, info: LockInfo): Lock {
  const file = join(path, name);
  const { token } = info;
  let released = false;
  // Updates are written one after another, in order.
  let chain: Promise<void> = Promise.resolve();
  // Last resort for exits that skip release(), such as an uncaught error. Must be synchronous.
  const onExit = () => {
    if (!released && readHolderSync(file)?.token === token) {
      try {
        unlinkSync(file);
      } catch {}
    }
  };
  process.on('exit', onExit);
  return {
    path,
    update(doing) {
      const next = chain.then(async () => {
        if (released) return;
        const { doing: _old, ...rest } = info;
        // The claim is ours alone: only its owner replaces it, or removes it while it is live.
        await writeClaim(path, name, doing === undefined ? rest : { ...rest, doing });
      });
      chain = next.catch(() => {});
      return next;
    },
    async release() {
      if (released) return;
      released = true;
      process.off('exit', onExit);
      await chain;
      await unlink(file).catch(() => {});
    },
  };
}

function readHolderSync(file: string): LockInfo | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

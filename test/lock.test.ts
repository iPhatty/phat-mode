import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { acquireLock, LockedError, readLock } from '../src/lock.ts';

const LOCK_MODULE = resolve(import.meta.dirname, '../src/lock.ts');
const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function lockPath() {
  const dir = await mkdtemp(join(tmpdir(), 'phat-lock-'));
  dirs.push(dir);
  return join(dir, 'state.sqlite.lock');
}

/** The holder files in a lock's folder. */
const holderFiles = async (path: string) => (await readdir(path).catch(() => [])).filter((file) => file.endsWith('.json'));

/** Put a holder file in place by hand, as a process that is gone (or another) left it. */
async function plant(path: string, n: number, content: string) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, `${n}.json`), content);
}

/** Run a script in another node process that takes the lock and prints "locked". */
async function child(path: string, then: 'wait' | 'exit'): Promise<{ process: ChildProcess; exited: Promise<number | null> }> {
  const script = join(path, '..', `child-${Date.now()}-${Math.random()}.ts`);
  await writeFile(
    script,
    `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
await acquireLock(${JSON.stringify(path)}, 'phat-mode run 1');
console.log('locked');
${then === 'wait' ? 'setInterval(() => {}, 1000);' : 'process.exit(0);'}
`,
  );
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (chunk) => String(chunk).includes('locked') && resolve());
    proc.on('exit', (code) => (then === 'exit' ? resolve() : reject(new Error(`child exited with ${code}`))));
  });
  return { process: proc, exited };
}

describe('acquireLock', () => {
  test('a second holder is refused, and gets in after release', async () => {
    const path = await lockPath();
    const first = await acquireLock(path, 'phat-mode run 1');
    await assert.rejects(acquireLock(path, 'phat-mode status'), (error: unknown) => {
      assert.ok(error instanceof LockedError);
      assert.equal(error.holder.pid, process.pid);
      assert.match(error.message, new RegExp(`is held by pid ${process.pid} \\(\`phat-mode run 1\`, since`));
      return true;
    });
    await first.release();
    assert.deepEqual(await holderFiles(path), []);
    const second = await acquireLock(path, 'phat-mode status');
    await second.release();
  });

  test('release is idempotent and never removes another holder’s lock', async () => {
    const path = await lockPath();
    const lock = await acquireLock(path, 'a');
    // Someone else took the lock over meanwhile (e.g. after it was judged gone).
    await plant(path, 2, JSON.stringify({ pid: process.pid, token: 'other', command: 'b', startedAt: 0 }));
    await lock.release();
    await lock.release();
    assert.equal((await readLock(path))?.token, 'other');
  });

  test('takes over a lock whose process is gone', async () => {
    const path = await lockPath();
    await plant(path, 1, JSON.stringify({ pid: 999_999, token: 'dead', command: 'phat-mode run 1', startedAt: 0 }));
    const lock = await acquireLock(path, 'phat-mode run 2', { alive: (pid) => pid !== 999_999 });
    assert.equal((await readLock(path))?.command, 'phat-mode run 2');
    await lock.release();
  });

  test('a claim left by a process that crashed while taking the lock never hides the live holder', async () => {
    const path = await lockPath();
    const holder = await child(path, 'wait');
    try {
      // What a contender killed right after putting its claim in place leaves, whatever its number.
      const dead = await child(join(path, '..', 'other.lock'), 'wait');
      dead.process.kill('SIGKILL');
      await dead.exited;
      await plant(path, 2, JSON.stringify({ pid: dead.process.pid, token: 'crashed', command: 'phat-mode run 2', startedAt: 0 }));
      await assert.rejects(acquireLock(path, 'phat-mode status'), (error: unknown) => {
        assert.ok(error instanceof LockedError);
        assert.equal(error.holder.pid, holder.process.pid);
        return true;
      });
      assert.equal((await readLock(path))?.pid, holder.process.pid);
    } finally {
      holder.process.kill('SIGKILL');
      await holder.exited;
    }
  });

  test('treats an unreadable lock file as stale', async () => {
    const path = await lockPath();
    await plant(path, 1, '{ half-written');
    const lock = await acquireLock(path, 'phat-mode run 1');
    await lock.release();
  });

  test('another live process holds the lock: refused; after kill -9: taken over', async () => {
    const path = await lockPath();
    const holder = await child(path, 'wait');
    try {
      await assert.rejects(acquireLock(path, 'phat-mode status'), (error: unknown) => {
        assert.ok(error instanceof LockedError);
        assert.equal(error.holder.pid, holder.process.pid);
        return true;
      });
    } finally {
      holder.process.kill('SIGKILL');
      await holder.exited;
    }
    // SIGKILL skips every exit handler, so the file is still there, but its process is gone.
    assert.equal((await holderFiles(path)).length, 1);
    const lock = await acquireLock(path, 'phat-mode resume');
    await lock.release();
  });

  test('a process that exits without releasing removes its lock', async () => {
    const path = await lockPath();
    const holder = await child(path, 'exit');
    assert.equal(await holder.exited, 0);
    assert.deepEqual(await holderFiles(path), []);
  });

  test('a refusal names what is held, the holder’s pid and its command', async () => {
    const path = await lockPath();
    const first = await acquireLock(path, 'phat-mode watch', { what: 'owner/x' });
    await assert.rejects(acquireLock(path, 'phat-mode run owner/x#1', { what: 'owner/x' }), (error: unknown) => {
      assert.ok(error instanceof LockedError);
      assert.match(error.message, new RegExp(`^owner/x is held by pid ${process.pid} \\(\`phat-mode watch\`, since \\d\\d:\\d\\d:\\d\\d\\)`));
      return true;
    });
    await first.release();
  });
});

describe('what the holder is doing', () => {
  test('update writes what it is doing, readable at once as valid JSON, and clears it', async () => {
    const path = await lockPath();
    const lock = await acquireLock(path, 'phat-mode watch');
    await lock.update({ issue: 12, kind: 'build', phase: 'plan' });
    assert.deepEqual((await readLock(path))?.doing, { issue: 12, kind: 'build', phase: 'plan' });
    await lock.update({ issue: 12, kind: 'build', phase: 'implement' });
    const [file] = await holderFiles(path);
    const info = JSON.parse(await readFile(join(path, file!), 'utf8'));
    assert.equal(info.command, 'phat-mode watch');
    assert.deepEqual(info.doing, { issue: 12, kind: 'build', phase: 'implement' });
    await lock.update(undefined);
    assert.equal((await readLock(path))?.doing, undefined);
    await lock.release();
  });

  test('many quick updates never leave a reader a half-written file', async () => {
    const path = await lockPath();
    const lock = await acquireLock(path, 'phat-mode watch');
    const reads: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      void lock.update({ issue: i, kind: 'shape', phase: 'grill' });
      reads.push(readLock(path).then((info) => assert.equal(info?.command, 'phat-mode watch')));
    }
    await Promise.all(reads);
    await lock.update({ issue: 99, kind: 'shape', phase: 'tickets' });
    assert.equal((await readLock(path))?.doing?.issue, 99);
    await lock.release();
  });

  test('readLock: the live holder, or nothing when it is free or its process is gone; the file is left alone', async () => {
    const path = await lockPath();
    assert.equal(await readLock(path), undefined);
    const dead = JSON.stringify({ pid: 999_999, token: 'dead', command: 'phat-mode run 1', startedAt: 0 });
    await plant(path, 1, dead);
    assert.equal(await readLock(path, () => false), undefined);
    assert.equal(await readFile(join(path, '1.json'), 'utf8'), dead);
    const holder = await child(path.replace(/[^/]+$/, 'live.lock'), 'wait');
    try {
      const info = await readLock(path.replace(/[^/]+$/, 'live.lock'));
      assert.equal(info?.pid, holder.process.pid);
      assert.equal(info?.command, 'phat-mode run 1');
    } finally {
      holder.process.kill('SIGKILL');
      await holder.exited;
    }
  });
});

describe('taking over a dead holder’s lock, with many processes at once', () => {
  /**
   * Each child waits for the start signal, then tries until it holds the lock. Holding it, it marks the room as
   * occupied with an exclusive file (two holders at once would collide there), leaves, and then either releases the
   * lock or dies holding it (SIGKILL), leaving a stale lock for the others to take over at the same moment.
   */
  async function contender(path: string, room: string, go: string, crash: boolean) {
    const script = join(path, '..', `contender-${Math.random()}.ts`);
    await writeFile(
      script,
      `import { access, open, unlink } from 'node:fs/promises';
import { acquireLock, LockedError } from ${JSON.stringify(LOCK_MODULE)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
while (!(await access(${JSON.stringify(go)}).then(() => true, () => false))) await sleep(2);
let lock;
for (;;) {
  try {
    lock = await acquireLock(${JSON.stringify(path)}, 'contender');
    break;
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    await sleep(1);
  }
}
try {
  await (await open(${JSON.stringify(room)}, 'wx')).close();
} catch {
  console.log('two holders at once');
  process.exit(2);
}
await sleep(5);
await unlink(${JSON.stringify(room)});
${crash ? "process.kill(process.pid, 'SIGKILL');" : 'await lock.release();'}
`,
    );
    const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout!.on('data', (chunk) => (out += String(chunk)));
    return new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) =>
      proc.on('exit', (code, signal) => resolve({ code, signal, out })),
    );
  }

  test('never two holders, however the takeovers interleave', async () => {
    for (let round = 0; round < 6; round++) {
      const path = await lockPath();
      const room = join(path, '..', 'room');
      const go = join(path, '..', 'go');
      // Start from a lock its process left behind, so the first takeovers race too.
      const dead = await child(path, 'wait');
      dead.process.kill('SIGKILL');
      await dead.exited;
      const runs = Array.from({ length: 10 }, (_, i) => contender(path, room, go, i % 2 === 0));
      await new Promise((resolve) => setTimeout(resolve, 600));
      await writeFile(go, '');
      const results = await Promise.all(runs);
      assert.deepEqual(
        results.filter((result) => result.out.includes('two holders')),
        [],
        `round ${round}`,
      );
      assert.ok(results.every((result) => result.code === 0 || result.signal === 'SIGKILL'), JSON.stringify(results));
    }
  });
});

describe('a process killed while taking the lock', () => {
  /**
   * A child process that takes the lock: `hold` tries until it holds it, then keeps it until told `exit` on stdin (a
   * clean exit, which releases it); `pause` stops for good right after its claim is in place, before checking it.
   */
  async function taker(path: string, mode: 'hold' | 'pause') {
    const script = join(path, '..', `taker-${Math.random()}.ts`);
    await writeFile(
      script,
      `import { acquireLock, LockedError } from ${JSON.stringify(LOCK_MODULE)};
process.stdin.on('data', (data) => String(data).includes('exit') && process.exit(0));
for (;;) {
  try {
    await acquireLock(${JSON.stringify(path)}, 'taker ${mode}', {
      afterClaim: ${mode === 'pause' ? "async () => { console.log('claimed'); await new Promise(() => {}); }" : 'undefined'},
    });
    console.log('locked');
    break;
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
`,
    );
    const proc = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    let out = '';
    proc.stdout!.on('data', (chunk) => (out += String(chunk)));
    const said = (word: string) =>
      new Promise<void>((resolve, reject) => {
        const look = () => (out.includes(word) ? resolve() : undefined);
        proc.stdout!.on('data', look);
        proc.on('exit', () => reject(new Error(`taker exited before saying ${word}`)));
        look();
      });
    return {
      pid: proc.pid!,
      said,
      saidYet: (word: string) => out.includes(word),
      exit: async () => {
        proc.stdin!.write('exit\n');
        await exited;
      },
      kill: async () => {
        proc.kill('SIGKILL');
        await exited;
      },
    };
  }

  test('claims of contenders killed mid-way never let a second process in beside the holder', async () => {
    const path = await lockPath();
    const first = await taker(path, 'hold');
    await first.said('locked');
    // A contender puts its claim in while the first holds the lock, and stops there.
    const paused = await taker(path, 'pause');
    await paused.said('claimed');
    // The first leaves cleanly; another takes its place, but must wait while the paused claim is live.
    await first.exit();
    const second = await taker(path, 'hold');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(second.saidYet('locked'), false, 'a live claimant is waited for');
    // The paused contender is killed with its claim in place.
    await paused.kill();
    await second.said('locked');
    // Another contender is killed mid-way while the second holds the lock.
    const again = await taker(path, 'pause');
    await again.said('claimed');
    await again.kill();
    try {
      await assert.rejects(acquireLock(path, 'phat-mode status'), (error: unknown) => {
        assert.ok(error instanceof LockedError);
        assert.equal(error.holder.pid, second.pid);
        return true;
      });
      assert.equal((await readLock(path))?.pid, second.pid);
    } finally {
      await second.kill();
    }
    // Once the holder is gone too, the lock is free: every claim left is a dead process's.
    const lock = await acquireLock(path, 'phat-mode resume');
    await lock.release();
  });
});

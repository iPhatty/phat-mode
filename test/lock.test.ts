import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { acquireLock, LockedError } from '../src/lock.ts';

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

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

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
      assert.match(error.message, /already running \(`phat-mode run 1`/);
      return true;
    });
    await first.release();
    assert.equal(await exists(path), false);
    const second = await acquireLock(path, 'phat-mode status');
    await second.release();
  });

  test('release is idempotent and never removes another holder’s lock', async () => {
    const path = await lockPath();
    const lock = await acquireLock(path, 'a');
    // Someone else's lock replaced ours (e.g. after it was deleted by hand and retaken).
    await writeFile(path, JSON.stringify({ pid: process.pid, token: 'other', command: 'b', startedAt: 0 }));
    await lock.release();
    await lock.release();
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'other');
  });

  test('takes over a lock whose process is gone', async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: 999_999, token: 'dead', command: 'phat-mode run 1', startedAt: 0 }));
    const lock = await acquireLock(path, 'phat-mode run 2', () => false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).command, 'phat-mode run 2');
    await lock.release();
  });

  test('treats an unreadable lock file as stale', async () => {
    const path = await lockPath();
    await writeFile(path, '{ half-written');
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
    assert.equal(await exists(path), true);
    const lock = await acquireLock(path, 'phat-mode resume');
    await lock.release();
  });

  test('a process that exits without releasing removes its lock', async () => {
    const path = await lockPath();
    const holder = await child(path, 'exit');
    assert.equal(await holder.exited, 0);
    assert.equal(await exists(path), false);
  });
});

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { paths } from '../src/config.ts';

const ROOT = resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];
const homes: string[] = [];
after(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

/** Another node process that takes the lock at `path` with `command`, and keeps it until killed. */
async function holder(path: string, command: string): Promise<{ pid: number }> {
  await mkdir(dirname(path), { recursive: true });
  const script = `${path}.child.ts`;
  await writeFile(
    script,
    `import { acquireLock } from ${JSON.stringify(join(ROOT, 'src/lock.ts'))};
await acquireLock(${JSON.stringify(path)}, ${JSON.stringify(command)});
console.log('locked');
setInterval(() => {}, 1000);
`,
  );
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(proc);
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (chunk) => String(chunk).includes('locked') && resolve());
    proc.on('exit', (code) => reject(new Error(`child exited with ${code}`)));
  });
  return { pid: proc.pid! };
}

/** `phat-mode <args>` in its own process, with `home` as its home and no terminal: its exit code and output. */
async function phatMode(home: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const proc = spawn(process.execPath, [join(ROOT, 'src/cli.ts'), ...args], {
    cwd: home,
    env: { ...process.env, PHAT_MODE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let output = '';
  proc.stdout!.on('data', (chunk) => (output += String(chunk)));
  proc.stderr!.on('data', (chunk) => (output += String(chunk)));
  const code = await new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  return { code, output };
}

test('`phat-mode watch owner/x` while another process watches owner/x: names the holder and exits 1', async () => {
  const home = await mkdtemp(join(tmpdir(), 'phat-mode-watch-'));
  homes.push(home);
  const other = await holder(paths.projectLock(home, 'owner/x'), 'phat-mode watch');
  const { code, output } = await phatMode(home, ['watch', 'owner/x']);
  assert.match(output, new RegExp(`owner/x is watched by pid ${other.pid} \\(phat-mode watch\\)`));
  assert.equal(code, 1);
});

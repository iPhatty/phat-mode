import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import type { Credential } from '@earendil-works/pi-ai';
import { FileCredentialStore } from '../src/credentials.ts';
import { acquireLock } from '../src/lock.ts';

const CREDENTIALS_MODULE = resolve(import.meta.dirname, '../src/credentials.ts');
const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function authFile() {
  const dir = await mkdtemp(join(tmpdir(), 'phat-auth-'));
  dirs.push(dir);
  return join(dir, 'auth.json');
}

const oauth = (expires: number): Credential => ({ type: 'oauth', access: `token-${expires}`, refresh: 'r', expires });

/**
 * Another node process that "refreshes" the token `times` times, each time as pi-ai does inside `modify`: it looks at
 * the current token and writes one newer than it (here: one step later).
 */
async function refresher(path: string, times: number): Promise<number | null> {
  const script = `${path}.child-${Math.random()}.ts`;
  await writeFile(
    script,
    `import { FileCredentialStore } from ${JSON.stringify(CREDENTIALS_MODULE)};
const store = new FileCredentialStore(${JSON.stringify(path)});
for (let i = 0; i < ${times}; i++) {
  await store.modify('github-copilot', async (current) => {
    const expires = (current?.expires ?? 0) + 1;
    // A refresh takes a while: long enough for the other process to try too.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { type: 'oauth', access: 'token-' + expires, refresh: 'r', expires };
  });
}
`,
  );
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'inherit', 'inherit'] });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

describe('FileCredentialStore across processes', () => {
  test('two processes refreshing at once: every refresh builds on the newest token, and auth.json stays valid JSON', async () => {
    const path = await authFile();
    await new FileCredentialStore(path).modify('github-copilot', async () => oauth(0));
    const codes = await Promise.all([refresher(path, 50), refresher(path, 50)]);
    assert.deepEqual(codes, [0, 0]);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, Credential>;
    assert.deepEqual(saved['github-copilot'], oauth(100), 'no refresh overwrote a newer token');
    const left = (await readdir(join(path, '..'))).filter((file) => !file.endsWith('.ts') && file !== 'auth.json');
    assert.deepEqual(left, ['auth.json.lock'], 'no temp file left behind');
    assert.deepEqual(await readdir(`${path}.lock`), [], 'the lock is free, with nothing left in it');
  });

  test('modify sees a token another store wrote after this one was created', async () => {
    const path = await authFile();
    const mine = new FileCredentialStore(path);
    await mine.read('github-copilot');
    await new FileCredentialStore(path).modify('github-copilot', async () => oauth(7));
    let seen: Credential | undefined;
    await mine.modify('github-copilot', async (current) => {
      seen = current;
      return undefined;
    });
    assert.deepEqual(seen, oauth(7));
  });

  test('while another process holds auth.json, modify and delete wait for it; a cancelled wait gives up', async () => {
    const path = await authFile();
    const store = new FileCredentialStore(path);
    await store.modify('github-copilot', async () => oauth(1));
    const held = await acquireLock(`${path}.lock`, 'another refresh');
    const controller = new AbortController();
    const cancelled = store.modify('github-copilot', async () => oauth(9), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('gave up')), 100);
    await assert.rejects(cancelled, /gave up/);
    let done = false;
    const waiting = store.delete('github-copilot').then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(done, false, 'still waiting');
    await held.release();
    await waiting;
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {});
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FileCredentialStore, importPiCredential } from '../src/credentials.ts';
import { agentEnv } from '../src/exec.ts';
import { pullRequestBody } from '../src/messages.ts';

const issue = { number: 7, title: 'Save progress', body: '', author: 'iPhatty', state: 'OPEN' as const, url: '', labels: [] };
const triage = { decision: 'proceed' as const, kind: 'feature' as const, summary: 'Save lesson progress.', plan: ['Add storage', 'Test it'], questions: [] };

describe('pullRequestBody', () => {
  test('links the issue and lists summary, plan, testing and the approval', () => {
    const body = pullRequestBody({
      issue,
      triage,
      done: { summary: 'Progress is saved with AsyncStorage.', testing: 'Added progress tests.' },
      review: { verdict: 'approve', summary: 'Looks right.', findings: [] },
      unresolved: [],
      checkCommand: 'npm run check',
    });
    assert.match(body, /^Closes #7/);
    assert.match(body, /Progress is saved with AsyncStorage\./);
    assert.match(body, /- Add storage\n- Test it/);
    assert.match(body, /`npm run check` passes/);
    assert.match(body, /Approved by the reviewer agent/);
    assert.doesNotMatch(body, /Unresolved/);
  });

  test('lists unresolved findings instead of an approval', () => {
    const body = pullRequestBody({
      issue,
      triage,
      done: undefined,
      review: { verdict: 'changes', summary: '', findings: ['src/a.ts: missing test'] },
      unresolved: ['src/a.ts: missing test'],
      checkCommand: 'npm run check',
    });
    assert.match(body, /Unresolved review findings\n\n- src\/a\.ts: missing test/);
    assert.doesNotMatch(body, /Approved/);
  });
});

describe('agentEnv', () => {
  test('drops credentials and keeps everything else', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      GH_TOKEN: 'a',
      GITHUB_TOKEN: 'b',
      COPILOT_GITHUB_TOKEN: 'c',
      OPENAI_API_KEY: 'd',
      SSH_AUTH_SOCK: 'e',
      NPM_CONFIG_PASSWORD: 'f',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/Users/x' });
  });
});

describe('FileCredentialStore', () => {
  test('persists credentials with owner-only permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phat-cred-'));
    try {
      const path = join(dir, 'nested', 'auth.json');
      const store = new FileCredentialStore(path);
      await store.modify('github-copilot', async () => ({ type: 'api_key', key: 'secret' }));
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await new FileCredentialStore(path).read('github-copilot'), { type: 'api_key', key: 'secret' });
      assert.deepEqual(await store.list(), [{ providerId: 'github-copilot', type: 'api_key' }]);
      await store.delete('github-copilot');
      assert.equal(await store.read('github-copilot'), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('imports one provider from a pi auth.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phat-cred-'));
    try {
      const piAuth = join(dir, 'pi-auth.json');
      await writeFile(
        piAuth,
        JSON.stringify({ 'github-copilot': { type: 'api_key', key: 'copilot' }, other: { type: 'api_key', key: 'x' } }),
      );
      const store = new FileCredentialStore(join(dir, 'auth.json'));
      assert.equal(await importPiCredential(store, 'github-copilot', piAuth), true);
      assert.equal(await importPiCredential(store, 'missing', piAuth), false);
      const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
      assert.deepEqual(Object.keys(saved), ['github-copilot']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

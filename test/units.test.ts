import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FileCredentialStore, importPiCredential } from '../src/credentials.ts';
import { agentEnv } from '../src/exec.ts';
import { pullRequestBody } from '../src/messages.ts';

const issue = { number: 7, title: 'Save progress', body: '', author: 'iPhatty', state: 'OPEN' as const, url: '', labels: [], comments: [] };
const spec = { source: 'issue' as const, author: 'iPhatty', text: '', acceptanceCriteria: [], outOfScope: [], blockedBy: [] };
const plan = { decision: 'proceed' as const, summary: 'Save lesson progress.', plan: ['Add storage', 'Test it'], established: [], questions: [], reason: '' };

describe('pullRequestBody', () => {
  const details = {
    issue,
    spec,
    plan,
    done: { summary: 'Progress is saved with AsyncStorage.', testing: 'Added progress tests.' },
    checkCommand: 'npm run check',
  };

  test('links the issue and lists summary, plan, testing and the code review', () => {
    const body = pullRequestBody({
      ...details,
      review: {
        round: 1,
        standards: { summary: 'Follows AGENTS.md.', worst: '', findings: [] },
        spec: { summary: 'Does what the issue asks.', worst: '', findings: [] },
      },
      unresolved: false,
    });
    assert.match(body, /^Closes #7/);
    assert.match(body, /Progress is saved with AsyncStorage\./);
    assert.match(body, /- Add storage\n- Test it/);
    assert.match(body, /`npm run check` passes/);
    assert.match(body, /after 1 round\. ✅ Nothing that must be fixed/);
    assert.match(body, /### Standards\n\nFollows AGENTS\.md\.\n\n### Spec\n\nDoes what the issue asks\./);
    assert.match(body, /\*\*Summary:\*\* Standards: no findings\. Spec: no findings\./);
    assert.doesNotMatch(body, /Acceptance criteria/, 'no brief, no criteria section');
  });

  test('flags must-fix findings that are still open; keeps the axes apart; notes a missing report', () => {
    const body = pullRequestBody({
      ...details,
      review: {
        round: 2,
        standards: null,
        spec: {
          summary: 'Saves, but not on update.',
          worst: 'progress lost after an app update',
          findings: [
            { kind: 'missing', where: 'src/progress.ts', specLine: 'Progress survives an app restart', detail: 'progress lost after an app update' },
            { kind: 'unasked', where: '', specLine: 'Out of scope: syncing', detail: 'adds a sync stub' },
          ],
        },
      },
      unresolved: true,
    });
    assert.match(body, /after 2 rounds\. ⚠️ \*\*Findings that must be fixed are still open\*\*/);
    assert.match(body, /### Standards\n\nThe Standards reviewer did not report\./);
    assert.match(
      body,
      /- \*\*Missing or partial\*\* in `src\/progress\.ts`: progress lost after an app update\n  > Progress survives an app restart\n- \*\*Not asked for\*\*: adds a sync stub/,
    );
    assert.match(body, /Standards: no report\. Spec: 2 findings \(worst: progress lost after an app update\)\./);
    assert.doesNotMatch(body, /Nothing that must be fixed/);
  });

  test('without a review: no review section', () => {
    const body = pullRequestBody({ ...details, review: undefined, unresolved: false });
    assert.doesNotMatch(body, /Code review/);
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

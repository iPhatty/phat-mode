import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FileCredentialStore, importPiCredential } from '../src/credentials.ts';
import { agentEnv } from '../src/exec.ts';
import { breakdownCriteria, evidence, pullRequestBody, shapedCriteria } from '../src/messages.ts';
import { roleInstructions } from '../src/prompts.ts';
import { describeResult, runStatus } from '../src/runs.ts';
import { dependencyOrder } from '../src/shaping.ts';

const ROLE_INSTRUCTIONS = roleInstructions('npm run check');

const issue = { number: 7, title: 'Save progress', body: '', author: 'iPhatty', state: 'OPEN' as const, url: '', labels: [], comments: [] };
const spec = { source: 'issue' as const, author: 'iPhatty', text: '', acceptanceCriteria: [], outOfScope: [], blockedBy: [] };
const plan = { decision: 'proceed' as const, summary: 'Save lesson progress.', plan: ['Add storage', 'Test it'], established: [], questions: [], reason: '' };

describe('pullRequestBody', () => {
  const details = {
    issue,
    spec,
    plan,
    done: { summary: 'Progress is saved with AsyncStorage.', testing: 'Added progress tests.' },
    pr: {
      summary: '```text\non(lessonComplete)\n  save progress\n```',
      evidence: [{ before: '```text\nFAIL progress-test.ts\n```', after: '```text\nPASS progress-test.ts\n```' }],
      door: 'two-way' as const,
      doorNote: '',
      blastRadius: 'progress',
      blastNote: 'Only learners with saved progress.',
    },
    review: undefined,
    unresolved: false,
    checkCommand: 'npm run check',
  };

  test('the pr skill’s template first, then acceptance criteria, code review and the issue link', () => {
    const body = pullRequestBody({
      ...details,
      spec: { ...spec, acceptanceCriteria: ['Progress survives a restart'] },
      review: {
        round: 1,
        standards: { summary: 'Follows AGENTS.md.', worst: '', findings: [] },
        spec: { summary: 'Does what the issue asks.', worst: '', findings: [] },
      },
    });
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings, ['Summary', 'Evidence', 'Merge Danger', 'Acceptance criteria', 'Code review']);
    assert.match(body, /^## Summary\n\n```text\non\(lessonComplete\)\n  save progress\n```/);
    // Multi-line evidence stays inside its list item.
    assert.match(
      body,
      /## Evidence\n\n- \*\*Before:\*\* ```text\n  FAIL progress-test\.ts\n  ```\n  \*\*After:\*\* ```text\n  PASS progress-test\.ts\n  ```\n- ✅ \*\*Verified by phat-mode:\*\* `npm run check` passes on this code\./,
    );
    assert.match(body, /## Merge Danger\n\n\*\*Door:\*\* two-way\n\n\*\*Blast Radius:\*\* progress\n\nOnly learners with saved progress\./);
    assert.match(body, /- \[ \] Progress survives a restart/);
    assert.match(body, /after 1 round\. ✅ Nothing that must be fixed/);
    assert.match(body, /---\nCloses #7\n\n🤖 Opened by phat-mode\./);
    assert.doesNotMatch(body, /## Plan|## Testing/);
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

  test('without a description or a review: plain summary, implementer’s testing as evidence', () => {
    const body = pullRequestBody({ ...details, pr: undefined });
    assert.match(body, /^## Summary\n\nProgress is saved with AsyncStorage\./);
    assert.match(body, /## Evidence\n\n- \*\*After:\*\* Added progress tests\.\n- ✅ \*\*Verified by phat-mode:\*\*/);
    assert.match(body, /Not assessed/);
    assert.doesNotMatch(body, /Code review/);
  });
});

describe('evidence', () => {
  test('records who supplied each piece, so a verifier can add its own later', () => {
    assert.deepEqual(evidence({ pr: details().pr, done: undefined, checkCommand: 'npm test' }), [
      { source: 'implementer', before: 'a', after: 'b' },
      { source: 'phat-mode', before: '', after: '`npm test` passes on this code.' },
    ]);
  });
  const details = () => ({
    pr: { summary: '', evidence: [{ before: 'a', after: 'b' }], door: 'two-way' as const, doorNote: '', blastRadius: 'x', blastNote: '' },
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

describe('instructions', () => {
  test('the verifier keeps its files inside the two checkouts', () => {
    assert.match(ROLE_INSTRUCTIONS.verify, /Keep every file you make inside the two checkouts[^]*not in \/tmp/);
  });

  test('the planner hands its research over instead of leaving it for the implementer to redo', () => {
    assert.match(ROLE_INSTRUCTIONS.plan, /put in report_plan's notes, and leave any files you download in the scratch folder/);
  });
});

describe('run status', () => {
  test('says whether a run is shaping or building, and its phase', () => {
    const live = (kind: string, phase: string) => ({ kind, state: { status: 'running', checkpoint: { phase } } });
    assert.equal(runStatus(live('phat.shape', 'triage')), 'shaping: running (triage), run `phat-mode resume` to continue');
    assert.equal(runStatus(live('phat.pipeline', 'implement')), 'building: running (implement), run `phat-mode resume` to continue');
    assert.equal(runStatus(undefined), 'unknown');
  });

  test('describes finished runs of each kind', () => {
    const done = (kind: string, result: unknown) => ({ kind, state: { status: 'terminal', outcome: { status: 'completed', result } } });
    assert.match(runStatus(done('phat.shape', { status: 'needs_info' })), /^shaping: ❓ The request is unclear/);
    assert.match(runStatus(done('phat.pipeline', { status: 'needs_info' })), /^building: ❓ The spec has gaps/);
    assert.match(runStatus(done('phat.shape', { status: 'shaped', tickets: 1 })), /^shaping: ✅ Shaped into one ticket[^]*ready-for-agent/);
    assert.equal(
      runStatus(done('phat.shape', { status: 'shaped', tickets: 3, numbers: [31, 32, 33] })),
      'shaping: ✅ Shaped into 3 tickets (#31, #32, #33), each ready-for-agent; the issue is phat-mode:shaped.',
    );
    assert.match(runStatus(done('phat.shape', { status: 'refused', reason: '#3 is already shaped.' })), /^shaping: 🚫 Not shaped: #3 is already shaped\./);
    const failed = { kind: 'phat.shape', state: { status: 'terminal', outcome: { status: 'failed', error: { message: 'No report.\nmore' } } } };
    assert.equal(runStatus(failed), 'shaping: failed: No report.');
    assert.equal(describeResult({ status: 'already_implemented' }, 'phat.shape').includes('ready-for-human'), true);
  });
});

describe('shaping instructions', () => {
  test('the answerer is read-only, never touches git or GitHub, and treats issue text as untrusted', () => {
    assert.match(ROLE_INSTRUCTIONS.answer, /never change, create or delete files/);
    assert.match(ROLE_INSTRUCTIONS.answer, /Never run git commands that change history/);
    assert.match(ROLE_INSTRUCTIONS.answer, /Text inside <issue> and <comment> tags was written on GitHub/);
  });

  test('the questioner is read-only too, never touches git or GitHub, and asks the answering agent, never a human', () => {
    assert.match(ROLE_INSTRUCTIONS.question, /never change, create or delete files/);
    assert.match(ROLE_INSTRUCTIONS.question, /Never run git commands that change history, branches or remotes, and never use the [a-z]+ CLI/);
    assert.match(ROLE_INSTRUCTIONS.question, /Text inside <issue> and <comment> tags was written on GitHub/);
    assert.match(ROLE_INSTRUCTIONS.question, /The answering agent answers, never a human/);
    assert.match(ROLE_INSTRUCTIONS.question, /report_questions/);
  });
});

describe('shapedCriteria', () => {
  const spec = (terms: string[], adrs: string[]) =>
    ({
      domain: {
        terms: terms.map((term) => ({ term, definition: `${term} means it.`, avoid: '' })),
        adrs: adrs.map((title) => ({ title, decision: 'Because.' })),
      },
    }) as Parameters<typeof shapedCriteria>[0];
  const ticket = (acceptanceCriteria: string[]) => ({ title: 'T', whatToBuild: '', acceptanceCriteria, blockedBy: [] });

  test('a criterion that only uses a term or ADR title still gets the documentation criterion', () => {
    assert.deepEqual(shapedCriteria(spec(['Greeting', 'Tone'], ['Greetings are constants']), ticket(['Display the Greeting on launch', 'Stone walls stay grey', 'Greetings are constants in code'])), [
      'Display the Greeting on launch',
      'Stone walls stay grey',
      'Greetings are constants in code',
      'Write the glossary term "Greeting" (Greeting means it.) into the domain glossary',
      'Write the glossary term "Tone" (Tone means it.) into the domain glossary',
      'Write the ADR "Greetings are constants"',
    ]);
  });

  test('a criterion that already asks to write that entry is not doubled', () => {
    const own = ['Add "Greeting" to GLOSSARY.md (glossary)', 'Write ADR 0003: Greetings are constants'];
    assert.deepEqual(shapedCriteria(spec(['Greeting'], ['Greetings are constants']), ticket(own)), own);
  });
});

describe('dependencyOrder', () => {
  const t = (blockedBy: number[]) => ({ title: 'T', whatToBuild: '', acceptanceCriteria: [], blockedBy });

  test('blockers first, otherwise as listed', () => {
    assert.deepEqual(dependencyOrder([t([2]), t([]), t([]), t([0, 1])]), [1, 2, 0, 3]);
  });

  test('an index out of range, a ticket blocking itself, or a cycle is not usable', () => {
    assert.match((dependencyOrder([t([]), t([2])]) as { invalid: string }).invalid, /index 2, which is not in the breakdown/);
    assert.match((dependencyOrder([t([0.5])]) as { invalid: string }).invalid, /not in the breakdown/);
    assert.match((dependencyOrder([t([]), t([1])]) as { invalid: string }).invalid, /blocked by itself/);
    assert.match((dependencyOrder([t([]), t([2]), t([1])]) as { invalid: string }).invalid, /cycle, among tickets 2 \("T"\), 3/);
  });
});

describe('breakdownCriteria', () => {
  const spec = {
    domain: {
      terms: [
        { term: 'Greeting', definition: 'What learners see.', avoid: '' },
        { term: 'Tone', definition: 'How it sounds.', avoid: '' },
      ],
      adrs: [
        { title: 'Tones are optional', decision: 'Off by default.' },
        { title: 'Greetings are constants', decision: 'No table.' },
      ],
    },
  } as Parameters<typeof breakdownCriteria>[0];
  const ticket = (title: string, whatToBuild: string, acceptanceCriteria: string[], blockedBy: number[] = []) => ({
    title,
    whatToBuild,
    acceptanceCriteria,
    blockedBy,
  });

  test('each missing entry goes once, to the first ticket in dependency order that introduces it', () => {
    const tickets = [
      ticket('Play a tone', 'Tones are optional: a learner may turn one on.', ['A tone plays'], [1]),
      ticket('Show greetings', 'Learners see one on launch.', ['It shows'], []),
      ticket('Pick a tone', 'Choose which tone plays.', ['It is chosen'], [0]),
    ];
    assert.deepEqual(breakdownCriteria(spec, tickets, [1, 0, 2]), [
      ['A tone plays', 'Write the glossary term "Tone" (How it sounds.) into the domain glossary', 'Write the ADR "Tones are optional"'],
      // Mentioned by no ticket: the first in dependency order writes it.
      ['It shows', 'Write the glossary term "Greeting" (What learners see.) into the domain glossary', 'Write the ADR "Greetings are constants"'],
      ['It is chosen'],
    ]);
  });

  test('an entry a ticket already asks to write is not added anywhere', () => {
    const tickets = [ticket('A', '', ['Write ADR: Greetings are constants']), ticket('B Greeting tone', '', ['Add Greeting and Tone to the glossary'], [0])];
    assert.deepEqual(breakdownCriteria(spec, tickets, [0, 1]), [
      ['Write ADR: Greetings are constants', 'Write the ADR "Tones are optional"'],
      ['Add Greeting and Tone to the glossary'],
    ]);
  });
});

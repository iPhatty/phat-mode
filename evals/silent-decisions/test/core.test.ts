import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DoneReport, PlanReport } from '../../../src/agents.ts';
import { DEFAULT_LABELS } from '../../../src/config.ts';
import { commentMarker, type Issue } from '../../../src/github.ts';
import { needsInfoComment, planComment, type PullRequestDetails, pullRequestBody } from '../../../src/messages.ts';
import {
  parseFirstParentLog,
  pickPlanComment,
  recordedDepartures,
  recordedSilentDecisions,
  listDoneIssues,
  sample,
  type TicketRecord,
  windowOf,
} from '../core.ts';

const ISSUE: Issue = {
  number: 12,
  title: 'Thing',
  body: 'Build the thing.',
  author: 'owner',
  state: 'OPEN',
  url: 'https://github.com/o/r/issues/12',
  labels: [],
  comments: [],
  createdAt: '2026-10-31T10:00:00Z',
};

const PLAN: PlanReport = {
  decision: 'proceed',
  summary: 'Add the thing.',
  plan: ['Change src/x.ts'],
  established: [],
  questions: [],
  reason: '',
  seams: [{ interface: 'x()', catches: 'wrong x', misses: 'nothing' }],
  silentDecisions: [
    { question: 'Which order?', decision: 'Newest first.', why: 'Matches git log.' },
    { question: 'What when empty?', decision: 'Say so', why: '' },
  ],
};

/** One entry as `git log --name-status --format=%x00%H%x1f%h%x1f%cI%x1f%s` writes it. */
const entry = (sha: string, committedAt: string, subject: string, files: string[]) =>
  `\0${sha}\x1f${sha.slice(0, 7)}\x1f${committedAt}\x1f${subject}\n\n${files.join('\n')}\n`;

/** First-parent history, newest first, as git log writes it. */
const LOG = [
  entry('e'.repeat(40), '2026-11-04T10:00:00+00:00', 'After planning', ['A\tdocs/adr/0009-late.md']),
  entry('d'.repeat(40), '2026-11-03T12:00:00+01:00', 'Planning base', ['M\tGLOSSARY.md', 'M\tsrc/x.ts']),
  entry('c'.repeat(40), '2026-11-02T10:00:00+00:00', 'Contexts', [
    'A\tpackages/app/docs/adr/0002-nested.md',
    'M\tpackages/app/CONTEXT.md',
    'M\tdocs/adr/README.md',
    'M\tdocs/guide.md',
  ]),
  entry('b'.repeat(40), '2026-11-01T10:00:00+00:00', 'ADRs', [
    'M\tdocs/adr/0001-old.md',
    'R087\tdocs/adr/0003-draft.md\tdocs/adr/0003-renamed.md',
  ]),
  entry('a'.repeat(40), '2026-10-31T10:00:00+00:00', 'Written here', ['A\tdocs/adr/0000-before.md']),
].join('');

describe('windowOf', () => {
  const commits = parseFirstParentLog(LOG);
  // Written exactly when commit a was made; planned exactly when commit d was made (11:00Z).
  const window = windowOf(commits, '2026-10-31T10:00:00Z', '2026-11-03T11:00:00Z');

  test('the base commit is the newest first-parent commit made at or before planning', () => {
    assert.equal(window.baseCommit, 'd'.repeat(40));
  });

  test('the window excludes the commit made when the spec was written and includes the one made at planning, oldest first', () => {
    assert.deepEqual(
      window.commits.map((commit) => commit.subject),
      ['ADRs', 'Contexts', 'Planning base'],
    );
  });

  test('ADR and glossary changes are classified; ADR READMEs and other docs are left out', () => {
    assert.deepEqual(
      window.docChanges.map(({ path, kind, doc, subject }) => ({ path, kind, doc, subject })),
      [
        { path: 'docs/adr/0001-old.md', kind: 'changed', doc: 'adr', subject: 'ADRs' },
        { path: 'docs/adr/0003-renamed.md', kind: 'added', doc: 'adr', subject: 'ADRs' },
        { path: 'packages/app/docs/adr/0002-nested.md', kind: 'added', doc: 'adr', subject: 'Contexts' },
        { path: 'packages/app/CONTEXT.md', kind: 'changed', doc: 'glossary', subject: 'Contexts' },
        { path: 'GLOSSARY.md', kind: 'changed', doc: 'glossary', subject: 'Planning base' },
      ],
    );
  });

  test('no base commit when nothing was committed before planning', () => {
    assert.equal(windowOf(commits, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z').baseCommit, undefined);
  });
});

/** A comment as GitHub's REST API lists an issue's comments. */
const restComment = (login: string | null, body: string, createdAt = '2026-11-03T11:00:00Z', updatedAt = createdAt) => ({
  user: login === null ? null : { login },
  body,
  created_at: createdAt,
  updated_at: updatedAt,
});
const marked = (body: string) => `${commentMarker('plan')}\n${body}`;

describe('pickPlanComment', () => {
  test("picks phat-mode's own proceed plan, with when it was created and last updated", () => {
    const picked = pickPlanComment(
      [
        restComment('stranger', marked(planComment(PLAN)), '2026-11-02T00:00:00Z'),
        restComment('bot', 'Thanks!', '2026-11-02T01:00:00Z'),
        restComment(null, marked(planComment(PLAN)), '2026-11-02T02:00:00Z'),
        restComment('bot', marked(planComment(PLAN)), '2026-11-03T11:00:00Z', '2026-11-04T09:00:00Z'),
      ],
      'bot',
    );
    assert.deepEqual(
      picked && { createdAt: picked.createdAt, updatedAt: picked.updatedAt },
      { createdAt: '2026-11-03T11:00:00Z', updatedAt: '2026-11-04T09:00:00Z' },
    );
  });

  test('a stranger carrying the marker, or a hand-back left in the marked comment, is no plan', () => {
    const handBack = needsInfoComment({ ...PLAN, decision: 'needs_info', questions: ['Which?'] }, ISSUE, DEFAULT_LABELS);
    assert.equal(
      pickPlanComment([restComment('stranger', marked(planComment(PLAN))), restComment('bot', marked(handBack))], 'bot'),
      undefined,
    );
  });
});

describe('recordedSilentDecisions', () => {
  test('reads the decisions from the plan comment phat-mode writes', () => {
    assert.deepEqual(recordedSilentDecisions(marked(planComment(PLAN))), [
      { question: 'Which order?', decision: 'Newest first.', why: 'Matches git log.' },
      { question: 'What when empty?', decision: 'Say so', why: '' },
    ]);
  });

  test('a plan that says none were needed recorded an empty list', () => {
    const none = { ...PLAN, silentDecisions: [], noSilentDecisionsReason: 'The ticket settles everything.' };
    assert.deepEqual(recordedSilentDecisions(marked(planComment(none))), []);
  });

  test('a plan from before silent decisions existed recorded none', () => {
    const old = `${commentMarker('plan')}
🤖 **phat-mode is working on this.**

Add the thing.

**Plan**
- Change src/x.ts

**Test seams**
- \`x()\`: catches wrong x; misses nothing

I'll open a pull request when the checks pass and the review is done.`;
    assert.equal(recordedSilentDecisions(old), undefined);
  });
});

describe('recordedDepartures', () => {
  const details = (done: DoneReport): PullRequestDetails => ({
    issue: ISSUE,
    spec: { source: 'issue', author: 'owner', text: ISSUE.body, acceptanceCriteria: ['It works'], outOfScope: [], blockedBy: [] },
    plan: PLAN,
    done,
    pr: undefined,
    review: undefined,
    unresolved: false,
    checkCommand: 'npm run check',
  });

  test('reads the departures from the pull request description phat-mode writes', () => {
    const done: DoneReport = {
      summary: 'Done.',
      testing: 'Tests.',
      departures: [
        { decision: 'Newest first.', instead: 'Oldest first', why: 'The UI reads top-down.' },
        { decision: 'Say so', instead: 'Stay silent', why: '' },
      ],
    };
    assert.deepEqual(recordedDepartures(pullRequestBody(details(done))), [
      { decision: 'Newest first.', instead: 'Oldest first', why: 'The UI reads top-down.' },
      { decision: 'Say so', instead: 'Stay silent', why: '' },
    ]);
  });

  test('a description listing silent decisions but no departures recorded none departed from', () => {
    assert.deepEqual(recordedDepartures(pullRequestBody(details({ summary: 'Done.', testing: 'Tests.' }))), []);
  });

  test('a description from before silent decisions existed recorded nothing', () => {
    assert.equal(recordedDepartures('## Summary\n\nDone.\n\n## Evidence\n\n- Tests.\n\n---\nCloses #12'), undefined);
  });
});

describe('sample', () => {
  const record = (number: number, plannedAt: string, state: 'MERGED' | 'OPEN' | 'CLOSED' | null): TicketRecord => ({
    repo: 'o/r',
    number,
    title: `#${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    spec: { source: 'issue', author: 'owner', writtenAt: '2026-10-01T00:00:00Z' },
    plannedAt,
    plan: { createdAt: plannedAt, updatedAt: plannedAt, body: '' },
    bodyEditedAt: null,
    parent: null,
    pr: state === null ? null : { number: number + 100, state, mergeCommit: state === 'MERGED' ? 'f'.repeat(40) : null, url: '' },
    baseCommit: 'a'.repeat(40),
    window: { commits: [], docChanges: [] },
  });
  const records = [
    record(7, '2026-11-05T00:00:00Z', 'MERGED'),
    record(3, '2026-11-01T00:00:00Z', 'MERGED'),
    record(4, '2026-11-02T00:00:00Z', 'CLOSED'),
    record(5, '2026-11-03T00:00:00Z', 'MERGED'),
    record(6, '2026-11-04T00:00:00Z', null),
    record(9, '2026-11-06T00:00:00Z', 'MERGED'),
    record(8, '2026-11-05T12:00:00Z', 'MERGED'),
  ];
  const numbers = (picked: TicketRecord[]) => picked.map((ticket) => ticket.number);

  test('every Nth merged ticket, by issue number, starting with the first', () => {
    assert.deepEqual(numbers(sample(records, { every: 2 })), [3, 7, 9]);
  });

  test('all tickets planned in a window, from inclusive, to exclusive', () => {
    assert.deepEqual(numbers(sample(records, { from: '2026-11-02T00:00:00Z', to: '2026-11-05T12:00:00Z' })), [4, 5, 6, 7]);
  });

  test('chosen issues', () => {
    assert.deepEqual(numbers(sample(records, { issues: [9, 4, 42] })), [4, 9]);
  });
});

describe('listDoneIssues', () => {
  /** GitHub's REST issue listing, 100 per page: 230 items, every tenth a pull request (the listing includes them). */
  const items = Array.from({ length: 230 }, (_, index) => ({
    number: index + 1,
    ...(index % 10 === 9 ? { pull_request: { url: `https://api.github.com/repos/o/r/pulls/${index + 1}` } } : {}),
  }));
  const pages: number[] = [];
  const fetchPage = async (page: number) => {
    pages.push(page);
    return items.slice((page - 1) * 100, page * 100);
  };

  test('reads every page until a short one, and keeps issues only', async () => {
    const numbers = await listDoneIssues(fetchPage, 100);
    assert.deepEqual([pages, numbers.length, numbers.at(-1), numbers.includes(10)], [[1, 2, 3], 207, 229, false]);
  });

  test('stops at an empty page when the last full page was the end', async () => {
    const asked: number[] = [];
    const numbers = await listDoneIssues(async (page) => (asked.push(page), page === 1 ? [{ number: 1 }, { number: 2 }] : []), 2);
    assert.deepEqual([asked, numbers], [[1, 2], [1, 2]]);
  });
});

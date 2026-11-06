import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { DoneReport, PlanReport } from '../../../src/agents.ts';
import { run } from '../../../src/exec.ts';
import { commentMarker, type Issue } from '../../../src/github.ts';
import { planComment, pullRequestBody } from '../../../src/messages.ts';
import type { TicketRecord } from '../core.ts';
import { type GitHubReader, prepareTicket } from '../prepare.ts';

const PLAN: PlanReport = {
  decision: 'proceed',
  summary: 'Add the thing.',
  plan: ['Change src/x.ts'],
  established: [],
  questions: [],
  reason: '',
  seams: [{ interface: 'x()', catches: 'wrong x', misses: 'nothing' }],
  silentDecisions: [{ question: 'Which order?', decision: 'Newest first.', why: 'Matches git log.' }],
};
const DONE: DoneReport = {
  summary: 'Done.',
  testing: 'Tests.',
  departures: [{ decision: 'Newest first.', instead: 'Oldest first', why: 'Reads top-down.' }],
};
const ISSUE: Issue = {
  number: 12,
  title: 'Sort the list',
  body: 'Sort the list somehow.\n\n## Parent\n\n#3',
  author: 'owner',
  state: 'CLOSED',
  url: 'https://github.com/o/r/issues/12',
  labels: [],
  comments: [],
  createdAt: '2026-11-01T00:00:00Z',
};
const PR_BODY = pullRequestBody({
  issue: ISSUE,
  spec: { source: 'issue', author: 'owner', text: ISSUE.body, acceptanceCriteria: [], outOfScope: [], blockedBy: [] },
  plan: PLAN,
  done: DONE,
  pr: undefined,
  review: undefined,
  unresolved: false,
  checkCommand: 'npm run check',
});
const OLD_PLAN = `${commentMarker('plan')}
🤖 **phat-mode is working on this.**

Add the thing.

**Plan**
- Change src/x.ts

I'll open a pull request when the checks pass and the review is done.`;

/** GitHub as prepare reads it: issues #12 and #3, and pull request #40's description. */
/** `editedAt`: when GitHub says #12's body was last edited, as prepare reads it. */
const githubWith = (editedAt: string | null): GitHubReader => ({
  issue: async (number) =>
    ({
      12: { title: ISSUE.title, body: ISSUE.body, lastEditedAt: editedAt },
      3: { title: 'The big plan', body: 'Lists, everywhere.', lastEditedAt: null },
    })[number] ?? assert.fail(`no issue #${number}`),
  pullRequestBody: async (number) => (number === 40 ? PR_BODY : assert.fail(`no pull request #${number}`)),
});
const github = githubWith(null);

describe('prepareTicket', () => {
  let dir: string;
  let clone: string;
  let base: string;
  let merge: string;
  const git = (args: string[], cwd = clone) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

  const record = (change: Partial<TicketRecord> = {}): TicketRecord => ({
    repo: 'o/r',
    number: 12,
    title: ISSUE.title,
    url: ISSUE.url,
    spec: { source: 'brief', author: 'owner', writtenAt: '2026-11-01T00:00:00Z', brief: '## Agent Brief\n\nSort newest first.' },
    plannedAt: '2026-11-03T00:00:00Z',
    plan: { createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', body: `${commentMarker('plan')}\n${planComment(PLAN)}` },
    bodyEditedAt: null,
    parent: 3,
    pr: { number: 40, state: 'MERGED', mergeCommit: merge, url: 'https://github.com/o/r/pull/40' },
    baseCommit: base,
    window: { commits: [], docChanges: [] },
    ...change,
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phat-eval-'));
    clone = join(dir, 'clone');
    await run('git', ['init', '-b', 'main', clone]);
    await writeFile(join(clone, 'x.ts'), 'planned\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'base']);
    base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(clone, 'x.ts'), 'merged\n');
    await git(['commit', '-am', 'merged']);
    merge = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('the reviewer gets only the ticket and its parent; the judge gets the rest', async () => {
    const { dir: ticket } = await prepareTicket(record(), { clone, out: join(dir, 'out-1'), github });
    assert.equal(ticket, join(dir, 'out-1', 'o__r-12'));
    assert.deepEqual((await readdir(join(ticket, 'review'))).sort(), ['parent.md', 'ticket.md']);
    assert.deepEqual((await readdir(join(ticket, 'judge'))).sort(), [
      'departures.json',
      'merge-commit.txt',
      'plan.md',
      'pr.md',
      'silent-decisions.json',
      'window.json',
    ]);
    const ticketText = await readFile(join(ticket, 'review', 'ticket.md'), 'utf8');
    assert.match(ticketText, /Sort the list somehow\./);
    assert.match(ticketText, /Sort newest first\./);
    assert.match(await readFile(join(ticket, 'review', 'parent.md'), 'utf8'), /Lists, everywhere\./);
    assert.equal((await readFile(join(ticket, 'judge', 'merge-commit.txt'), 'utf8')).trim(), merge);
    assert.deepEqual(JSON.parse(await readFile(join(ticket, 'judge', 'silent-decisions.json'), 'utf8')), [
      { question: 'Which order?', decision: 'Newest first.', why: 'Matches git log.' },
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(ticket, 'judge', 'departures.json'), 'utf8')), [
      { decision: 'Newest first.', instead: 'Oldest first', why: 'Reads top-down.' },
    ]);
  });

  test('the worktree is a detached checkout of the planning base commit', async () => {
    const { dir: ticket } = await prepareTicket(record(), { clone, out: join(dir, 'out-2'), github });
    const worktree = join(ticket, 'worktree');
    assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim(), base);
    assert.equal((await run('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim(), '');
    assert.equal(await readFile(join(worktree, 'x.ts'), 'utf8'), 'planned\n');
  });

  test('a relative output folder holds the worktree too, with the clone elsewhere', async () => {
    const out = relative(process.cwd(), join(dir, 'out-6'));
    const { dir: ticket } = await prepareTicket(record(), { clone, out, github });
    assert.equal(ticket, join(dir, 'out-6', 'o__r-12'));
    assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: join(ticket, 'worktree') })).stdout.trim(), base);
    assert.equal(await readFile(join(ticket, 'worktree', 'x.ts'), 'utf8'), 'planned\n');
  });

  test('preparing a ticket again at another base commit checks the worktree out at the new one', async () => {
    const out = join(dir, 'out-7');
    await prepareTicket(record(), { clone, out, github });
    const { dir: ticket } = await prepareTicket(record({ baseCommit: merge }), { clone, out, github });
    const worktree = join(ticket, 'worktree');
    assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim(), merge);
    assert.equal((await run('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim(), '');
    assert.equal(JSON.parse(await readFile(join(ticket, 'meta.json'), 'utf8')).baseCommit, merge);
  });

  test('flags the body the reviewer gets when it was edited after planning, and a plan comment updated since, with a warning', async () => {
    // Collect saw no edit; the body was edited after collect ran, so only the body prepare fetches knows.
    const replanned = record({ bodyEditedAt: null, plan: { ...record().plan, updatedAt: '2026-11-05T00:00:00Z' } });
    const { dir: ticket, warnings } = await prepareTicket(replanned, {
      clone,
      out: join(dir, 'out-3'),
      github: githubWith('2026-11-04T00:00:00Z'),
    });
    const meta = JSON.parse(await readFile(join(ticket, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.bodyEditedAt, meta.bodyEditedAfterPlanning, meta.planReplanned], ['2026-11-04T00:00:00Z', true, true]);
    assert.equal(warnings.length, 2);
    const unflagged = await prepareTicket(record(), { clone, out: join(dir, 'out-4'), github: githubWith('2026-11-02T00:00:00Z') });
    const unflaggedMeta = JSON.parse(await readFile(join(unflagged.dir, 'meta.json'), 'utf8'));
    assert.deepEqual([unflaggedMeta.bodyEditedAfterPlanning, unflaggedMeta.planReplanned, unflagged.warnings], [false, false, []]);
  });

  test('a run from before silent decisions gets no decisions or departures files, and no parent leaves none out', async () => {
    const oldRun = record({ parent: null, plan: { ...record().plan, body: OLD_PLAN } });
    const oldGithub: GitHubReader = { ...github, pullRequestBody: async () => '## Summary\n\nDone.\n\n---\nCloses #12' };
    const { dir: ticket } = await prepareTicket(oldRun, { clone, out: join(dir, 'out-5'), github: oldGithub });
    assert.deepEqual(await readdir(join(ticket, 'review')), ['ticket.md']);
    assert.deepEqual((await readdir(join(ticket, 'judge'))).sort(), ['merge-commit.txt', 'plan.md', 'pr.md', 'window.json']);
    const meta = JSON.parse(await readFile(join(ticket, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.silentDecisionsRecorded, meta.departuresRecorded], [false, false]);
  });
});

describe('prepareTicket again into the same folder', () => {
  let dir: string;
  let clone: string;
  let base: string;
  const git = (args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: clone });
  const record = (change: Partial<TicketRecord> = {}): TicketRecord => ({
    repo: 'o/r',
    number: 12,
    title: ISSUE.title,
    url: ISSUE.url,
    spec: { source: 'issue', author: 'owner', writtenAt: '2026-11-01T00:00:00Z' },
    plannedAt: '2026-11-03T00:00:00Z',
    plan: { createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', body: `${commentMarker('plan')}\n${planComment(PLAN)}` },
    bodyEditedAt: null,
    parent: 3,
    pr: { number: 40, state: 'MERGED', mergeCommit: base, url: 'https://github.com/o/r/pull/40' },
    baseCommit: base,
    window: { commits: [], docChanges: [] },
    ...change,
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phat-eval-again-'));
    clone = join(dir, 'clone');
    await run('git', ['init', '-b', 'main', clone]);
    await writeFile(join(clone, 'x.ts'), 'planned\n');
    await git(['add', '.']);
    await git(['commit', '-m', 'base']);
    base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('inputs the new record no longer has are gone', async () => {
    const out = join(dir, 'out-1');
    await prepareTicket(record(), { clone, out, github });
    const { dir: ticket } = await prepareTicket(record({ parent: null, pr: null, plan: { ...record().plan, body: OLD_PLAN } }), {
      clone,
      out,
      github,
    });
    assert.deepEqual(await readdir(join(ticket, 'review')), ['ticket.md']);
    assert.deepEqual((await readdir(join(ticket, 'judge'))).sort(), ['plan.md', 'window.json']);
  });

  test('a folder already reviewed or judged is refused, and its evaluation kept', async () => {
    const out = join(dir, 'out-2');
    const { dir: ticket } = await prepareTicket(record(), { clone, out, github });
    await writeFile(join(ticket, 'gaps.md'), '### G1\n');
    await assert.rejects(prepareTicket(record({ parent: null }), { clone, out, github }), /already evaluated.*gaps\.md/);
    assert.equal(await readFile(join(ticket, 'gaps.md'), 'utf8'), '### G1\n');
    assert.deepEqual((await readdir(join(ticket, 'review'))).sort(), ['parent.md', 'ticket.md']);
  });
});

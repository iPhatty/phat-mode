import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type FauxResponseFactory, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { setToolLogger } from '../src/agents.ts';
import { cleanWorkspaces, describeRemoval, formatSize } from '../src/cleanup.ts';
import { paths } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { scratchFor } from '../src/workspace.ts';
import { call, fixture } from './fixture.ts';

const context = BACKGROUND_CONTEXT;
setToolLogger(silentLogger);

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const report = (decision: string, fields: Record<string, unknown> = {}) =>
  call('report_plan', {
    decision,
    summary: 'Add a hello file.',
    plan: [],
    established: [],
    questions: [],
    reason: '',
    notes: '',
    seams: [],
    noSeamsReason: '',
    silentDecisions: [],
    noSilentDecisionsReason: '',
    ...fields,
  });
/** The planner hands the issue back: a build that ends after its workspace was made. */
const planNeedsInfo = () => report('needs_info', { established: ['It is a text file'], questions: ['Which folder should hello.txt go in?'] });
const planNeedsHuman = () => report('needs_human', { reason: 'Needs a design decision.' });
const triage = (decision = 'proceed', fields: Record<string, unknown> = {}) =>
  call('report_triage', { decision, summary: 'Greet learners.', findings: 'None yet.', established: [], questions: [], reason: '', ...fields });
/** A shaping run that shapes the issue into one ticket. */
const shapedIntoOneTicket = () => [
  triage(),
  call('report_questions', { frontierEmpty: true, questions: [] }),
  call('report_shape_spec', {
    problemStatement: 'Learners open the app to silence.',
    solution: 'They are greeted.',
    userStories: ['As a learner, I want a greeting, so that I feel welcome'],
    implementationDecisions: ['The greeting is a constant'],
    testingDecisions: ['Test the greeting'],
    outOfScope: [],
    furtherNotes: '',
    assumptions: [],
    domain: { terms: [], adrs: [] },
  }),
  call('report_tickets', { tickets: [{ title: 'Greet', whatToBuild: 'Greet.', acceptanceCriteria: ['Greets'], blockedBy: [] }] }),
];
const planProceed = () =>
  report('proceed', {
    plan: ['Create hello.txt'],
    seams: [{ interface: 'hello.txt', catches: 'its content', misses: 'nothing else' }],
    silentDecisions: [{ question: 'A trailing newline?', decision: 'Yes.', why: 'Every file has one.' }],
  });

/** Clean the fixture's project, with its own durable store, and close it. */
async function clean(f: Awaited<ReturnType<typeof fixture>>, options: { dryRun?: boolean; issue?: number } = {}) {
  const { phat } = await f.open([]);
  try {
    return await cleanWorkspaces(phat, { github: f.github, workspaces: f.services.workspaces }, context, options);
  } finally {
    await phat.close(context);
  }
}

describe('cleanWorkspaces', () => {
  test('a closed issue whose build run ended: its workspace and scratch folder are removed, with their size', async () => {
    const f = await fixture();
    f.github.addIssue(9);
    const { outcome } = await f.runIssue(9, [planNeedsInfo()]);
    assert.equal(outcome.status, 'completed');
    const workspace = paths.workspace(f.config, 9);
    assert.ok(await exists(scratchFor(workspace)));
    f.github.issues.get(9)!.state = 'CLOSED';

    const report = await clean(f);

    assert.equal(report.removed.length, 1);
    const [removal] = report.removed;
    assert.equal(removal!.issue, 9);
    assert.equal(removal!.kind, 'build');
    assert.deepEqual(removal!.paths, [workspace, scratchFor(workspace)]);
    assert.ok(removal!.bytes > 0);
    assert.equal(await exists(workspace), false);
    assert.equal(await exists(scratchFor(workspace)), false);
  });

  test('an open issue: its workspace stays, whatever its run did', async () => {
    const f = await fixture();
    f.github.addIssue(9);
    await f.runIssue(9, [planNeedsInfo()]);

    const report = await clean(f);

    assert.deepEqual(report.removed, []);
    assert.ok(await exists(paths.workspace(f.config, 9)));
    assert.ok(await exists(scratchFor(paths.workspace(f.config, 9))));
  });

  test('a closed issue whose run is unfinished: kept, and the run can still be resumed in it', async () => {
    const f = await fixture();
    f.github.addIssue(9);
    // The implementer's first request hangs until the process "dies": the run stops mid-implement, resumable.
    let reachedImplement!: () => void;
    const implementStarted = new Promise<void>((resolve) => (reachedImplement = resolve));
    const hang: FauxResponseFactory = (_request, options) =>
      new Promise((_resolve, reject) => {
        reachedImplement();
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const first = await f.open([planProceed(), hang]);
    const { taskId } = await first.phat.start({ repo: f.config.repo, issue: 9 }, context);
    first.phat.harness.resume();
    await implementStarted;
    await first.phat.close(context);
    f.github.issues.get(9)!.state = 'CLOSED';

    const cleaned = await clean(f);

    assert.deepEqual(cleaned.removed, []);
    const workspace = paths.workspace(f.config, 9);
    assert.ok(await exists(join(workspace, '.git')));
    assert.ok(await exists(scratchFor(workspace)));
    const second = await f.open([]);
    const again = await second.phat.start({ repo: f.config.repo, issue: 9 }, context);
    await second.phat.close(context);
    assert.deepEqual(again, { taskId, resumed: true });
  });

  test('a shaping run that shaped the issue: its checkout is removed, with the issue still open', async () => {
    const f = await fixture();
    f.github.addIssue(20, { labels: ['agent-mode'] });
    const { outcome } = await f.runIssue(20, shapedIntoOneTicket(), 'shape');
    assert.equal((outcome as { result?: { status: string } }).result?.status, 'shaped');
    const checkout = paths.shapeWorkspace(f.config, 20);
    assert.ok(await exists(checkout));

    const cleaned = await clean(f);

    assert.deepEqual(cleaned.removed.map(({ issue, kind, paths }) => ({ issue, kind, paths })), [{ issue: 20, kind: 'shape', paths: [checkout] }]);
    assert.equal(await exists(checkout), false);
    assert.equal(f.github.issues.get(20)!.state, 'OPEN');
  });

  for (const [ending, responses] of [
    ['handed back (needs_info)', () => [triage('needs_info', { questions: ['Greet with what?'] })]],
    ['failed', () => [fauxAssistantMessage('Looks fine.'), fauxAssistantMessage('Looks fine.')]],
  ] as const) {
    test(`a shaping run that ${ending}: its checkout stays while the issue is open, and goes once it is closed`, async () => {
      const f = await fixture();
      f.github.addIssue(21, { labels: ['agent-mode'] });
      await f.runIssue(21, responses(), 'shape');
      const checkout = paths.shapeWorkspace(f.config, 21);

      assert.deepEqual((await clean(f)).removed, []);
      assert.ok(await exists(checkout));

      f.github.issues.get(21)!.state = 'CLOSED';
      assert.deepEqual((await clean(f)).removed.map((removal) => removal.kind), ['shape']);
      assert.equal(await exists(checkout), false);
    });
  }

  for (const [ending, responses, status] of [
    ['handed back (needs_human)', () => [planNeedsHuman()], 'completed'],
    ['failed', () => [fauxAssistantMessage('Looks fine.'), fauxAssistantMessage('Looks fine.')], 'failed'],
  ] as const) {
    test(`a build that ${ending}: its workspace stays while the issue is open, and goes once it is closed`, async () => {
      const f = await fixture();
      f.github.addIssue(12);
      const { outcome } = await f.runIssue(12, responses());
      assert.equal(outcome.status, status);
      const workspace = paths.workspace(f.config, 12);

      assert.deepEqual((await clean(f)).removed, []);
      assert.ok(await exists(workspace));

      f.github.issues.get(12)!.state = 'CLOSED';
      assert.deepEqual((await clean(f)).removed.map((removal) => removal.kind), ['build']);
      assert.equal(await exists(workspace), false);
    });
  }

  test('the issue option: only that issue’s folders are looked at', async () => {
    const f = await fixture();
    for (const issue of [9, 10]) {
      f.github.addIssue(issue);
      await f.runIssue(issue, [planNeedsInfo()]);
      f.github.issues.get(issue)!.state = 'CLOSED';
    }

    const cleaned = await clean(f, { issue: 10 });

    assert.deepEqual(cleaned.removed.map((removal) => removal.issue), [10]);
    assert.ok(await exists(paths.workspace(f.config, 9)));
    assert.equal(await exists(paths.workspace(f.config, 10)), false);
  });

  test('folders with other names are listed and left alone; the "before" checkout is neither listed nor touched', async () => {
    const f = await fixture();
    const base = await f.services.workspaces.prepareBase();
    const root = join(f.config.home, 'workspaces', 'test__repo');
    await mkdir(join(root, 'notes'));
    await writeFile(join(root, 'notes', 'keep.txt'), 'mine\n');

    const cleaned = await clean(f);

    assert.deepEqual(cleaned, { removed: [], unknown: ['notes'], errors: [] });
    assert.equal(await readFile(join(root, 'notes', 'keep.txt'), 'utf8'), 'mine\n');
    assert.ok(await exists(join(base, 'README.md')));
  });

  test('dryRun: the same plan, with sizes, and nothing removed', async () => {
    const f = await fixture();
    f.github.addIssue(9);
    await f.runIssue(9, [planNeedsInfo()]);
    f.github.issues.get(9)!.state = 'CLOSED';

    const planned = await clean(f, { dryRun: true });

    assert.deepEqual(planned.removed.map(({ issue, kind }) => ({ issue, kind })), [{ issue: 9, kind: 'build' }]);
    assert.ok(planned.removed[0]!.bytes > 0);
    assert.ok(await exists(paths.workspace(f.config, 9)));
    assert.ok(await exists(scratchFor(paths.workspace(f.config, 9))));
    assert.deepEqual((await clean(f)).removed.map(({ paths }) => paths), planned.removed.map(({ paths }) => paths));
  });

  test('an issue GitHub cannot tell about is left alone and reported; the others are cleaned', async () => {
    const f = await fixture();
    f.github.addIssue(9);
    await f.runIssue(9, [planNeedsInfo()]);
    f.github.issues.get(9)!.state = 'CLOSED';
    await f.services.workspaces.prepare(30); // No issue #30 on the fake GitHub: getIssue throws.

    const cleaned = await clean(f);

    assert.deepEqual(cleaned.removed.map((removal) => removal.issue), [9]);
    assert.deepEqual(cleaned.errors, [{ issue: 30, message: 'no issue 30' }]);
    assert.ok(await exists(paths.workspace(f.config, 30)));
  });

  test('report lines: what went and how big it was', () => {
    const MB = 1024 * 1024;
    assert.equal(describeRemoval({ issue: 72, kind: 'build', paths: [], bytes: 785 * MB }), '#72: removed workspace (785 MB)');
    assert.equal(describeRemoval({ issue: 75, kind: 'shape', paths: [], bytes: 1536 * MB }), '#75: removed shaping checkout (1.5 GB)');
    assert.equal(describeRemoval({ issue: 72, kind: 'build', paths: [], bytes: 785 * MB }, true), '#72: would remove workspace (785 MB)');
    assert.equal(formatSize(300 * 1024), '300 KB');
  });
});

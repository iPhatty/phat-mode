import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { type FauxResponseFactory, type FauxResponseStep, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { setToolLogger } from '../src/agents.ts';
import { paths } from '../src/config.ts';
import { openPhatMode, type RunKind } from '../src/harness.ts';
import { finishInterrupted, projectStatus, resumeOnce, retireLegacyState, takeProjects, takenOver, watchedBy } from '../src/projects.ts';
import { type Doing, LockedError, readLock } from '../src/lock.ts';
import { silentLogger } from '../src/log.ts';
import { call, fixture, textOf } from './fixture.ts';

const context = BACKGROUND_CONTEXT;
setToolLogger(silentLogger);

const LOCK_MODULE = resolve(import.meta.dirname, '../src/lock.ts');
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill('SIGKILL');
});

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Another node process that takes the lock at `path` with `command`, and keeps it until killed. */
async function holder(path: string, command: string): Promise<{ pid: number; stop(): Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  const script = `${path}.child-${Date.now()}.ts`;
  await writeFile(
    script,
    `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
await acquireLock(${JSON.stringify(path)}, ${JSON.stringify(command)});
console.log('locked');
setInterval(() => {}, 1000);
`,
  );
  const proc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(proc);
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (chunk) => String(chunk).includes('locked') && resolve());
    proc.on('exit', (code) => reject(new Error(`child exited with ${code}`)));
  });
  return {
    pid: proc.pid!,
    async stop() {
      proc.kill('SIGKILL');
      await exited;
    },
  };
}

const plan = (decision: 'proceed' | 'needs_info', questions: string[] = []) =>
  call('report_plan', {
    decision,
    summary: 'Add a hello file.',
    plan: decision === 'proceed' ? ['Create hello.txt'] : [],
    established: [],
    questions,
    reason: '',
    notes: '',
    seams: decision === 'proceed' ? [{ interface: 'hello.txt', catches: 'its content', misses: 'nothing else' }] : [],
    noSeamsReason: '',
  });

/** A model response that never comes, until the run is aborted or closed. `reached`: resolves when it is asked. */
function hanging() {
  let reached!: () => void;
  const asked = new Promise<void>((resolve) => (reached = resolve));
  const hang: FauxResponseFactory = (_request, options) =>
    new Promise((_resolve, reject) => {
      reached();
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { hang, asked };
}

/** Wait until `check` holds (it settles asynchronously), or fail after a while. */
async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`never: ${what}`);
}

describe('one lock and one database per project', () => {
  test('a project held by another process is refused, naming its pid and command, and its storage is never opened', async () => {
    const { config } = await fixture({}, 'test/b');
    const other = await holder(paths.projectLock(config.home, 'test/a'), 'phat-mode watch test/a');
    try {
      let opened = 0;
      await assert.rejects(
        openPhatMode({ home: config.home, repo: 'test/a', servicesFor: async () => assert.fail('no services') }, context, {
          storage: async () => {
            opened++;
            throw new Error('storage opened');
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof LockedError);
          assert.match(error.message, new RegExp(`^test/a is held by pid ${other.pid} \\(\`phat-mode watch test/a\``));
          return true;
        },
      );
      assert.equal(opened, 0);
    } finally {
      await other.stop();
    }
  });

  test('run and abort work on a free project while another process holds a different one', async () => {
    const { config, github, open } = await fixture({}, 'test/b');
    const other = await holder(paths.projectLock(config.home, 'test/a'), 'phat-mode watch test/a');
    try {
      github.addIssue(4);
      const { hang, asked } = hanging();
      const { phat } = await open([hang]);
      assert.equal((await readLock(paths.projectLock(config.home, 'test/b')))?.pid, process.pid);
      const { taskId } = await phat.start({ repo: 'test/b', issue: 4 }, context);
      phat.harness.resume();
      await asked;
      await phat.harness.abortTask(taskId, context);
      assert.equal((await phat.harness.waitForTask(taskId, context)).state.outcome.status, 'aborted');
      await phat.close(context);
      assert.equal((await readLock(paths.projectLock(config.home, 'test/a')))?.pid, other.pid, 'the other lock is untouched');
    } finally {
      await other.stop();
    }
  });

  test('a lock left by a dead process is taken over', async () => {
    const { config, open } = await fixture({}, 'test/b');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode run test/b#1');
    await other.stop();
    const { phat } = await open([]);
    assert.equal((await readLock(paths.projectLock(config.home, 'test/b')))?.pid, process.pid);
    await phat.close(context);
  });

  test('a run only starts on the project that was opened', async () => {
    const { config, open } = await fixture({}, 'test/b');
    const { phat } = await open([]);
    try {
      await assert.rejects(phat.start({ repo: 'test/a', issue: 1 }, context), /test\/b/);
    } finally {
      await phat.close(context);
    }
    assert.equal(config.repo, 'test/b');
  });

  test('the lock file shows the run’s issue, kind and phase as it moves on, and nothing once it ends', async () => {
    const { config, github, open } = await fixture({}, 'test/b');
    const lockPath = paths.projectLock(config.home, 'test/b');
    github.addIssue(7);
    const seen: (Doing | undefined)[] = [];
    const look: FauxResponseFactory = async () => {
      seen.push((await readLock(lockPath))?.doing);
      return plan('proceed');
    };
    const { hang, asked } = hanging();
    const { phat } = await open([look, hang]);
    const { taskId } = await phat.start({ repo: 'test/b', issue: 7 }, context);
    phat.harness.resume();
    await asked;
    seen.push((await readLock(lockPath))?.doing);
    assert.deepEqual(seen, [
      { issue: 7, kind: 'build', phase: 'plan' },
      { issue: 7, kind: 'build', phase: 'implement' },
    ]);
    await phat.harness.abortTask(taskId, context);
    await phat.harness.waitForTask(taskId, context);
    await eventually(async () => (await readLock(lockPath))?.doing === undefined, 'doing cleared');
    assert.equal((await readLock(lockPath))?.pid, process.pid, 'still held, idle');
    await phat.close(context);
  });

  test('a shaping run shows kind shape', async () => {
    const { config, github, open } = await fixture({}, 'test/b');
    const lockPath = paths.projectLock(config.home, 'test/b');
    github.addIssue(8, { labels: ['agent-mode'] });
    const { hang, asked } = hanging();
    const { phat } = await open([hang]);
    const { taskId } = await phat.start({ repo: 'test/b', issue: 8 }, context, 'shape');
    phat.harness.resume();
    await asked;
    assert.deepEqual((await readLock(lockPath))?.doing, { issue: 8, kind: 'shape', phase: 'triage' });
    await phat.harness.abortTask(taskId, context);
    await phat.harness.waitForTask(taskId, context);
    await phat.close(context);
  });
});


function fauxModels(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-grill' }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Run an issue to its end in `storage`. */
async function finishRun(fx: Fixture, issue: number, storage: () => ReturnType<typeof openNodeSqliteStorage>, lock?: false) {
  fx.github.addIssue(issue);
  const phat = await openPhatMode({ home: fx.config.home, repo: fx.config.repo, servicesFor: async () => fx.services }, context, {
    storage,
    lock,
    models: fauxModels([plan('needs_info', ['Which folder?'])]),
  });
  const { taskId } = await phat.start({ repo: fx.config.repo, issue }, context);
  phat.harness.resume();
  await phat.harness.waitForTask(taskId, context);
  await phat.close(context);
}

/** Start a run in `storage` and stop before it does anything, as an interrupted run is left. */
async function leaveRun(fx: Fixture, repo: string, issue: number, kind: RunKind, storage: () => ReturnType<typeof openNodeSqliteStorage>, lock?: false) {
  const phat = await openPhatMode({ home: fx.config.home, repo, servicesFor: async () => fx.services }, context, {
    storage,
    lock,
    models: fauxModels([]),
  });
  await phat.start({ repo, issue }, context, kind);
  await phat.close(context);
}

describe('projectStatus', () => {
  test('a project another process holds: what its lock file says, without opening its database', async () => {
    const fx = await fixture({}, 'test/a');
    const home = fx.config.home;
    await mkdir(paths.stateDir(home), { recursive: true });
    // Not a database: opening it would fail.
    await writeFile(paths.projectState(home, 'test/a'), 'garbage, not sqlite');
    const other = await holder(paths.projectLock(home, 'test/a'), 'phat-mode watch test/a');
    try {
      const status = await projectStatus(home, 'test/a', context);
      assert.ok('held' in status);
      assert.equal(status.held.pid, other.pid);
      assert.equal(status.held.command, 'phat-mode watch test/a');
    } finally {
      await other.stop();
    }
  });

  test('a free project: its runs, newest state of each issue', async () => {
    const fx = await fixture({}, 'test/a');
    const home = fx.config.home;
    const storage = () => openNodeSqliteStorage(paths.projectState(home, 'test/a'));
    await mkdir(paths.stateDir(home), { recursive: true });
    await finishRun(fx, 1, storage);
    await leaveRun(fx, 'test/a', 2, 'shape', storage);
    assert.deepEqual(await projectStatus(home, 'test/a', context), {
      runs: [
        { key: 'test/a#1', status: 'building: ❓ The spec has gaps. phat-mode posted triage notes and moved the issue to needs-info.' },
        { key: 'test/a#2', status: 'shaping: pending (prepare), run `phat-mode resume` to continue' },
      ],
    });
    assert.equal(await readLock(paths.projectLock(home, 'test/a')), undefined, 'the lock is released again');
  });

  test('a project with no database: no runs, and no database created', async () => {
    const fx = await fixture({}, 'test/a');
    assert.deepEqual(await projectStatus(fx.config.home, 'test/c', context), { runs: [] });
    assert.equal(await exists(paths.projectState(fx.config.home, 'test/c')), false);
  });
});

describe('retiring the shared database', () => {
  test('none there: nothing to do', async () => {
    const fx = await fixture({}, 'test/a');
    assert.deepEqual(await retireLegacyState(fx.config.home, context), { status: 'none' });
  });

  test('only finished runs: archived to state.sqlite.legacy', async () => {
    const fx = await fixture({}, 'test/a');
    const home = fx.config.home;
    await finishRun(fx, 1, () => openNodeSqliteStorage(paths.legacyState(home)), false);
    assert.deepEqual(await retireLegacyState(home, context), { status: 'archived' });
    assert.equal(await exists(paths.legacyState(home)), false);
    assert.equal(await exists(`${paths.legacyState(home)}.legacy`), true);
    assert.equal(await exists(paths.legacyLock(home)), false);
    assert.deepEqual(await retireLegacyState(home, context), { status: 'none' }, 'once only');
  });

  for (const [what, content] of [['empty', ''], ['truncated', '{"pid": 12']] as const) {
    test(`a lock (${what}) left by an earlier version that crashed: taken over, and the database archived`, async () => {
      const fx = await fixture({}, 'test/a');
      const home = fx.config.home;
      await finishRun(fx, 1, () => openNodeSqliteStorage(paths.legacyState(home)), false);
      await writeFile(paths.legacyLock(home), content);
      assert.deepEqual(await retireLegacyState(home, context), { status: 'archived' });
      assert.equal(await exists(paths.legacyLock(home)), false);
    });
  }

  test('unfinished runs: listed with project, issue, kind and phase, and the database is left where it is', async () => {
    const fx = await fixture({}, 'test/a');
    const home = fx.config.home;
    const storage = () => openNodeSqliteStorage(paths.legacyState(home));
    await finishRun(fx, 1, storage, false);
    // The old layout: every project's runs in one database.
    await leaveRun(fx, 'test/a', 3, 'build', storage, false);
    await leaveRun(fx, 'test/b', 4, 'shape', storage, false);
    assert.deepEqual(await retireLegacyState(home, context), {
      status: 'unfinished',
      runs: [
        { repo: 'test/a', issue: 3, kind: 'build', phase: 'prepare' },
        { repo: 'test/b', issue: 4, kind: 'shape', phase: 'prepare' },
      ],
    });
    assert.equal(await exists(paths.legacyState(home)), true);
    assert.equal(await exists(`${paths.legacyState(home)}.legacy`), false);
  });

  test('an old phat-mode still using it: refused, naming it', async () => {
    const fx = await fixture({}, 'test/a');
    const home = fx.config.home;
    await finishRun(fx, 1, () => openNodeSqliteStorage(paths.legacyState(home)), false);
    // Earlier versions' lock: a plain file, naming a live process.
    await writeFile(paths.legacyLock(home), JSON.stringify({ pid: process.pid, token: 'old', command: 'phat-mode watch', startedAt: 0 }));
    try {
      await assert.rejects(retireLegacyState(home, context), (error: unknown) => {
        assert.ok(error instanceof LockedError);
        assert.match(error.message, /`phat-mode watch`/);
        return true;
      });
      assert.equal(await exists(paths.legacyState(home)), true);
      assert.equal(JSON.parse(await readFile(paths.legacyLock(home), 'utf8')).token, 'old', 'its lock left alone');
    } finally {
      await rm(paths.legacyLock(home));
    }
  });
});

describe('finishing interrupted runs, one project after another (watch)', () => {
  test('interrupted runs in two projects: the second project’s run starts only once the first one’s has settled', async () => {
    const a = await fixture({}, 'test/a');
    const b = await fixture({}, 'test/b');
    a.github.addIssue(1);
    b.github.addIssue(2);
    // Both left interrupted: started, never resumed.
    for (const [fx, issue] of [[a, 1], [b, 2]] as const) {
      const { phat } = await fx.open([]);
      await phat.start({ repo: fx.config.repo, issue }, context);
      await phat.close(context);
    }
    const events: string[] = [];
    const planner = (repo: string): FauxResponseFactory => async () => {
      events.push(`${repo} plans`);
      // Long enough for the other project's run to get here too, if it were running.
      await new Promise((resolve) => setTimeout(resolve, 400));
      events.push(`${repo} done`);
      return plan('needs_info', ['Which folder?']);
    };
    const first = await a.open([planner('test/a')]);
    const second = await b.open([planner('test/b')]);
    const settled: string[] = [];
    const count = await finishInterrupted([first.phat, second.phat], context, async (phat, key, taskId) => {
      const { outcome } = (await phat.harness.waitForTask(taskId, context)).state;
      settled.push(`${key} ${outcome.status}`);
    });
    await first.phat.close(context);
    await second.phat.close(context);
    assert.equal(count, 2);
    assert.deepEqual(events, ['test/a plans', 'test/a done', 'test/b plans', 'test/b done']);
    assert.deepEqual(settled, ['test/a#1 completed', 'test/b#2 completed']);
  });

  test('two interrupted runs in one project: one runs at a time', async () => {
    const fx = await fixture({}, 'test/a');
    fx.github.addIssue(1);
    fx.github.addIssue(2);
    // Both left interrupted, e.g. `run 1` stopped with Ctrl-C, then `run 2` stopped too.
    {
      const { phat } = await fx.open([]);
      await phat.start({ repo: 'test/a', issue: 1 }, context);
      await phat.start({ repo: 'test/a', issue: 2 }, context);
      await phat.close(context);
    }
    const events: string[] = [];
    const planner: FauxResponseFactory = async (request) => {
      const issue = /<issue number="(\d+)"/.exec(request.messages.map(textOf).join('\n'))?.[1] ?? '?';
      events.push(`start ${issue}`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      events.push(`finish ${issue}`);
      return plan('needs_info', ['Which folder?']);
    };
    const { phat } = await fx.open([planner, planner]);
    const settled: string[] = [];
    const count = await finishInterrupted([phat], context, async (phat, key, taskId) => {
      settled.push(`${key} ${(await phat.harness.waitForTask(taskId, context)).state.outcome.status}`);
    });
    await phat.close(context);
    assert.equal(count, 2);
    assert.deepEqual(settled.sort(), ['test/a#1 completed', 'test/a#2 completed']);
    // Whichever goes first, the other starts only once it has finished.
    assert.equal(events.length, 4);
    assert.equal(events[1], events[0]!.replace('start', 'finish'), events.join(', '));
  });

  test('a run waiting for its turn can be aborted, and closing does not wait for it', async () => {
    const fx = await fixture({}, 'test/a');
    fx.github.addIssue(1);
    fx.github.addIssue(2);
    const { hang, asked } = hanging();
    const { phat } = await fx.open([hang]);
    const first = await phat.start({ repo: 'test/a', issue: 1 }, context);
    resumeOnce(phat);
    await asked;
    const second = await phat.start({ repo: 'test/a', issue: 2 }, context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await phat.harness.abortTask(second.taskId, context);
    assert.equal((await phat.harness.waitForTask(second.taskId, context)).state.outcome.status, 'aborted');
    const record = await phat.harness.getTask(first.taskId, context);
    assert.notEqual(record?.state.status, 'terminal', 'the first one is still going');
    await phat.close(context);
  });
});

describe('a watch takes the free projects in its list and skips held ones (takeProjects)', () => {
  /** Open a project as `phat-mode watch` does, taking its lock (LockedError when another process holds it). */
  const takeIn = (home: string) => (repo: string) =>
    openPhatMode({ home, repo, servicesFor: async () => assert.fail('no services') }, context, {
      lock: { command: 'phat-mode watch' },
      models: fauxModels([]),
    });

  test('a free project is held and a held one is skipped, naming its holder', async () => {
    const { config } = await fixture({}, 'test/a');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch test/b');
    const projects = await takeProjects(['test/a', 'test/b'], takeIn(config.home));
    try {
      assert.deepEqual(projects.held().map((phat) => phat.repo), ['test/a']);
      assert.ok(projects.get('test/a'));
      assert.equal(projects.get('test/b'), undefined);
      const skipped = projects.skipped.get('test/b');
      assert.equal(skipped?.pid, other.pid);
      assert.equal(skipped?.command, 'phat-mode watch test/b');
      assert.equal(watchedBy('test/b', skipped!), `test/b is watched by pid ${other.pid} (phat-mode watch test/b)`);
    } finally {
      await projects.close(context);
      await other.stop();
    }
  });

  test('when every project is held, none is held and each is skipped', async () => {
    const { config } = await fixture({}, 'test/a');
    const a = await holder(paths.projectLock(config.home, 'test/a'), 'phat-mode watch');
    const b = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch');
    const projects = await takeProjects(['test/a', 'test/b'], takeIn(config.home));
    try {
      assert.deepEqual(projects.held(), []);
      assert.deepEqual([...projects.skipped.keys()], ['test/a', 'test/b']);
    } finally {
      await projects.close(context);
      await a.stop();
      await b.stop();
    }
  });

  test('once its holder has exited, a skipped project is taken over on retake, naming the previous holder', async () => {
    const { config } = await fixture({}, 'test/a');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch test/b');
    const projects = await takeProjects(['test/b', 'test/a'], takeIn(config.home));
    try {
      await other.stop();
      const taken = await projects.retake();
      assert.deepEqual(
        taken.map(({ repo, phat, previous }) => ({ repo, phat: phat.repo, pid: previous.pid })),
        [{ repo: 'test/b', phat: 'test/b', pid: other.pid }],
      );
      assert.equal(takenOver('test/b', taken[0]!.previous), `Now watching test/b: pid ${other.pid} (phat-mode watch test/b) has stopped.`);
      assert.deepEqual(projects.held().map((phat) => phat.repo), ['test/b', 'test/a']);
      assert.equal(projects.skipped.size, 0);
      assert.equal((await readLock(paths.projectLock(config.home, 'test/b')))?.pid, process.pid);
    } finally {
      await projects.close(context);
    }
  });

  test('while its holder is alive, a skipped project is not taken on retake, and its lock is untouched', async () => {
    const { config } = await fixture({}, 'test/a');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch test/b');
    const projects = await takeProjects(['test/a', 'test/b'], takeIn(config.home));
    try {
      assert.deepEqual(await projects.retake(), []);
      assert.deepEqual(projects.held().map((phat) => phat.repo), ['test/a']);
      assert.equal(projects.skipped.get('test/b')?.pid, other.pid);
      assert.equal((await readLock(paths.projectLock(config.home, 'test/b')))?.pid, other.pid);
    } finally {
      await projects.close(context);
      await other.stop();
    }
  });

  test('close releases every lock held, including those taken over, so another process can take them', async () => {
    const { config } = await fixture({}, 'test/a');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch test/b');
    const projects = await takeProjects(['test/a', 'test/b'], takeIn(config.home));
    await other.stop();
    await projects.retake();
    await projects.close(context);
    assert.deepEqual(projects.held(), []);
    for (const repo of ['test/a', 'test/b']) {
      assert.equal(await readLock(paths.projectLock(config.home, repo)), undefined, `${repo} released`);
      const next = await holder(paths.projectLock(config.home, repo), 'phat-mode watch');
      assert.equal((await readLock(paths.projectLock(config.home, repo)))?.pid, next.pid);
      await next.stop();
    }
  });

  test('two processes never hold one project: each lock names exactly one holder', async () => {
    const { config } = await fixture({}, 'test/a');
    const other = await holder(paths.projectLock(config.home, 'test/b'), 'phat-mode watch test/b');
    const projects = await takeProjects(['test/a', 'test/b'], takeIn(config.home));
    try {
      await projects.retake();
      assert.equal((await readLock(paths.projectLock(config.home, 'test/a')))?.pid, process.pid);
      assert.equal((await readLock(paths.projectLock(config.home, 'test/b')))?.pid, other.pid);
    } finally {
      await projects.close(context);
      await other.stop();
    }
  });

  test('any other error while taking closes the projects already taken and is rethrown', async () => {
    const { config } = await fixture({}, 'test/a');
    const take = takeIn(config.home);
    await assert.rejects(
      takeProjects(['test/a', 'test/b'], async (repo) => (repo === 'test/b' ? Promise.reject(new Error('broken')) : take(repo))),
      /broken/,
    );
    assert.equal(await readLock(paths.projectLock(config.home, 'test/a')), undefined);
  });
});

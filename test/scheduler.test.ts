import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type ProjectQueue, watchProjects } from '../src/scheduler.ts';

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: Error): void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** What a fake project's `next()` does, look after look: start a run, have nothing to do, or fail (offline). */
type Look = 'run' | 'none' | 'throw';

/**
 * A watch over fake projects. Each project answers `next()` from its script (then 'none'); the runs it starts are
 * deferred, ended by the test. `sleep` lasts until the test calls `tick()`, or a run settles (wake).
 */
function watchOver(scripts: Record<string, Look[] | 'always'>, maxParallelRuns: number) {
  const started: string[] = [];
  const running = new Set<string>();
  const runs = new Map<string, Deferred[]>();
  const asked = new Map<string, number>();
  const errors: string[] = [];
  let mostAtOnce = 0;
  let sleeps = 0;
  let sleeping = false;
  let endSleep: (() => void) | undefined;
  const stop = new AbortController();

  const projects: ProjectQueue[] = Object.entries(scripts).map(([repo, script]) => ({
    repo,
    async next() {
      asked.set(repo, (asked.get(repo) ?? 0) + 1);
      assert.ok(!running.has(repo), `${repo} was asked for work while its run was going`);
      const look = script === 'always' ? 'run' : (script.shift() ?? 'none');
      if (look === 'throw') throw new Error(`${repo} is offline`);
      if (look === 'none') return undefined;
      const run = deferred();
      runs.set(repo, [...(runs.get(repo) ?? []), run]);
      started.push(repo);
      running.add(repo);
      mostAtOnce = Math.max(mostAtOnce, running.size);
      return () =>
        run.promise.finally(() => {
          running.delete(repo);
        });
    },
  }));

  const done = watchProjects({
    projects: async () => projects,
    maxParallelRuns,
    sleep: (wake) =>
      new Promise<void>((resolve) => {
        sleeps++;
        sleeping = true;
        const end = () => {
          sleeping = false;
          endSleep = undefined;
          resolve();
        };
        endSleep = end;
        wake.addEventListener('abort', end, { once: true });
      }),
    onError: (repo, error) => errors.push(`${repo}: ${(error as Error).message}`),
    signal: stop.signal,
  });

  /** Wait until the watch has nothing more to do right now: it sleeps. */
  async function idle() {
    for (let i = 0; i < 1_000; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (sleeping) return;
    }
    throw new Error('the watch never went to sleep');
  }

  return {
    started,
    running,
    asked,
    errors,
    idle,
    get mostAtOnce() {
      return mostAtOnce;
    },
    get sleeps() {
      return sleeps;
    },
    /** End the oldest unfinished run of `repo`. */
    async finish(repo: string, error?: Error) {
      const run = runs.get(repo)!.shift()!;
      if (error === undefined) run.resolve();
      else run.reject(error);
      await idle();
    },
    /** The sleep ends by itself: the watch interval has passed. */
    async tick() {
      endSleep?.();
      await idle();
    },
    async stop() {
      stop.abort();
      endSleep?.();
      await done;
    },
  };
}

describe('watchProjects', () => {
  test('maxParallelRuns 1: one run at a time across the projects', async () => {
    const watch = watchOver({ 'o/a': ['run'], 'o/b': ['run'], 'o/c': ['run'] }, 1);
    await watch.idle();
    assert.deepEqual(watch.started, ['o/a']);
    await watch.finish('o/a');
    assert.deepEqual(watch.started, ['o/a', 'o/b']);
    await watch.finish('o/b');
    assert.deepEqual(watch.started, ['o/a', 'o/b', 'o/c']);
    await watch.finish('o/c');
    assert.equal(watch.mostAtOnce, 1);
    await watch.stop();
  });

  test('maxParallelRuns 2: two projects run at once, and the third starts when one finishes', async () => {
    const watch = watchOver({ 'o/a': ['run'], 'o/b': ['run'], 'o/c': ['run'] }, 2);
    await watch.idle();
    assert.deepEqual(watch.started, ['o/a', 'o/b']);
    assert.deepEqual([...watch.running], ['o/a', 'o/b']);
    assert.equal(watch.asked.get('o/c'), undefined, 'no slot was free for o/c');
    await watch.finish('o/b');
    assert.deepEqual(watch.started, ['o/a', 'o/b', 'o/c']);
    assert.deepEqual([...watch.running].sort(), ['o/a', 'o/c']);
    assert.equal(watch.mostAtOnce, 2);
    await watch.stop();
  });

  test('a project never has two runs at once, whatever the cap', async () => {
    const watch = watchOver({ 'o/a': 'always' }, 3);
    await watch.idle();
    assert.deepEqual(watch.started, ['o/a']);
    await watch.tick();
    await watch.tick();
    assert.equal(watch.asked.get('o/a'), 1, 'not asked again while its run is going');
    await watch.finish('o/a');
    assert.deepEqual(watch.started, ['o/a', 'o/a']);
    assert.equal(watch.mostAtOnce, 1);
    await watch.stop();
  });

  test('a freed slot goes to the next project after the one that last started, so none starves', async () => {
    const watch = watchOver({ 'o/a': 'always', 'o/b': 'always', 'o/c': 'always' }, 1);
    await watch.idle();
    for (const repo of ['o/a', 'o/b', 'o/c', 'o/a']) await watch.finish(repo);
    assert.deepEqual(watch.started, ['o/a', 'o/b', 'o/c', 'o/a', 'o/b']);
    await watch.stop();
  });

  test('a project with nothing to run, e.g. waiting for its pull request to merge, takes no slot', async () => {
    const watch = watchOver({ 'o/a': ['none', 'none'], 'o/b': ['run'], 'o/c': ['run'] }, 2);
    await watch.idle();
    assert.deepEqual(watch.started, ['o/b', 'o/c']);
    assert.equal(watch.mostAtOnce, 2);
    await watch.stop();
  });

  test('a failing run frees only its slot: the others carry on, and onError is told', async () => {
    const watch = watchOver({ 'o/a': ['run'], 'o/b': ['run'], 'o/c': ['run'] }, 2);
    await watch.idle();
    await watch.finish('o/a', new Error('checks never passed'));
    assert.deepEqual(watch.errors, ['o/a: checks never passed']);
    assert.deepEqual([...watch.running].sort(), ['o/b', 'o/c']);
    await watch.finish('o/b');
    await watch.finish('o/c');
    assert.deepEqual(watch.started, ['o/a', 'o/b', 'o/c']);
    await watch.stop();
  });

  test('a look that fails for one project (offline) does not stop the others', async () => {
    const watch = watchOver({ 'o/a': ['throw', 'run'], 'o/b': ['run'] }, 2);
    await watch.idle();
    assert.deepEqual(watch.errors, ['o/a: o/a is offline']);
    assert.deepEqual(watch.started, ['o/b']);
    await watch.tick();
    assert.deepEqual(watch.started, ['o/b', 'o/a']);
    await watch.stop();
  });

  test('nothing to do: it sleeps until the interval passes, or a run ends', async () => {
    const watch = watchOver({ 'o/a': ['run'], 'o/b': ['none', 'none', 'run'] }, 2);
    await watch.idle();
    assert.equal(watch.sleeps, 1);
    assert.equal(watch.asked.get('o/b'), 1);
    await watch.finish('o/a');
    assert.equal(watch.sleeps, 2, 'the run ending woke it for another look');
    assert.equal(watch.asked.get('o/b'), 2);
    await watch.tick();
    assert.equal(watch.asked.get('o/b'), 3);
    assert.deepEqual(watch.started, ['o/a', 'o/b']);
    await watch.stop();
  });
});

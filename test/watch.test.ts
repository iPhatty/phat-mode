import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { CheckState } from '../src/github.ts';
import { silentLogger } from '../src/log.ts';
import { MARKER_SHAPE_REFUSED } from '../src/spec.ts';
import { describeStep, MARKER_HANDED_BACK, MARKER_PARENT_CLOSED, nextStep } from '../src/watch.ts';
import { yoloMarker, type YoloVerdict } from '../src/yolo.ts';
import { FakeGitHub, testConfig } from './fakes.ts';

const config: Config = testConfig('/nonexistent');
const step = (github: FakeGitHub) => nextStep(github, config, silentLogger);
const NOW = new Date('2026-10-31T12:00:00Z');
const yoloStep = (github: FakeGitHub) => nextStep(github, config, silentLogger, { yolo: true, now: NOW });

/** Open issues, each blocked by the issues listed (GitHub's native dependencies). */
function repo(issues: Record<number, { blockedBy?: number[]; labels?: string[]; author?: string }>) {
  const github = new FakeGitHub();
  for (const [key, options] of Object.entries(issues)) {
    const number = Number(key);
    github.addIssue(number, {
      labels: options.labels ?? ['ready-for-agent'],
      ...(options.author ? { author: options.author } : {}),
    });
    github.openIssues.add(number);
    if (options.blockedBy) github.native.set(number, options.blockedBy);
  }
  return github;
}

/** What GitHub does when a phat-mode pull request merges: `Closes #N` closes the issue. */
function merge(github: FakeGitHub, issue: number) {
  const pr = github.prs.find((candidate) => candidate.branch === `phat-mode/issue-${issue}` && candidate.state === 'OPEN')!;
  pr.state = 'MERGED';
  github.issues.get(issue)!.state = 'CLOSED';
  github.openIssues.delete(issue);
}

/** What a finished run leaves behind. */
function opened(github: FakeGitHub, issue: number) {
  github.issues.get(issue)!.labels.push('phat-mode:done');
  github.addPullRequest({ branch: `phat-mode/issue-${issue}` });
}

/** A finished run's pull request with phat-mode's verdict on it; settled, with its checks passed, unless told otherwise. */
function judged(
  github: FakeGitHub,
  issue: number,
  verdict: 'clean' | YoloVerdict = 'clean',
  checks: { name: string; state: CheckState }[] = [{ name: 'test', state: 'passed' }],
) {
  opened(github, issue);
  const pr = github.prs.at(-1)!;
  const sha = `cafe${issue}`;
  pr.body = `Adds it.\n\n${yoloMarker(verdict === 'clean' ? { verdict: 'clean', sha } : verdict)}`;
  github.statuses.set(pr.number, { head: { sha, committedAt: '2026-10-31T11:00:00Z' }, checks });
  return pr;
}

describe('watch --yolo', () => {
  test('merges a clean pull request, then starts the next ready issue in the same look', async () => {
    const github = repo({ 2: {}, 3: {} });
    const pr = judged(github, 2);
    assert.deepEqual(await yoloStep(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.deepEqual(github.merges, [{ pr: pr.number, sha: 'cafe2' }]);
  });

  test('merges every clean one, lowest issue first; the others wait, each saying why', async () => {
    const github = repo({ 2: {}, 3: {}, 4: {}, 5: {} });
    const findings = judged(github, 2, { verdict: 'not-clean', sha: 'cafe2', reason: 'code review has open findings' });
    const second = judged(github, 4);
    const running = judged(github, 3, 'clean', [{ name: 'build', state: 'running' }]);
    const first = judged(github, 5);
    // Opened in another order: still merged lowest issue first.
    const step = await yoloStep(github);
    assert.deepEqual(github.merges.map((merge) => merge.pr), [second.number, first.number]);
    assert.deepEqual(step, {
      kind: 'wait_for_merge',
      prs: [
        { issue: 2, url: findings.url, notMerging: { needsYou: true, reason: 'code review has open findings' } },
        { issue: 3, url: running.url, notMerging: { needsYou: false, reason: 'checks running: build' } },
      ],
    });
    assert.equal(
      describeStep(step),
      `Waiting for you to merge #2: ${findings.url} (not merging: code review has open findings); ` +
        `waiting to merge #3: ${running.url} (checks running: build)`,
    );
  });

  test('without --yolo, nothing is ever merged, even a clean pull request', async () => {
    const github = repo({ 2: {} });
    const pr = judged(github, 2);
    assert.deepEqual(await step(github), { kind: 'wait_for_merge', prs: [{ issue: 2, url: pr.url }] });
    assert.equal(github.writes, 0);
  });
});

describe('watch', () => {
  test('starts the lowest-numbered ready issue', async () => {
    const github = repo({ 3: {}, 2: {}, 5: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 2, title: 'Issue 2' });
  });

  test('waits while a phat-mode pull request is open, then moves on once it merges', async () => {
    const github = repo({ 2: {}, 3: {} });
    opened(github, 2);
    // Someone else's pull request never holds the queue up.
    github.addPullRequest({ branch: 'feature/other' });
    const waiting = await step(github);
    assert.deepEqual(waiting, { kind: 'wait_for_merge', prs: [{ issue: 2, url: github.prs[0]!.url }] });
    assert.match(describeStep(waiting), /Waiting for you to merge #2: https:\/\/github\.test\/pull\/100/);

    merge(github, 2);
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.equal(github.writes, 0, 'nothing written on GitHub');
  });

  test('skips blocked issues, even lower-numbered ones, and picks them up when the blocker merges', async () => {
    // As in phatty-lingo: #9 waits for #18.
    const github = repo({ 9: { blockedBy: [18] }, 18: {}, 19: { blockedBy: [18] } });
    assert.deepEqual(await step(github), { kind: 'start', issue: 18, title: 'Issue 18' });
    opened(github, 18);
    merge(github, 18);
    assert.deepEqual(await step(github), { kind: 'start', issue: 9, title: 'Issue 9' });
  });

  test('a done issue whose pull request merged is not started again while GitHub closes it', async () => {
    const github = repo({ 2: {}, 3: { blockedBy: [2] } });
    opened(github, 2);
    github.prs[0]!.state = 'MERGED';
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.match(describeStep(idle), /#3 is blocked by #2 \(its pull request is merged, GitHub has not closed it yet\)/);
  });

  test('a pull request closed without merging hands its issue to a human, and the queue moves on', async () => {
    const github = repo({ 2: {}, 3: {} });
    opened(github, 2);
    github.prs[0]!.state = 'CLOSED';
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    assert.deepEqual(github.labels(2), ['ready-for-human']);
    const comment = github.comments.find((candidate) => candidate.issue === 2)!;
    assert.equal(comment.marker, MARKER_HANDED_BACK);
    assert.match(comment.body, /closed without merging[^]*label it `ready-for-agent`/);
  });

  test('relabelled ready-for-agent after a failure or a hand-back: tried again', async () => {
    const github = repo({ 4: { labels: ['ready-for-agent', 'ready-for-human', 'phat-mode:failed'] } });
    assert.deepEqual(await step(github), { kind: 'start', issue: 4, title: 'Issue 4' });
  });

  test('never starts an issue labelled phat-mode:working; says why', async () => {
    const github = repo({ 2: { labels: ['ready-for-agent', 'phat-mode:working'] } });
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.match(describeStep(idle), /#2 is labelled phat-mode:working, but no run is going/);
  });

  test('ignores issues nobody trusted specified', async () => {
    const github = repo({ 2: { author: 'stranger' }, 3: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
  });

  test('never builds an issue labelled agent-mode; says why, once', async () => {
    const github = repo({ 2: { labels: ['ready-for-agent', 'agent-mode'] }, 3: {} });
    assert.deepEqual(await step(github), { kind: 'start', issue: 3, title: 'Issue 3' });
    const alone = repo({ 2: { labels: ['ready-for-agent', 'agent-mode'] } });
    const idle = await step(alone);
    assert.equal(idle.kind, 'idle');
    assert.equal(
      describeStep(idle),
      'Nothing can start:\n    - #2 is labelled `agent-mode` and also `ready-for-agent`: those are conflicting instructions.',
    );
  });

  test('nothing can start: says what each issue waits for, down to the human', async () => {
    const github = repo({
      9: { blockedBy: [18] },
      18: { labels: ['ready-for-human'] },
      19: { blockedBy: [9] },
    });
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.equal(
      describeStep(idle),
      'Nothing can start:\n    - #9 is blocked by #18 (ready-for-human)\n    - #19 is blocked by #9 (ready-for-agent, but blocked itself)',
    );
  });

  test('nothing ready at all', async () => {
    assert.equal(describeStep(await step(new FakeGitHub())), 'Nothing labelled ready-for-agent or agent-mode. Waiting for new issues.');
  });
});

describe('watch, agent mode', () => {
  test('shapes while a phat-mode pull request waits to be merged', async () => {
    const github = repo({ 2: {}, 5: { labels: ['agent-mode'] } });
    opened(github, 2);
    const shape = await step(github);
    assert.deepEqual(shape, { kind: 'shape', issue: 5, title: 'Issue 5' });
    assert.equal(describeStep(shape), 'Shaping next: #5 Issue 5');
  });

  test('shaping comes before a ready build, lowest-numbered first', async () => {
    const github = repo({ 2: {}, 7: { labels: ['agent-mode'] }, 4: { labels: ['agent-mode'] } });
    assert.deepEqual(await step(github), { kind: 'shape', issue: 4, title: 'Issue 4' });
  });

  test('an agent-mode issue that cannot be shaped does not hold up a later one', async () => {
    const github = repo({ 3: { labels: ['agent-mode', 'needs-info'] }, 4: { labels: ['agent-mode'], author: 'stranger' }, 6: { labels: ['agent-mode'] } });
    assert.deepEqual(await step(github), { kind: 'shape', issue: 6, title: 'Issue 6' });
  });

  test('a shaped parent closes once all its tickets are closed, not before', async () => {
    const github = repo({ 10: { labels: ['phat-mode:shaped'] }, 11: {}, 12: {} });
    github.issues.get(11)!.title = 'Store greetings';
    github.issues.get(12)!.title = 'Show greetings';
    github.parents.set(11, 10);
    github.parents.set(12, 10);
    // Shaped into one ticket: no sub-issues; it closes when its own pull request merges.
    github.addIssue(20, { labels: ['phat-mode:shaped', 'ready-for-agent'] });
    // Already closed: nothing to do.
    github.addIssue(30, { labels: ['phat-mode:shaped'], state: 'CLOSED' });
    github.addIssue(31, { state: 'CLOSED' });
    github.parents.set(31, 30);

    const close = (number: number) => {
      github.issues.get(number)!.state = 'CLOSED';
      github.openIssues.delete(number);
    };
    close(11);
    await step(github);
    assert.deepEqual(github.closed, []);
    assert.equal(github.comments.length, 0);

    close(12);
    await step(github);
    await step(github);
    assert.deepEqual(github.closed, [10]);
    assert.equal(github.issues.get(10)!.state, 'CLOSED');
    const comments = github.comments.filter((comment) => comment.issue === 10);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.marker, MARKER_PARENT_CLOSED);
    assert.match(comments[0]!.body, /^> \*Shaped by phat-mode \(AI\) from #10\.\*/);
    assert.match(comments[0]!.body, /All 2 tickets of this issue are closed:\n\n- #11 Store greetings\n- #12 Show greetings/);
    assert.equal(github.issues.get(20)!.state, 'OPEN');
  });

  test('a parent closes even while a pull request waits to be merged', async () => {
    const github = repo({ 2: {}, 10: { labels: ['phat-mode:shaped'] }, 11: {} });
    github.parents.set(11, 10);
    github.issues.get(11)!.state = 'CLOSED';
    opened(github, 2);
    assert.equal((await step(github)).kind, 'wait_for_merge');
    assert.deepEqual(github.closed, [10]);
  });

  test('refusals and conflicts appear among the waiting lines, once, and are said on the issue once', async () => {
    const github = repo({
      2: { blockedBy: [9] },
      3: { labels: ['agent-mode', 'ready-for-agent'] },
      4: { labels: ['agent-mode', 'phat-mode:shaped'] },
      5: { labels: ['agent-mode'], author: 'stranger' },
      9: { labels: ['ready-for-human'] },
    });
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.equal(
      describeStep(idle),
      [
        'Nothing can start:',
        '    - #3 is labelled `agent-mode` and also `ready-for-agent`: those are conflicting instructions.',
        '    - #4 is already `phat-mode:shaped`: phat-mode does not shape an issue again.',
        '    - #5 was opened by stranger, not by iPhatty: only issues by a trusted author are shaped.',
        '    - #2 is blocked by #9 (ready-for-human)',
      ].join('\n'),
    );
    await step(github);
    // The refusals are said on the issue, once each; the stranger's issue is left alone.
    assert.deepEqual(
      github.comments.map((comment) => [comment.issue, comment.marker]),
      [
        [3, MARKER_SHAPE_REFUSED],
        [4, MARKER_SHAPE_REFUSED],
      ],
    );
    assert.match(github.comments[0]!.body, /## Not shaped[^]*conflicting instructions/);
    assert.deepEqual(github.labels(3), ['agent-mode', 'ready-for-agent']);
  });

  test('while a pull request waits, the reasons an agent-mode issue cannot be shaped show too', async () => {
    const github = repo({ 2: {}, 3: { labels: ['agent-mode', 'needs-triage'] } });
    opened(github, 2);
    const waiting = await step(github);
    assert.equal(waiting.kind, 'wait_for_merge');
    assert.equal(
      describeStep(waiting),
      `Waiting for you to merge #2: ${github.prs[0]!.url}\n` +
        '    - #3 is labelled `agent-mode` and also `needs-triage`: those are conflicting instructions.',
    );
  });
  test('a conflicting agent-mode issue whose pull request was closed is not handed back: it is left for you', async () => {
    const github = repo({ 2: { labels: ['agent-mode', 'ready-for-agent'] } });
    opened(github, 2);
    github.prs[0]!.state = 'CLOSED';
    const idle = await step(github);
    assert.equal(idle.kind, 'idle');
    assert.deepEqual(github.labels(2), ['agent-mode', 'phat-mode:done', 'ready-for-agent']);
    assert.deepEqual(github.comments.map((comment) => comment.marker), [MARKER_SHAPE_REFUSED]);
  });

  test('phat-mode:working does not hide a refusal: conflicts and already-shaped are still said, once', async () => {
    const github = repo({
      3: { labels: ['agent-mode', 'ready-for-agent', 'phat-mode:working'] },
      4: { labels: ['agent-mode', 'phat-mode:shaped', 'phat-mode:working'] },
      5: { labels: ['agent-mode', 'phat-mode:working'] },
    });
    const idle = await step(github);
    assert.equal(
      describeStep(idle),
      [
        'Nothing can start:',
        '    - #3 is labelled `agent-mode` and also `ready-for-agent`: those are conflicting instructions.',
        '    - #4 is already `phat-mode:shaped`: phat-mode does not shape an issue again.',
        '    - #5 is labelled phat-mode:working, but no run is going. Run `phat-mode status`, or remove the label to start again.',
      ].join('\n'),
    );
    assert.deepEqual(
      github.comments.map((comment) => [comment.issue, comment.marker]),
      [
        [3, MARKER_SHAPE_REFUSED],
        [4, MARKER_SHAPE_REFUSED],
      ],
    );
  });
});

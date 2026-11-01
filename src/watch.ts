import { branchFor, type Config } from './config.ts';
import { commentMarker, type GitHub, type ListedIssue, mergeLabels, PROGRESS_LABELS, progressChange, RUN_PROGRESS } from './github.ts';
import type { Logger } from './log.ts';
import { handedBackComment } from './messages.ts';
import { eligibility } from './spec.ts';
import { yoloMerge } from './yolo.ts';

/**
 * What `phat-mode watch` does next, worked out from GitHub alone each time, so nothing needs saving between looks:
 * a crash, Ctrl-C or a sleeping Mac only means it catches up on the next look. Runs that are still going are resumed
 * before this is asked.
 *
 * One issue at a time: while a phat-mode pull request is open, nothing new starts. Merging it closes its issue
 * (`Closes #N`), which also unblocks the issues that wait for it.
 */
export type WatchStep =
  /**
   * phat-mode's pull requests waiting for a human to merge (or close) them. With yolo, `notMerging` says why each was
   * not merged, and whether only a human can move it on.
   */
  | { kind: 'wait_for_merge'; prs: WaitingPullRequest[] }
  /** The lowest-numbered issue that is ready and not blocked. */
  | { kind: 'start'; issue: number; title: string }
  /** Nothing can start. `waiting`: why each ready issue cannot, one line each. */
  | { kind: 'idle'; waiting: string[] };

export type WaitingPullRequest = { issue: number; url: string; notMerging?: { needsYou: boolean; reason: string } };

const PR_BRANCH = /^phat-mode\/issue-(\d+)$/;

export const MARKER_HANDED_BACK = commentMarker('handed-back');

const progressOf = (issue: Pick<ListedIssue, 'labels'>) =>
  RUN_PROGRESS.find((key) => issue.labels.includes(PROGRESS_LABELS[key].name));

/** `yolo`: merge phat-mode's pull requests that nothing is left for a human to look at (see src/yolo.ts). */
export type WatchOptions = { yolo?: boolean; now?: Date };

export async function nextStep(
  github: GitHub,
  config: Config,
  logger: Logger,
  { yolo = false, now = new Date() }: WatchOptions = {},
): Promise<WatchStep> {
  const { labels } = config;

  // 1. A phat-mode pull request is open: wait for the human to merge it. With yolo, merge the ones that can go first.
  const open = (await github.openPullRequests())
    .flatMap((pr) => {
      const match = PR_BRANCH.exec(pr.branch);
      return match ? [{ number: pr.number, issue: Number(match[1]), url: pr.url }] : [];
    })
    .sort((a, b) => a.issue - b.issue);
  const unmerged: WaitingPullRequest[] = [];
  for (const pr of open) {
    if (!yolo) {
      unmerged.push({ issue: pr.issue, url: pr.url });
      continue;
    }
    const outcome = await yoloMerge(github, pr, { command: 'watch', now });
    if (outcome.merged) logger.step(pr.issue, `Merged ${pr.url}`);
    else unmerged.push({ issue: pr.issue, url: pr.url, notMerging: { needsYou: outcome.needsYou, reason: outcome.reason } });
  }
  if (unmerged.length > 0) return { kind: 'wait_for_merge', prs: unmerged };

  const ready = await github.listOpenIssues(labels.readyForAgent);

  // 2. Done issues whose pull request was closed without merging: the human said no, so hand the issue back.
  //    A merged one closes its issue; it is only still listed until GitHub catches up.
  for (const issue of ready.filter((candidate) => progressOf(candidate) === 'done')) {
    const pr = await github.latestPullRequest(branchFor(issue.number));
    if (pr?.state !== 'CLOSED') continue;
    logger.step(issue.number, `Pull request ${pr.url} was closed without merging; handing the issue to a human`);
    await github.upsertComment(issue.number, MARKER_HANDED_BACK, handedBackComment(pr.url, labels));
    await github.editLabels(
      issue.number,
      mergeLabels(progressChange(null), { add: [labels.readyForHuman], remove: [labels.readyForAgent] }),
    );
  }

  // 3. The lowest-numbered ready issue that is not blocked. `done` waits for its PR to merge; `working` without a
  //    run going means a run was aborted. `failed` with ready-for-agent again means: try again.
  const byNumber = new Map(ready.map((issue) => [issue.number, issue]));
  const waiting: string[] = [];
  const blocked: { issue: number; blockers: number[] }[] = [];
  for (const listed of ready) {
    const progress = progressOf(listed);
    if (progress === 'done') continue;
    if (progress === 'working') {
      waiting.push(`#${listed.number} is labelled ${PROGRESS_LABELS.working.name}, but no run is going. Run \`phat-mode status\`, or remove the label to start again.`);
      continue;
    }
    const eligible = eligibility(await github.getIssue(listed.number), config);
    if (!eligible.ok) {
      waiting.push(eligible.reason);
      continue;
    }
    const blockers = await github.openBlockers(listed.number, eligible.spec.blockedBy);
    if (blockers.length === 0) return { kind: 'start', issue: listed.number, title: listed.title };
    blocked.push({ issue: listed.number, blockers });
  }

  // 4. Nothing can start: say what each issue waits for, and what that blocker waits for.
  const why = new Map<number, string>();
  const blockerState = async (number: number) => {
    if (!why.has(number)) {
      const listed = byNumber.get(number);
      let text: string;
      if (listed !== undefined) {
        const progress = progressOf(listed);
        text =
          progress === 'done'
            ? 'its pull request is merged, GitHub has not closed it yet'
            : progress === 'working'
              ? PROGRESS_LABELS.working.name
              : 'ready-for-agent, but blocked itself';
      } else {
        const issue = await github.getIssue(number);
        const triage = Object.values(labels).filter((label) => issue.labels.includes(label));
        text = triage.length > 0 ? triage.join(', ') : 'not triaged';
      }
      why.set(number, text);
    }
    return `#${number} (${why.get(number)})`;
  };
  for (const { issue, blockers } of blocked) {
    const states = [];
    for (const blocker of blockers) states.push(await blockerState(blocker));
    waiting.push(`#${issue} is blocked by ${states.join(', ')}`);
  }
  return { kind: 'idle', waiting };
}

/** One line (or a few) for the console. */
export function describeStep(step: WatchStep): string {
  switch (step.kind) {
    case 'wait_for_merge': {
      if (step.prs.every((pr) => pr.notMerging === undefined)) {
        return `Waiting for you to merge ${step.prs.map((pr) => `#${pr.issue}: ${pr.url}`).join(', ')}`;
      }
      const lines = step.prs.map(({ issue, url, notMerging }) =>
        notMerging === undefined || notMerging.needsYou
          ? `waiting for you to merge #${issue}: ${url}${notMerging ? ` (not merging: ${notMerging.reason})` : ''}`
          : `waiting to merge #${issue}: ${url} (${notMerging.reason})`,
      );
      const text = lines.join('; ');
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case 'start':
      return `Next: #${step.issue} ${step.title}`;
    case 'idle':
      return step.waiting.length === 0
        ? 'Nothing labelled ready-for-agent. Waiting for new issues.'
        : `Nothing can start:\n${step.waiting.map((line) => `    - ${line}`).join('\n')}`;
  }
}

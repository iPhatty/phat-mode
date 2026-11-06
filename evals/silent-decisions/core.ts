/**
 * The pure parts of the silent-decisions eval kit: no gh, no git, no files. See README.md.
 * Nothing in phat-mode's runtime imports this.
 */
import { commentMarker } from '../../src/github.ts';
import { docChangeOf } from '../../src/workspace.ts';

/**
 * The `git log` arguments whose output `parseFirstParentLog` reads: the base branch's first-parent line, newest first,
 * each commit with the diff it brought in (as `docChanges` in src/workspace.ts reads it).
 */
export const FIRST_PARENT_LOG_ARGS = [
  'log', '--first-parent', '--diff-merges=first-parent', '--name-status', '--diff-filter=AMR',
  '--format=%x00%H%x1f%h%x1f%cI%x1f%s',
];

/** A commit on the base branch's first-parent line. `files`: its `--name-status` lines, e.g. `M\tsrc/x.ts`. */
export type LogCommit = { sha: string; short: string; committedAt: string; subject: string; files: string[] };

/** An ADR or glossary a commit in the window added or changed. `title`: an ADR's first `# ` heading, when looked up. */
export type WindowDocChange = {
  path: string;
  kind: 'added' | 'changed';
  doc: 'adr' | 'glossary';
  sha: string;
  short: string;
  subject: string;
  committedAt: string;
  title?: string;
};

export type Window = {
  /** The newest first-parent commit made at or before planning: the code the planner saw. */
  baseCommit: string | undefined;
  /** The commits made after the spec was written, up to and including planning, oldest first. */
  commits: LogCommit[];
  /** The ADRs and glossaries those commits added or changed, oldest first. */
  docChanges: WindowDocChange[];
};

/** The output of `git log <FIRST_PARENT_LOG_ARGS> <ref>`, in git's order (newest first). */
export function parseFirstParentLog(stdout: string): LogCommit[] {
  return stdout
    .split('\0')
    .slice(1)
    .map((entry) => {
      const [header = '', ...lines] = entry.split('\n');
      const [sha = '', short = '', committedAt = '', subject = ''] = header.split('\x1f');
      return { sha, short, committedAt, subject, files: lines.filter((line) => line.trim() !== '') };
    });
}

/**
 * The window a ticket waited in: commits with `writtenAt < committed <= plannedAt` (committer time), and the base
 * commit planning started from. `commits`: newest first, as `parseFirstParentLog` returns them.
 */
export function windowOf(commits: readonly LogCommit[], writtenAt: string, plannedAt: string): Window {
  const written = Date.parse(writtenAt);
  const planned = Date.parse(plannedAt);
  const baseCommit = commits.find((commit) => Date.parse(commit.committedAt) <= planned)?.sha;
  const inWindow = commits
    .filter((commit) => {
      const committed = Date.parse(commit.committedAt);
      return committed > written && committed <= planned;
    })
    .reverse();
  const docChanges = inWindow.flatMap((commit) =>
    commit.files.flatMap((line) => {
      const change = docChangeOf(line);
      if (change === undefined) return [];
      const { sha, short, subject, committedAt } = commit;
      return [{ ...change, sha, short, subject, committedAt }];
    }),
  );
  return { baseCommit, commits: inWindow, docChanges };
}

/** An issue comment as GitHub's REST API lists it. */
export type RestComment = { user: { login: string } | null; body: string; created_at: string; updated_at: string };

export type PlanComment = { createdAt: string; updatedAt: string; body: string };

/**
 * The plan comment phat-mode posted on a ticket it built: carrying the plan marker, by `login` (the `gh` user phat-mode
 * posts as; anyone can copy the marker), and a proceed plan, not a hand-back left in the same comment.
 */
export function pickPlanComment(comments: readonly RestComment[], login: string): PlanComment | undefined {
  const comment = comments.find(
    (candidate) =>
      candidate.user?.login === login &&
      candidate.body.includes(commentMarker('plan')) &&
      candidate.body.includes('phat-mode is working on this') &&
      candidate.body.includes('**Plan**'),
  );
  return comment && { createdAt: comment.created_at, updatedAt: comment.updated_at, body: comment.body };
}

/** A silent decision as the plan comment lists it (src/messages.ts `silentDecisionLines`). */
export type RecordedDecision = { question: string; decision: string; why: string };
/** A departure as the pull request description lists it (src/messages.ts `departureLines`). */
export type RecordedDeparture = { decision: string; instead: string; why: string };

/** The list items of a section, from the line after `heading` to the first line `isEnd` accepts. */
function sectionItems(text: string, heading: string, isEnd: (line: string) => boolean): string[] | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isEnd(line)) break;
    if (line.startsWith('- ')) items.push(line.slice(2));
  }
  return items;
}

/** `text _Why:_ why`, split; the why is empty when there is none. */
function splitWhy(text: string): [string, string] {
  const at = text.lastIndexOf(' _Why:_ ');
  return at === -1 ? [text.trim(), ''] : [text.slice(0, at).trim(), text.slice(at + ' _Why:_ '.length).trim()];
}

/**
 * The silent decisions a plan comment lists: an empty list when the plan said none were needed, undefined when the
 * run recorded none (a plan from before silent decisions existed).
 */
export function recordedSilentDecisions(planBody: string): RecordedDecision[] | undefined {
  const items = sectionItems(planBody, '**Decided where the ticket was silent**', (line) =>
    line.startsWith("I'll open a pull request"),
  );
  return items?.flatMap((item) => {
    const match = /^\*\*(.+?)\*\* (.*)$/.exec(item);
    if (match === null) return [];
    const [decision, why] = splitWhy(match[2]!);
    return [{ question: match[1]!, decision, why }];
  });
}

/**
 * The departures a pull request description lists: an empty list when it lists silent decisions but no departures,
 * undefined when the run recorded neither (a pull request from before silent decisions existed).
 */
export function recordedDepartures(prBody: string): RecordedDeparture[] | undefined {
  if (!prBody.split('\n').some((line) => line.trim() === '## Decided where the ticket was silent')) return undefined;
  const items = sectionItems(prBody, '## Departures', (line) => line.startsWith('## ') || line.trim() === '---') ?? [];
  return items.flatMap((item) => {
    const match = /^\*\*(.+?)\*\* Instead: (.*)$/.exec(item);
    if (match === null) return [];
    const [instead, why] = splitWhy(match[2]!);
    return [{ decision: match[1]!, instead, why }];
  });
}

/** One built ticket, as collect.ts writes it and prepare.ts reads it. */
export type TicketRecord = {
  repo: string;
  number: number;
  title: string;
  url: string;
  /**
   * The spec, by #27's rule (src/spec.ts `findSpec`): `writtenAt` is the Agent Brief's creation time, else the body's
   * shaped-at time, else the issue's creation time. `brief`: the Agent Brief's text, when the spec is one.
   */
  spec: { source: 'brief' | 'issue'; author: string; writtenAt: string; brief?: string };
  /** When planning started: the plan comment's creation time. */
  plannedAt: string;
  plan: PlanComment;
  /** When the issue body was last edited (GitHub's `lastEditedAt`); null when never. */
  bodyEditedAt: string | null;
  parent: number | null;
  /** The newest pull request from the ticket's branch. */
  pr: { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeCommit: string | null; url: string } | null;
  /** The base branch's commit when planning started: what the planner saw. */
  baseCommit: string | null;
  window: { commits: LogCommit[]; docChanges: WindowDocChange[] };
};

/**
 * Which tickets to evaluate: chosen issues, all tickets planned in `[from, to)`, or every Nth merged ticket by issue
 * number (the first, the N+1th, ...). Returned by issue number.
 */
export type SampleBy = { issues: number[] } | { from: string; to: string } | { every: number };

export function sample(records: readonly TicketRecord[], by: SampleBy): TicketRecord[] {
  const sorted = [...records].sort((a, b) => a.number - b.number);
  if ('issues' in by) return sorted.filter((record) => by.issues.includes(record.number));
  if ('every' in by) return sorted.filter((record) => record.pr?.state === 'MERGED').filter((_, index) => index % by.every === 0);
  const from = Date.parse(by.from);
  const to = Date.parse(by.to);
  return sorted.filter((record) => {
    const planned = Date.parse(record.plannedAt);
    return planned >= from && planned < to;
  });
}

/** Whether the body was edited after planning started, so the reviewer may see a different ticket than the planner. */
export const editedAfter = (editedAt: string | null, plannedAt: string) =>
  editedAt !== null && Date.parse(editedAt) > Date.parse(plannedAt);

/** An item of GitHub's REST issue listing: pull requests are listed too, with a `pull_request` field. */
export type RestIssueItem = { number: number; pull_request?: unknown };

/**
 * Every issue (never a pull request) of a paginated listing, by number: pages 1, 2, ... are read until one comes back
 * with fewer than `perPage` items, so no issue past a limit is left out.
 */
export async function listDoneIssues(
  fetchPage: (page: number) => Promise<readonly RestIssueItem[]>,
  perPage: number,
): Promise<number[]> {
  const numbers = new Set<number>();
  for (let page = 1; ; page++) {
    const items = await fetchPage(page);
    for (const item of items) if (item.pull_request === undefined) numbers.add(item.number);
    if (items.length < perPage) break;
  }
  return [...numbers].sort((a, b) => a - b);
}

import type { Config } from './config.ts';
import { type Comment, type Issue, PROGRESS_LABELS } from './github.ts';

/**
 * What phat-mode builds from. mattpocock/skills makes an issue ready-for-agent in three ways:
 * - `/triage` posts an Agent Brief comment: the `## Agent Brief` template, or a short inline `Agent brief: …`.
 * - `/to-tickets` and `/to-spec` write the spec into the issue body itself.
 * A brief from a trusted author wins; otherwise the body of an issue a trusted author opened is the spec.
 */
export type Spec = {
  source: 'brief' | 'issue';
  author: string;
  text: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  /** Issue numbers listed under "Blocked by". */
  blockedBy: number[];
  /** The larger plan this issue is part of, when a trusted author wrote it: background, not the contract. */
  parent?: ParentIssue;
};

export type ParentIssue = { number: number; title: string; author: string; body: string };

/** Start of an Agent Brief: a `## Agent Brief` heading, or a paragraph starting `Agent brief:` (optionally bold). */
const BRIEF_START = /^(?:#{1,3}[ \t]*Agent Brief[ \t]*$|(?:\*\*)?Agent brief:?(?:\*\*)?:?[ \t])/im;

const isSectionStart = (line: string) =>
  /^#{1,6}\s/.test(line) || /^\*\*[^*]+:?\*\*:?/.test(line);

/**
 * Items of the list in a section, by a bold label (`**Acceptance criteria:**`) or a heading (`## Acceptance criteria`),
 * until the next section. Checkboxes are stripped; wrapped continuation lines are joined.
 */
export function listUnder(text: string, label: string): string[] {
  const lines = text.split('\n');
  const title = new RegExp(`^(?:#{1,6}\\s*${label}:?|\\*\\*${label}:?\\*\\*:?)\\s*$`, 'i');
  const start = lines.findIndex((line) => title.test(line.trim()));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (isSectionStart(trimmed)) break;
    const item = /^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(trimmed);
    if (item) items.push(item[1]!.trim());
    else if (items.length > 0 && trimmed !== '' && /^\s{2,}/.test(line)) items[items.length - 1] += ` ${trimmed}`;
  }
  return items;
}

/** Issue numbers referenced under "Blocked by", as `#12` or a link to an issue in `repo`. "None" gives none. */
/** Issue numbers referenced in the section titled `label` (a heading or a bold label), as `#12` or a link into `repo`. */
function sectionRefs(text: string, label: string, repo: string): number[] {
  const title = new RegExp(`^(?:#{1,6}\\s*|\\*\\*)${label}:?(?:\\*\\*)?:?`, 'i');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => title.test(line.trim()));
  if (start === -1) return [];
  // The section: the rest of its own line, then lines until the next section.
  const own = lines[start]!.trim().replace(title, '');
  const rest: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (isSectionStart(line.trim())) break;
    rest.push(line);
  }
  const section = [own, ...rest].join('\n');
  const numbers: number[] = [];
  const add = (n: number) => (numbers.includes(n) ? undefined : numbers.push(n));
  const link = new RegExp(`(?:^|[\\s(,])#(\\d+)\\b|github\\.com/${repo.replace('/', '\\/')}/issues/(\\d+)`, 'gi');
  for (const match of section.matchAll(link)) add(Number(match[1] ?? match[2]));
  return numbers;
}

/** Issue numbers referenced under "Blocked by", as `#12` or a link to an issue in `repo`. "None" gives none. */
export function blockedBy(text: string, repo: string): number[] {
  return sectionRefs(text, 'Blocked by', repo).sort((a, b) => a - b);
}

/** The parent issue named under "Parent" (as `/to-tickets` writes it), if any: the first reference there. */
export function parentRef(text: string, repo: string): number | undefined {
  return sectionRefs(text, 'Parent', repo)[0];
}

function specFrom(source: Spec['source'], author: string, text: string, repo: string): Spec {
  return {
    source,
    author,
    text,
    acceptanceCriteria: listUnder(text, 'Acceptance criteria'),
    outOfScope: listUnder(text, 'Out of scope'),
    blockedBy: blockedBy(text, repo),
  };
}

/**
 * When shaping rewrote an issue's body into its spec: a hidden marker in the body. Briefs from before then were
 * written for the request as it was, not for the spec, so they no longer count; later ones (a human's amendment) do.
 */
export const shapedAtMarker = (at: string) => `<!-- phat-mode:shaped-at:${at} -->`;

/** The time in a body's shaped-at marker, in milliseconds; undefined without a valid marker. */
export function shapedAt(body: string): number | undefined {
  const match = /<!-- phat-mode:shaped-at:([^ ]+) -->/.exec(body);
  const time = match ? Date.parse(match[1]!) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

/** The newest Agent Brief comment by a trusted author, from where the brief starts; none from before shaping. */
export function findAgentBrief(issue: Issue, trusted: readonly string[], repo = ''): Spec | undefined {
  const shaped = trusted.includes(issue.author) ? shapedAt(issue.body) : undefined;
  const comment = issue.comments
    .filter((candidate) => trusted.includes(candidate.author) && BRIEF_START.test(candidate.body))
    .filter((candidate) => shaped === undefined || Date.parse(candidate.createdAt) > shaped)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (comment === undefined) return undefined;
  return specFrom('brief', comment.author, comment.body.slice(comment.body.search(BRIEF_START)).trim(), repo);
}

/** The spec to build from, or undefined when nobody trusted has specified the issue. */
export function findSpec(issue: Issue, trusted: readonly string[], repo: string): Spec | undefined {
  const brief = findAgentBrief(issue, trusted, repo);
  if (brief !== undefined) {
    // A ticket's blockers live in its body even when a brief was added later.
    const body = blockedBy(issue.body, repo);
    return { ...brief, blockedBy: [...new Set([...brief.blockedBy, ...body])].sort((a, b) => a - b) };
  }
  if (trusted.includes(issue.author)) return specFrom('issue', issue.author, issue.body, repo);
  return undefined;
}

export type Eligibility = { ok: true; spec: Spec } | { ok: false; reason: string };

/**
 * Whether phat-mode may work on an issue: open, labelled ready-for-agent (only people with triage access can set it),
 * not labelled agent-mode (that asks for shaping, not building), and specified by someone trusted. Open blockers are
 * checked separately, as that needs GitHub.
 */
export function eligibility(issue: Issue, config: Pick<Config, 'allowedAuthors' | 'labels' | 'repo'>): Eligibility {
  if (issue.state !== 'OPEN') return { ok: false, reason: `#${issue.number} is closed.` };
  const agentMode = config.labels.agentMode;
  if (issue.labels.includes(agentMode)) {
    return {
      ok: false,
      reason: `#${issue.number} is labelled \`${agentMode}\`: phat-mode shapes it into tickets, it does not build it.`,
    };
  }
  const ready = config.labels.readyForAgent;
  if (!issue.labels.includes(ready)) {
    return { ok: false, reason: `#${issue.number} is not labelled \`${ready}\`. Triage it first (e.g. with /triage).` };
  }
  const spec = findSpec(issue, config.allowedAuthors, config.repo);
  if (spec !== undefined) return { ok: true, spec };
  return {
    ok: false,
    reason: `#${issue.number} was opened by ${issue.author} and has no Agent Brief from ${config.allowedAuthors.join(', ')}.`,
  };
}

export type ShapingEligibility =
  | { ok: true }
  /** ignored: left alone without touching GitHub. refused: phat-mode says why in a comment, and changes nothing else. */
  | { ok: false; kind: 'ignored' | 'refused'; reason: string };

/**
 * Whether phat-mode may shape an issue, from the issue alone. Ignored without a word: closed, not labelled agent-mode,
 * or opened by someone untrusted (strangers' text must never drive autonomous specs). Refused with a comment: already
 * shaped (re-shaping would fight the tickets in progress), or carrying a triage state label too (conflicting
 * instructions are never guessed at).
 */
export function shapingEligibility(issue: Issue, config: Pick<Config, 'allowedAuthors' | 'labels'>): ShapingEligibility {
  const { labels } = config;
  if (issue.state !== 'OPEN') return { ok: false, kind: 'ignored', reason: `#${issue.number} is closed.` };
  if (!issue.labels.includes(labels.agentMode)) {
    return { ok: false, kind: 'ignored', reason: `#${issue.number} is not labelled \`${labels.agentMode}\`.` };
  }
  if (!config.allowedAuthors.includes(issue.author)) {
    return {
      ok: false,
      kind: 'ignored',
      reason: `#${issue.number} was opened by ${issue.author}, not by ${config.allowedAuthors.join(', ')}: only issues by a trusted author are shaped.`,
    };
  }
  if (issue.labels.includes(PROGRESS_LABELS.shaped.name)) {
    return {
      ok: false,
      kind: 'refused',
      reason: `#${issue.number} is already \`${PROGRESS_LABELS.shaped.name}\`: phat-mode does not shape an issue again.`,
    };
  }
  const states = [labels.needsTriage, labels.needsInfo, labels.readyForAgent, labels.readyForHuman, labels.wontfix];
  const conflicting = issue.labels.filter((label) => states.includes(label));
  if (conflicting.length > 0) {
    return {
      ok: false,
      kind: 'refused',
      reason: `#${issue.number} is labelled \`${labels.agentMode}\` and also ${conflicting.map((label) => `\`${label}\``).join(', ')}: those are conflicting instructions.`,
    };
  }
  return { ok: true };
}

/** Only the comments by trusted authors: anyone else's never reach an agent. */
export function trustedComments(issue: Issue, allowedAuthors: readonly string[]): Comment[] {
  return issue.comments.filter((comment) => allowedAuthors.includes(comment.author));
}

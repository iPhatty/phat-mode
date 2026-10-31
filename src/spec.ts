import type { Config } from './config.ts';
import type { Issue } from './github.ts';

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

/** The newest Agent Brief comment by a trusted author, from where the brief starts. */
export function findAgentBrief(issue: Issue, trusted: readonly string[], repo = ''): Spec | undefined {
  const comment = issue.comments
    .filter((candidate) => trusted.includes(candidate.author) && BRIEF_START.test(candidate.body))
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

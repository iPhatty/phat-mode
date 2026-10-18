import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * phat-mode's reviewers follow mattpocock/skills' `code-review` skill: two reviewers, in parallel and in separate
 * conversations, one per axis. Standards: does the code follow the repo's documented standards (plus a baseline of
 * code smells)? Spec: does it do what the spec asked? The pipeline does the skill's coordinator steps itself.
 */
export type CodeReviewSkill = {
  /** Which version of the skill, e.g. `mattpocock/skills@49dd158`. */
  source: string;
  /** The smell baseline, pasted in full into the Standards reviewer's prompt, as the skill says. */
  smellBaseline: string;
  /** The skill's brief for each sub-agent, verbatim. */
  standardsBrief: string;
  specBrief: string;
};

/**
 * The skill is phat-mode's own, pinned copy in skills/code-review/, the same for every repo: the review process belongs
 * to phat-mode, while each repo's documented standards (AGENTS.md and the like) say what good code means there.
 * A copy installed in the target repo is never used, so the code under review cannot change how it is reviewed.
 * To upgrade: copy the new upstream SKILL.md over, update PINNED and skills/code-review/README.md, run `npm test`.
 */
export const PINNED = {
  commit: '49dd158d1076134a641b33efb035946536778336',
  get short() {
    return this.commit.slice(0, 7);
  },
  get url() {
    return `https://github.com/mattpocock/skills/blob/${this.commit}/skills/engineering/code-review/SKILL.md`;
  },
};
const SKILL_FILE = new URL('../skills/code-review/SKILL.md', import.meta.url);

/** The parts of SKILL.md the reviewers need, or undefined if its layout changed beyond recognition. */
export function parseCodeReviewSkill(text: string, source: string): CodeReviewSkill | undefined {
  const lines = text.split('\n');
  const baselineStart = lines.findIndex((line) => line.startsWith('On top of whatever the repo documents'));
  const baselineEnd = lines.findIndex((line, index) => index > baselineStart && /^#{1,3} /.test(line));
  const briefAfter = (header: string) => {
    const start = lines.findIndex((line) => line.includes(header));
    if (start === -1) return undefined;
    const line = lines.slice(start + 1).find((candidate) => candidate.trim().startsWith('- The brief:'));
    return /^- The brief: "(.+)"\s*$/.exec(line?.trim() ?? '')?.[1];
  };
  const standardsBrief = briefAfter('**Standards sub-agent prompt**');
  const specBrief = briefAfter('**Spec sub-agent prompt**');
  if (baselineStart === -1 || baselineEnd === -1 || standardsBrief === undefined || specBrief === undefined) {
    return undefined;
  }
  const smellBaseline = lines.slice(baselineStart, baselineEnd).join('\n').trim();
  return { source, smellBaseline, standardsBrief, specBrief };
}

let loaded: Promise<CodeReviewSkill> | undefined;

/** phat-mode's pinned copy of the skill. */
export function loadCodeReviewSkill(): Promise<CodeReviewSkill> {
  loaded ??= readFile(SKILL_FILE, 'utf8').then((text) => {
    const skill = parseCodeReviewSkill(text, `mattpocock/skills@${PINNED.short}`);
    if (skill === undefined) throw new Error(`phat-mode's code-review skill (${SKILL_FILE.pathname}) could not be read`);
    return skill;
  });
  return loaded;
}

const STANDARDS_FILES = [
  'CODING_STANDARDS.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.github/CONTRIBUTING.md',
];

const isFile = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true;

/** Markdown files under docs/, at most `limit`. */
async function docsFiles(workspace: string, limit: number): Promise<string[]> {
  const root = join(workspace, 'docs');
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(workspace, join(entry.parentPath, entry.name)))
    .sort()
    .slice(0, limit);
}

/** Files that may document how code should be written (skill step 3). The reviewer searches for more itself. */
export async function standardsSources(workspace: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of STANDARDS_FILES) if (await isFile(join(workspace, file))) found.push(file);
  return [...found, ...(await docsFiles(workspace, 30))];
}

// ─── Reports ────────────────────────────────────────────────────────────────

/** violation: breaks a documented repo standard (can be hard). smell: a baseline smell (always a judgement call). */
export type StandardsFinding = { kind: 'violation' | 'smell'; where: string; rule: string; detail: string };

/**
 * missing: asked for but missing or partial. unasked: not asked for (scope creep). wrong: looks implemented, but
 * wrongly. bug: phat-mode's addition, a bug, broken edge case or leftover debugging code anywhere in the diff.
 */
export type SpecFinding = { kind: 'missing' | 'unasked' | 'wrong' | 'bug'; where: string; specLine: string; detail: string };

export type AxisReport<F> = { summary: string; worst: string; findings: F[] };
export type StandardsReport = AxisReport<StandardsFinding>;
export type SpecReport = AxisReport<SpecFinding>;

/** One review round. An axis is null when its reviewer did not report. */
export type CodeReview = { round: number; standards: StandardsReport | null; spec: SpecReport | null };

/** Findings the implementer must fix: every spec finding and every documented-standard violation. */
export function mustFix(review: CodeReview): { standards: StandardsFinding[]; spec: SpecFinding[] } {
  return {
    standards: (review.standards?.findings ?? []).filter((finding) => finding.kind === 'violation'),
    spec: review.spec?.findings ?? [],
  };
}

/** Smells: judgement calls, which never block the pull request. */
export const judgementCalls = (review: CodeReview) =>
  (review.standards?.findings ?? []).filter((finding) => finding.kind === 'smell');

export function needsFixes(review: CodeReview): boolean {
  const { standards, spec } = mustFix(review);
  return standards.length + spec.length > 0;
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  type CodeReview,
  judgementCalls,
  loadCodeReviewSkill,
  mustFix,
  needsFixes,
  parseCodeReviewSkill,
  standardsSources,
} from '../src/code-review.ts';
import { MATTPOCOCK_SKILLS } from '../src/skills.ts';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phat-review-'));
  dirs.push(dir);
  return dir;
};
const ownText = () => readFile(new URL('../skills/code-review/SKILL.md', import.meta.url), 'utf8');

const SMELLS = [
  'Mysterious Name', 'Duplicated Code', 'Feature Envy', 'Data Clumps', 'Primitive Obsession', 'Repeated Switches',
  'Shotgun Surgery', 'Divergent Change', 'Speculative Generality', 'Message Chains', 'Middle Man', 'Refused Bequest',
];

describe('parseCodeReviewSkill', () => {
  test('reads phat-mode’s pinned copy: both briefs verbatim and the full smell baseline', async () => {
    const skill = await loadCodeReviewSkill();
    assert.equal(skill.source, MATTPOCOCK_SKILLS.label);
    assert.match(skill.standardsBrief, /^Report, per file\/hunk where relevant, \(a\) every place the diff violates a documented standard/);
    assert.match(skill.standardsBrief, /Skip anything tooling enforces\. Under 400 words\.$/);
    assert.match(skill.specBrief, /^Report: \(a\) requirements the spec asked for that are missing or partial/);
    assert.match(skill.specBrief, /Quote the spec line for each finding\. Under 400 words\.$/);
    assert.match(skill.smellBaseline, /^On top of whatever the repo documents/);
    assert.match(skill.smellBaseline, /\*\*The repo overrides\.\*\*/);
    assert.match(skill.smellBaseline, /\*\*Always a judgement call\.\*\*/);
    for (const smell of SMELLS) assert.match(skill.smellBaseline, new RegExp(`\\*\\*${smell}\\*\\*`), smell);
    assert.doesNotMatch(skill.smellBaseline, /### 4/, 'stops before step 4');
  });

  test('undefined when the layout changed beyond recognition', async () => {
    assert.equal(parseCodeReviewSkill('# Something else', 'x'), undefined);
    const withoutBriefs = (await ownText()).replaceAll('- The brief:', '- Brief:');
    assert.equal(parseCodeReviewSkill(withoutBriefs, 'x'), undefined);
  });
});

describe('standardsSources', () => {
  test('lists the standards files that exist, and docs', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'docs/adr'), { recursive: true });
    await mkdir(join(dir, '.github'), { recursive: true });
    for (const file of ['AGENTS.md', 'CONTRIBUTING.md', '.github/copilot-instructions.md', 'docs/adr/0001-storage.md', 'docs/notes.txt']) {
      await writeFile(join(dir, file), 'x');
    }
    assert.deepEqual(await standardsSources(dir), [
      'CONTRIBUTING.md',
      'AGENTS.md',
      '.github/copilot-instructions.md',
      'docs/adr/0001-storage.md',
    ]);
  });
});

describe('what blocks the pull request', () => {
  const report = <F>(findings: F[]) => ({ summary: '', worst: '', findings });
  const smell = { kind: 'smell' as const, where: 'a.ts', rule: 'possible Feature Envy', detail: '' };
  const violation = { kind: 'violation' as const, where: 'a.ts', rule: 'AGENTS.md', detail: '' };
  const bug = { kind: 'bug' as const, where: 'a.ts', specLine: '', detail: '' };

  test('smells are judgement calls and never block', () => {
    const review: CodeReview = { round: 1, standards: report([smell]), spec: report([]) };
    assert.equal(needsFixes(review), false);
    assert.deepEqual(judgementCalls(review), [smell]);
  });

  test('a documented-standard violation blocks', () => {
    const review: CodeReview = { round: 1, standards: report([smell, violation]), spec: report([]) };
    assert.equal(needsFixes(review), true);
    assert.deepEqual(mustFix(review).standards, [violation]);
  });

  test('every spec finding blocks, including phat-mode’s bugs', () => {
    assert.equal(needsFixes({ round: 1, standards: report([]), spec: report([bug]) }), true);
  });

  test('a reviewer that did not report blocks nothing', () => {
    assert.equal(needsFixes({ round: 1, standards: null, spec: null }), false);
  });
});

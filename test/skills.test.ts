import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { installProjectSkills } from '../src/init.ts';
import { AI_TRIAGE_DISCLAIMER } from '../src/messages.ts';
import { PR_SECTIONS, prSkill } from '../src/pr.ts';
import { MATTPOCOCK_SKILLS, PROJECT_SKILLS, skillBody } from '../src/skills.ts';

const file = (path: string) => readFile(new URL(`../skills/${path}`, import.meta.url), 'utf8');

/**
 * Skills named in the docs `setup-matt-pocock-skills` writes into a repo, as other users of those docs. Not
 * dependencies: nothing here calls them.
 */
const NOT_DEPENDENCIES: Record<string, string> = {
  wayfinder: 'its operations are in the issue tracker doc',
  'grill-with-docs': 'the domain doc says it reaches domain-modeling',
  'improve-codebase-architecture': 'the domain doc says it reaches domain-modeling',
};

/** Skills a skill's text refers to: `/name`, the `name` skill, or a Skill tool call naming it. */
function skillRefs(text: string): string[] {
  const names = [...text.matchAll(/`\/([a-z][a-z-]*)`|the `([a-z][a-z-]*)` skill/g)].map((match) => match[1] ?? match[2]!);
  for (const call of text.matchAll(/Skill tool[^.]*/g)) names.push(...[...call[0].matchAll(/"([a-z][a-z-]*)"/g)].map((match) => match[1]!));
  return names;
}

describe('pinned mattpocock/skills', () => {
  for (const skill of ['code-review', 'pr', ...PROJECT_SKILLS]) {
    test(`${skill}: README documents the pinned commit; Matt Pocock's MIT license ships`, async () => {
      assert.ok((await file(`${skill}/README.md`)).includes(MATTPOCOCK_SKILLS.commit));
      assert.match(await file(`${skill}/LICENSE`), /^MIT License\n\nCopyright \(c\) 2026 Matt Pocock/);
    });
  }

  test('pr: credits Dex Horthy for the Summary visuals', async () => {
    assert.match(await file('pr/CREDITS.md'), /Dex Horthy/);
  });

  test('pr: the template still has every section phat-mode fills', async () => {
    const skill = await prSkill();
    assert.equal(skill.source, 'mattpocock/skills@49dd158');
    for (const section of PR_SECTIONS) assert.ok(skill.text.includes(section), section);
    assert.match(skill.text, /^Use this template for writing the PR body:/, 'front matter removed');
  });

  for (const skill of PROJECT_SKILLS) {
    test(`${skill}: an installable skill named ${skill}`, async () => {
      assert.match(await file(`${skill}/SKILL.md`), new RegExp(`^---\\nname: ${skill}\\n`));
    });
  }

  test('triage: phat-mode hands back in its format', async () => {
    const triage = await file('triage/SKILL.md');
    for (const part of [AI_TRIAGE_DISCLAIMER, '## Triage Notes', "**What we've established so far:**", '**What we still need from you (@reporter):**'])
      assert.ok(triage.includes(part), part);
    assert.match(await file('triage/AGENT-BRIEF.md'), /Agent Brief/);
  });

  test('every skill a project skill refers to is installed with it', async () => {
    const found = new Map<string, Set<string>>();
    for (const skill of PROJECT_SKILLS) {
      const docs = (await readdir(new URL(`../skills/${skill}/`, import.meta.url))).filter((name) => name.endsWith('.md') && name !== 'README.md');
      for (const doc of docs) for (const name of skillRefs(await file(`${skill}/${doc}`))) {
        if (name !== skill) found.set(name, (found.get(name) ?? new Set()).add(skill));
      }
    }
    // The dependencies found this way, so a reference that stops matching fails too.
    for (const [skill, users] of [['grilling', 'triage'], ['domain-modeling', 'triage'], ['codebase-design', 'tdd'], ['code-review', 'tdd'], ['setup-matt-pocock-skills', 'code-review']])
      assert.ok(found.get(skill!)?.has(users!), `${users} → ${skill}`);
    for (const [name, users] of found) {
      if (name in NOT_DEPENDENCIES) continue;
      assert.ok(PROJECT_SKILLS.includes(name as never), `${[...users].join(', ')} refers to ${name}, which init does not install`);
    }
  });

  test('to-tickets and to-spec: write the sections phat-mode reads', async () => {
    const tickets = await file('to-tickets/SKILL.md');
    for (const section of ['## Parent', '## Acceptance criteria', '## Blocked by']) assert.ok(tickets.includes(section), section);
    assert.ok((await file('to-spec/SKILL.md')).includes('## Out of Scope'));
  });

  test('skillBody strips front matter only', () => {
    assert.equal(skillBody('---\nname: x\ndescription: "y"\n---\n\nBody\n---\nmore'), 'Body\n---\nmore');
    assert.equal(skillBody('No front matter'), 'No front matter');
  });
});

describe('installProjectSkills', () => {
  const repo = async (files: Record<string, string> = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'phat-mode-skills-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    }
    return root;
  };

  test('copies every project skill into .agents/skills, with its reference files and license', async () => {
    const root = await repo();
    try {
      const result = await installProjectSkills(root);
      assert.deepEqual(result, { installed: PROJECT_SKILLS.map((skill) => `.agents/skills/${skill}`), kept: [], linked: [] });
      assert.equal(await readFile(join(root, '.agents/skills/triage/SKILL.md'), 'utf8'), await file('triage/SKILL.md'));
      assert.equal(await readFile(join(root, '.agents/skills/triage/AGENT-BRIEF.md'), 'utf8'), await file('triage/AGENT-BRIEF.md'));
      assert.match(await readFile(join(root, '.agents/skills/to-spec/LICENSE'), 'utf8'), /Matt Pocock/);
      assert.equal(await readFile(join(root, '.agents/skills/tdd/mocking.md'), 'utf8'), await file('tdd/mocking.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the repo's own copy, in any skills folder", async () => {
    const root = await repo({ '.agents/skills/triage/SKILL.md': 'mine', '.claude/skills/to-spec/SKILL.md': 'mine too' });
    try {
      const result = await installProjectSkills(root);
      assert.deepEqual(result.kept, ['.agents/skills/triage', '.claude/skills/to-spec']);
      assert.deepEqual(
        result.installed,
        PROJECT_SKILLS.filter((skill) => skill !== 'triage' && skill !== 'to-spec').map((skill) => `.agents/skills/${skill}`),
      );
      assert.equal(await readFile(join(root, '.agents/skills/triage/SKILL.md'), 'utf8'), 'mine');
      // Running init again changes nothing.
      assert.deepEqual((await installProjectSkills(root)).installed, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('links them into .claude/skills when the repo uses Claude Code', async () => {
    const root = await repo({ 'CLAUDE.md': '# Rules' });
    try {
      const result = await installProjectSkills(root);
      assert.deepEqual(result.linked, PROJECT_SKILLS.map((skill) => `.claude/skills/${skill}`));
      assert.ok((await lstat(join(root, '.claude/skills/triage'))).isSymbolicLink());
      assert.equal(await readlink(join(root, '.claude/skills/triage')), '../../.agents/skills/triage');
      assert.equal(await readFile(join(root, '.claude/skills/triage/SKILL.md'), 'utf8'), await file('triage/SKILL.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

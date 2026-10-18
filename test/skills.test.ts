import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { PR_SECTIONS, prSkill } from '../src/pr.ts';
import { MATTPOCOCK_SKILLS, skillBody } from '../src/skills.ts';

const file = (path: string) => readFile(new URL(`../skills/${path}`, import.meta.url), 'utf8');

describe('pinned mattpocock/skills', () => {
  for (const skill of ['code-review', 'pr']) {
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

  test('skillBody strips front matter only', () => {
    assert.equal(skillBody('---\nname: x\ndescription: "y"\n---\n\nBody\n---\nmore'), 'Body\n---\nmore');
    assert.equal(skillBody('No front matter'), 'No front matter');
  });
});

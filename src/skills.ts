import { readFile } from 'node:fs/promises';

/**
 * phat-mode follows two of mattpocock/skills' skills, pinned in skills/: `code-review` for its reviewers and `pr` for
 * the pull request description. Pinned, so they are the same on every repo and exactly what the tests cover; a copy
 * installed in the repo under review is never used. Upgrade both together: copy the new upstream files into skills/,
 * update `commit` here and in skills/<name>/README.md, and run `npm test`.
 */
export const MATTPOCOCK_SKILLS = {
  commit: '49dd158d1076134a641b33efb035946536778336',
  get short() {
    return this.commit.slice(0, 7);
  },
  /** e.g. `mattpocock/skills@49dd158`. */
  get label() {
    return `mattpocock/skills@${this.short}`;
  },
  url(skill: string) {
    return `https://github.com/mattpocock/skills/blob/${this.commit}/skills/engineering/${skill}/SKILL.md`;
  },
};

/** A pinned skill's SKILL.md. */
export const readSkill = (skill: string) => readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');

/** SKILL.md without its front matter. */
export const skillBody = (text: string) => text.replace(/^---\n[^]*?\n---\n+/, '').trim();

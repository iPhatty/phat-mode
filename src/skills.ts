import { readFile } from 'node:fs/promises';

/**
 * phat-mode follows two of mattpocock/skills' skills, pinned in skills/: `code-review` for its reviewers and `pr` for
 * the pull request description. Pinned, so they are the same on every repo and exactly what the tests cover; a copy
 * installed in the repo under review is never used. It also pins the skills people use alongside it
 * (`PROJECT_SKILLS`), which `phat-mode init` installs into the repo. Upgrade all together: copy the new upstream files
 * into skills/, update `commit` here and in skills/<name>/README.md, and run `npm test`.
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

/**
 * What `phat-mode init` copies into the repo: the skills that make an issue ready-for-agent (`triage`, `to-tickets`,
 * `to-spec`) and `tdd`, with every skill they depend on, so each works on its own:
 * - `setup-matt-pocock-skills`: writes the issue tracker and label settings `triage`, `to-tickets`, `to-spec` and
 *   `code-review` need.
 * - `grilling`, `domain-modeling`: `triage` calls them to flesh an issue out.
 * - `codebase-design`, `code-review`: `tdd` calls the first for its vocabulary and leaves refactoring to the second.
 * phat-mode itself runs none of them (its reviewers use its own copy of `code-review`). The tests fail if an upgrade
 * makes one of them refer to a skill that is not here.
 */
export const PROJECT_SKILLS = [
  'setup-matt-pocock-skills',
  'triage',
  'to-tickets',
  'to-spec',
  'tdd',
  'grilling',
  'domain-modeling',
  'codebase-design',
  'code-review',
] as const;

/**
 * pstack's verification skills, pinned in skills/ like Matt's: phat-mode's verifier follows the repo's own `verify-<app>`
 * skill (see verify.ts), and these are how a repo makes one and keeps it current. To upgrade: copy the new upstream
 * files into skills/, update `commit` here and in skills/<name>/README.md, and run `npm test`.
 */
export const PSTACK_SKILLS = {
  commit: 'ae5650febf4320793844c12c4adaa937f417f8da',
  get short() {
    return this.commit.slice(0, 7);
  },
  /** e.g. `pstack@ae5650f`. */
  get label() {
    return `pstack@${this.short}`;
  },
};

/**
 * What `phat-mode init` copies into the repo for verification: `create-verification-skill` writes the `verify-<app>`
 * skill, so it is only installed while the repo has none; `maintain-verification-skill` keeps it current (the PR points
 * at it when the verifier finds the feature map drifting), so it is always installed.
 */
export const VERIFICATION_SKILLS = ['create-verification-skill', 'maintain-verification-skill'] as const;

/** A pinned skill's folder. */
export const skillDir = (skill: string) => new URL(`../skills/${skill}/`, import.meta.url);

/** A pinned skill's SKILL.md. */
export const readSkill = (skill: string) => readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');

/** SKILL.md without its front matter. */
export const skillBody = (text: string) => text.replace(/^---\n[^]*?\n---\n+/, '').trim();

import { MATTPOCOCK_SKILLS, readSkill, skillBody } from './skills.ts';

/** mattpocock/skills' `pr` skill, which the implementer follows to write the pull request description. */
export type PrSkill = { source: string; text: string };

/** The sections of the skill's template; phat-mode's PR body fills each one. */
export const PR_SECTIONS = ['## Summary', '## Evidence', '## Merge Danger'] as const;

let loaded: Promise<PrSkill> | undefined;

/** phat-mode's pinned copy of the skill (see src/skills.ts). */
export function prSkill(): Promise<PrSkill> {
  loaded ??= readSkill('pr').then((text) => {
    const missing = PR_SECTIONS.filter((section) => !text.includes(section));
    if (missing.length > 0) {
      throw new Error(`phat-mode's pr skill (skills/pr/SKILL.md) no longer has ${missing.join(', ')} in its template`);
    }
    return { source: MATTPOCOCK_SKILLS.label, text: skillBody(text) };
  });
  return loaded;
}

/**
 * Who supplied a piece of evidence. `phat-mode`: something the pipeline itself ran, so it is verified.
 * `implementer`: what the implementer says it observed. A verification agent will add its own source.
 */
export type EvidenceSource = 'implementer' | 'phat-mode';
export type Evidence = { source: EvidenceSource; before: string; after: string };

import { defineExtension, type Extension, section } from '@earendil-works/pi-durable';
import { RoleDoc } from './agents.ts';
import { standingSkillsText } from './prompts.ts';
import { standingSkills } from './skills.ts';

/**
 * Each role's standing skills (`STANDING_SKILLS`), in a system prompt section: rendered before every request from the
 * conversation's role, so they are there on every request, also after a compaction, and no agent can skip loading them.
 * A role without standing skills gets no section. Conversations follow the host default extensions, so this also
 * applies to conversations of runs started before it existed.
 */
export const Skills: Extension = defineExtension({
  name: 'phat.skills',
  sections: [
    section('skills', async (input, context) => {
      const role = (await input.read.snapshot(RoleDoc, input.conversationId, context))?.role;
      if (role === null || role === undefined) return undefined;
      return standingSkillsText(role, await standingSkills(role));
    }),
  ],
});

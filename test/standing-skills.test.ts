import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context as ModelContext } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { AGENTS, type Agent, RoleDoc, SHAPE_AGENTS, Tools } from '../src/agents.ts';
import { AUTONOMY_OVERLAY, TDD_OVERLAY, standingSkillsText } from '../src/prompts.ts';
import { skillBody, STANDING_SKILLS, standingSkills } from '../src/skills.ts';
import { Skills } from '../src/standing-skills.ts';
import { sectionsOf, textOf } from './fixture.ts';

const context = BACKGROUND_CONTEXT;
const pinned = async (skill: string, file = 'SKILL.md') =>
  (await readFile(new URL(`../skills/${skill}/${file}`, import.meta.url), 'utf8')).trim();
const skillTag = async (skill: string) =>
  `<skill name="${skill}" source="mattpocock/skills@49dd158">\n${skillBody(await pinned(skill))}\n</skill>`;
const referenceTag = async (skill: string, file: string) =>
  `<skill-reference skill="${skill}" file="${file}">\n${await pinned(skill, file)}\n</skill-reference>`;
const rendered = async (role: Agent) => standingSkillsText(role, await standingSkills(role));

describe('standing skills', () => {
  test('the questioner: the pinned grilling skill, then the autonomy overlay', async () => {
    const text = (await rendered('question'))!;
    assert.ok(text.includes(await skillTag('grilling')));
    assert.ok(text.indexOf(await skillTag('grilling')) < text.indexOf(AUTONOMY_OVERLAY), 'the overlay after the skill');
    assert.doesNotMatch(text, /<skill-reference/);
  });

  test('the planner: codebase-design with its reference docs, and no overlay', async () => {
    const text = (await rendered('plan'))!;
    assert.ok(text.includes(await skillTag('codebase-design')));
    for (const file of ['DEEPENING.md', 'DESIGN-IT-TWICE.md']) assert.ok(text.includes(await referenceTag('codebase-design', file)));
    assert.doesNotMatch(text, /overlay/);
  });

  test('the implementer: tdd with tests.md and mocking.md, then the unattended-TDD overlay', async () => {
    const text = (await rendered('implement'))!;
    assert.ok(text.includes(await skillTag('tdd')));
    for (const file of ['tests.md', 'mocking.md']) assert.ok(text.includes(await referenceTag('tdd', file)));
    assert.ok(text.includes(TDD_OVERLAY));
    assert.match(TDD_OVERLAY, /^the user is the planner\. The tests the plan names are the agreed seams/);
    assert.match(TDD_OVERLAY, /add it and say so in report_done/);
  });

  test('every other role: none', async () => {
    for (const role of ['answer', 'standards', 'spec', 'verify'] as const) {
      assert.deepEqual(STANDING_SKILLS[role], []);
      assert.equal(await rendered(role), undefined, role);
    }
  });

  test('every standing skill and reference is pinned in skills/', async () => {
    for (const role of [...AGENTS, ...SHAPE_AGENTS]) {
      for (const skill of STANDING_SKILLS[role]) {
        await pinned(skill.name);
        for (const file of skill.references) await pinned(skill.name, file);
      }
    }
  });

  test('the section is on every request of a role’s conversation, also after a compaction', async () => {
    const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
    const seen: { last: string; all: string[]; skills: string | undefined }[] = [];
    const answer = (text: string) => (request: ModelContext) => {
      seen.push({
        last: textOf(request.messages.at(-1) as { content: unknown }),
        all: request.messages.map((message) => textOf(message as { content: unknown })),
        skills: sectionsOf(request).skills,
      });
      return fauxAssistantMessage(text);
    };
    faux.setResponses([answer('first answer'), answer('the summary'), answer('second answer')]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(Tools);
    registry.install(Skills);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, settings: { compaction: { enabled: false, keepRecentTokens: 0 } } },
      context,
    );
    try {
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      await root.commit(async (tx) => {
        Object.assign(await tx.doc(RoleDoc, root.id), { role: 'question', issue: 1, workspace: null });
      }, context);
      const submit = async (content: string) => {
        const settled = await (await root.submit({ type: 'input', content }, context)).wait(context);
        assert.equal(settled.status, 'done');
      };
      await submit('round 1');
      const compaction = await harness.waitForTask(await root.compact(undefined, context), context);
      assert.equal(compaction.state.status, 'terminal');
      const { outcome } = compaction.state;
      assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
      if (outcome.status === 'completed' && outcome.result.submissionId !== undefined) {
        const placed = await (await harness.submission(outcome.result.submissionId, context))!.wait(context);
        assert.equal(placed.status, 'done', JSON.stringify(placed));
      }
      await submit('round 2');

      assert.equal(seen.length, 3, 'the first request, the summary, the request after compaction');
      const after = seen[2]!;
      assert.equal(after.last, 'round 2');
      assert.ok(!after.all.includes('round 1'), 'compacted: the first request is summarised away');
      assert.ok(after.all.some((text) => text.includes('the summary')));
      for (const request of [seen[0]!, after]) {
        assert.ok(request.skills?.includes(await skillTag('grilling')), `grilling in: ${request.last}`);
        assert.ok(request.skills?.includes(AUTONOMY_OVERLAY));
      }
    } finally {
      await harness.close(context);
    }
  });
});

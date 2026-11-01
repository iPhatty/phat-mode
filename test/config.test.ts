import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { defaultMachineConfig, loadMachineConfig, modelFor, parseRepoSettings, repoConfig } from '../src/config.ts';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function withConfig(json: unknown) {
  const home = await mkdtemp(join(tmpdir(), 'phat-config-'));
  dirs.push(home);
  if (json !== undefined) await writeFile(join(home, 'config.json'), JSON.stringify(json));
  return loadMachineConfig(home);
}

const opus = { provider: 'github-copilot', modelId: 'claude-opus-5.5', thinkingLevel: 'medium' };
const gpt = { provider: 'github-copilot', modelId: 'gpt-6.1-sol', thinkingLevel: 'medium' };

describe('models', () => {
  test('built in: Claude Opus 5.5 (medium) by default, GPT-6.1 Sol reviews', () => {
    const config = defaultMachineConfig('/tmp/unused');
    assert.deepEqual(config.defaultModel, opus);
    assert.deepEqual(modelFor(config, 'plan'), opus);
    assert.deepEqual(modelFor(config, 'implement'), opus);
    assert.deepEqual(modelFor(config, 'review'), gpt);
  });

  test('no config.json: the built-in models', async () => {
    const config = await withConfig(undefined);
    assert.deepEqual(modelFor(config, 'implement'), opus);
    assert.deepEqual(modelFor(config, 'review'), gpt);
  });

  test('defaultModel changes every role without its own model', async () => {
    const config = await withConfig({ defaultModel: { modelId: 'claude-sonnet-5.5' } });
    assert.deepEqual(modelFor(config, 'plan'), { ...opus, modelId: 'claude-sonnet-5.5' });
    assert.deepEqual(modelFor(config, 'implement'), { ...opus, modelId: 'claude-sonnet-5.5' });
    assert.deepEqual(modelFor(config, 'review'), gpt, 'the reviewer keeps its own model');
  });

  test('a role override can change one field and keep the rest', async () => {
    const config = await withConfig({ models: { implement: { thinkingLevel: 'high' }, review: { thinkingLevel: 'low' } } });
    assert.deepEqual(modelFor(config, 'implement'), { ...opus, thinkingLevel: 'high' });
    assert.deepEqual(modelFor(config, 'review'), { ...gpt, thinkingLevel: 'low' });
    assert.deepEqual(modelFor(config, 'plan'), opus);
  });

  test('"review": null makes the reviewer follow defaultModel', async () => {
    const config = await withConfig({ defaultModel: { thinkingLevel: 'high' }, models: { review: null } });
    assert.deepEqual(modelFor(config, 'review'), { ...opus, thinkingLevel: 'high' });
  });

  test('agent mode: GPT-6.1 Sol grills, defaultModel shapes', async () => {
    const config = defaultMachineConfig('/tmp/unused');
    assert.deepEqual(modelFor(config, 'grill'), gpt);
    assert.deepEqual(modelFor(config, 'shape'), opus);
    const changed = await withConfig({ defaultModel: { modelId: 'claude-sonnet-5.5' } });
    assert.deepEqual(modelFor(changed, 'shape'), { ...opus, modelId: 'claude-sonnet-5.5' });
    assert.deepEqual(modelFor(changed, 'grill'), gpt, 'the questioner keeps its own model');
  });

  test('the grill and shape roles can be overridden, and "grill": null follows defaultModel', async () => {
    const config = await withConfig({ models: { grill: { modelId: 'x' }, shape: { thinkingLevel: 'high' } } });
    assert.deepEqual(modelFor(config, 'grill'), { ...gpt, modelId: 'x' });
    assert.deepEqual(modelFor(config, 'shape'), { ...opus, thinkingLevel: 'high' });
    const followed = await withConfig({ models: { grill: null } });
    assert.deepEqual(modelFor(followed, 'grill'), opus);
  });

  test('other settings keep their defaults when config.json sets only models', async () => {
    const config = await withConfig({ defaultModel: { thinkingLevel: 'high' } });
    assert.deepEqual(config.repos, []);
    assert.equal(config.limits.maxCheckFixes, 3);
  });
});

describe('limits', () => {
  test('an override keeps the other limits', async () => {
    const config = await withConfig({ limits: { maxReviewRounds: 3 } });
    assert.equal(config.limits.maxReviewRounds, 3);
    assert.equal(config.limits.maxCheckFixes, 3);
  });
});

describe('config.json (yours, for every repo)', () => {
  test('repos and trusted authors', async () => {
    const config = await withConfig({ repos: ['iPhatty/phatty-lingo', 'iPhatty/other'], allowedAuthors: ['iPhatty', 'friend'] });
    assert.deepEqual(config.repos, ['iPhatty/phatty-lingo', 'iPhatty/other']);
    assert.deepEqual(config.allowedAuthors, ['iPhatty', 'friend']);
  });

  test('repo settings are refused, pointing to .phat-mode.json', async () => {
    await assert.rejects(withConfig({ checkCommand: 'npm test' }), /checkCommand belong in each repo's \.phat-mode\.json/);
    await assert.rejects(withConfig({ repo: 'a/b' }), /repo belong in each repo's/);
  });

  test('typos and bad values fail loudly', async () => {
    await assert.rejects(withConfig({ modles: {} }), /unknown setting\(s\) modles/);
    await assert.rejects(withConfig({ repos: ['phatty-lingo'] }), /"repos" must be a list of "owner\/name"/);
    await assert.rejects(withConfig({ allowedAuthors: 'iPhatty' }), /"allowedAuthors" must be a non-empty list/);
  });
});

describe('.phat-mode.json (each repo\'s)', () => {
  const parse = (json: unknown) => parseRepoSettings(JSON.stringify(json));

  test('install and check commands, plus optional base branch, trusted authors and labels', () => {
    assert.deepEqual(parse({ installCommand: 'npm ci', checkCommand: 'npm run check' }), {
      installCommand: 'npm ci',
      checkCommand: 'npm run check',
    });
    assert.deepEqual(
      parse({ $schema: 'x', installCommand: 'true', checkCommand: 'make check', baseBranch: 'develop', allowedAuthors: ['a'], labels: { readyForAgent: 'agent' } }),
      { installCommand: 'true', checkCommand: 'make check', baseBranch: 'develop', allowedAuthors: ['a'], labels: { readyForAgent: 'agent' } },
    );
  });

  test('labels.agentMode renames the agent-mode label', () => {
    assert.deepEqual(parse({ installCommand: 'a', checkCommand: 'b', labels: { agentMode: 'shape-me' } }).labels, { agentMode: 'shape-me' });
    assert.throws(() => parse({ installCommand: 'a', checkCommand: 'b', labels: { agentMode: 'x', shaped: 'y' } }), /"labels" may only rename .*agentMode/);
    assert.throws(() => parse({ installCommand: 'a', checkCommand: 'b', agentMode: 'x' }), /unknown setting\(s\) agentMode/);
  });

  test('both commands are required: phat-mode never guesses them', () => {
    assert.throws(() => parse({ installCommand: 'npm ci' }), /"checkCommand" is required/);
    assert.throws(() => parse({ checkCommand: 'npm test', installCommand: ' ' }), /"installCommand" is required/);
  });

  test('typos and bad values fail loudly', () => {
    assert.throws(() => parse({ installCommand: 'a', checkCommand: 'b', checkComand: 'c' }), /unknown setting\(s\) checkComand/);
    assert.throws(() => parse({ installCommand: 'a', checkCommand: 'b', labels: { ready: 'x' } }), /"labels" may only rename/);
    assert.throws(() => parse({ installCommand: 'a', checkCommand: 'b', allowedAuthors: [] }), /"allowedAuthors" must be a non-empty list/);
    assert.throws(() => parseRepoSettings('{ nope'), /not valid JSON/);
    assert.throws(() => parse(['a']), /must be a JSON object/);
  });
});

describe('repoConfig', () => {
  const machine = defaultMachineConfig('/tmp/unused');
  const settings = { installCommand: 'npm ci', checkCommand: 'npm run check' };
  const github = { defaultBranch: 'trunk', viewer: 'iPhatty' };

  test('the repo\'s commands; its default branch; default labels; your models and limits', () => {
    const config = repoConfig(machine, 'o/r', settings, github);
    assert.equal(config.repo, 'o/r');
    assert.equal(config.baseBranch, 'trunk');
    assert.equal(config.checkCommand, 'npm run check');
    assert.equal(config.labels.readyForAgent, 'ready-for-agent');
    assert.equal(config.labels.agentMode, 'agent-mode');
    assert.deepEqual(config.defaultModel, machine.defaultModel);
    assert.equal('repos' in config, false);
  });

  test('trusted authors: the repo\'s list, else yours, else you', () => {
    assert.deepEqual(repoConfig(machine, 'o/r', settings, github).allowedAuthors, ['iPhatty']);
    assert.deepEqual(repoConfig({ ...machine, allowedAuthors: ['me', 'pal'] }, 'o/r', settings, github).allowedAuthors, ['me', 'pal']);
    assert.deepEqual(
      repoConfig({ ...machine, allowedAuthors: ['me'] }, 'o/r', { ...settings, allowedAuthors: ['team'] }, github).allowedAuthors,
      ['team'],
    );
  });

  test('base branch and labels from the repo override the defaults', () => {
    const config = repoConfig(machine, 'o/r', { ...settings, baseBranch: 'develop', labels: { readyForAgent: 'agent' } }, github);
    assert.equal(config.baseBranch, 'develop');
    assert.equal(config.labels.readyForAgent, 'agent');
    assert.equal(config.labels.needsInfo, 'needs-info');
    const renamed = repoConfig(machine, 'o/r', { ...settings, labels: { agentMode: 'shape-me' } }, github);
    assert.equal(renamed.labels.agentMode, 'shape-me');
  });
});

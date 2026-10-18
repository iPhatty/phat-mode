import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { defaultConfig, loadConfig, modelFor } from '../src/config.ts';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function withConfig(json: unknown) {
  const home = await mkdtemp(join(tmpdir(), 'phat-config-'));
  dirs.push(home);
  if (json !== undefined) await writeFile(join(home, 'config.json'), JSON.stringify(json));
  return loadConfig(home);
}

const opus = { provider: 'github-copilot', modelId: 'claude-opus-5.5', thinkingLevel: 'medium' };
const gpt = { provider: 'github-copilot', modelId: 'gpt-6.1-sol', thinkingLevel: 'medium' };

describe('models', () => {
  test('built in: Claude Opus 5.5 (medium) by default, GPT-6.1 Sol reviews', () => {
    const config = defaultConfig('/tmp/unused');
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

  test('other settings keep their defaults when config.json sets only models', async () => {
    const config = await withConfig({ defaultModel: { thinkingLevel: 'high' } });
    assert.equal(config.repo, 'iPhatty/phatty-lingo');
    assert.equal(config.labels.readyForAgent, 'ready-for-agent');
    assert.equal(config.limits.maxCheckFixes, 3);
  });
});

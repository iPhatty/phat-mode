import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { branchFor, type Config, paths } from '../src/config.ts';
import { run } from '../src/exec.ts';
import { openPhatMode, type RunKind } from '../src/harness.ts';
import { silentLogger } from '../src/log.ts';
import type { Services } from '../src/pipeline.ts';
import { type CheckResult, type Checks, GitWorkspaces } from '../src/workspace.ts';
import { FakeGitHub, testConfig } from './fakes.ts';

/**
 * The seam the end-to-end tests use: a durable task (building or shaping) with a scripted fake model, a fake GitHub and
 * real git.
 */

const context = BACKGROUND_CONTEXT;

// ─── Fakes ──────────────────────────────────────────────────────────────────

export class FakeChecks implements Checks {
  results: CheckResult[] = [];
  runs = 0;
  async run(): Promise<CheckResult> {
    this.runs++;
    return this.results.shift() ?? { passed: true, output: 'all good' };
  }
}

export const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

/** A response that first checks what the agent just saw: the last message of the request. */
export const expectLast = (check: (message: ToolResultMessage | { role: string; content: unknown }) => void, then: FauxResponseStep): FauxResponseFactory =>
  (request, options, state, model) => {
    check(request.messages.at(-1) as ToolResultMessage);
    return typeof then === 'function' ? then(request, options, state, model) : then;
  };
export const textOf = (message: { content: unknown }) =>
  typeof message.content === 'string'
    ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');
// ─── Fixture ────────────────────────────────────────────────────────────────

const temp: string[] = [];
after(async () => {
  for (const dir of temp) {
    // Shaping's checkouts are read-only.
    await run('chmod', ['-R', 'u+w', dir], { allowFailure: true });
    await rm(dir, { recursive: true, force: true });
  }
});

/** `files`: extra files committed to the repo's main branch. */
export async function fixture(files: Record<string, string> = {}, repo = 'test/repo') {
  const dir = await mkdtemp(join(tmpdir(), 'phat-pipeline-'));
  temp.push(dir);
  // A local "GitHub" repository with one commit on main.
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  await run('git', ['init', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), '# test\n');
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(seed, file)), { recursive: true });
    await writeFile(join(seed, file), content);
  }
  const git = (args: string[], cwd = seed) =>
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
  await git(['push', remote, 'main']);

  const config: Config = {
    ...testConfig(join(dir, 'home'), repo),
    defaultModel: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'medium' },
    // Shaping's questioner on a model of its own, so tests can tell the two conversations apart.
    models: { grill: { modelId: 'faux-grill' } },
  };
  const github = new FakeGitHub();
  const checks = new FakeChecks();
  const services: Services = {
    config,
    github,
    checks,
    logger: silentLogger,
    workspaces: new GitWorkspaces({
      remoteUrl: remote,
      baseBranch: 'main',
      cloneDir: paths.repoClone(config),
      workspaceDir: (issue) => paths.workspace(config, issue),
      baseWorkspaceDir: paths.baseWorkspace(config),
    }),
  };
  // Commits in the workspace need an identity; the real CLI uses the user's git config.
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'phat-mode-test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';

  /** `servicesFor`: for runs on other repos too; by default, every run is on this one. */
  const open = async (responses: FauxResponseStep[], servicesFor = async (_repo: string) => services) => {
    const faux = fauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-grill' }] });
    faux.setResponses(responses);
    const models = createModels();
    models.setProvider(faux.provider);
    const storage = () => openNodeSqliteStorage(join(dir, 'state.sqlite'));
    const phat = await openPhatMode({ home: config.home, servicesFor }, context, { storage, models });
    return { phat, faux };
  };

  const runIssue = async (issue: number, responses: FauxResponseStep[], kind: RunKind = 'build') => {
    const { phat, faux } = await open(responses);
    const { taskId } = await phat.start({ repo: config.repo, issue }, context, kind);
    phat.harness.resume();
    const { outcome } = (await phat.harness.waitForTask(taskId, context)).state;
    await phat.close(context);
    return { outcome, faux };
  };

  const remoteFile = async (issue: number, file: string) =>
    (await run('git', ['--git-dir', remote, 'show', `${branchFor(issue)}:${file}`])).stdout;

  return { config, services, github, checks, open, runIssue, remoteFile, remote };
}

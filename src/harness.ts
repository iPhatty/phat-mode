import type { Context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import type { CredentialStore, Models } from '@earendil-works/pi-ai';
import {
  type Conversation,
  createRegistry,
  defineDoc,
  Harness,
  type Storage,
  type TaskId,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Guard, Tools } from './agents.ts';
import { paths } from './config.ts';
import { FileCredentialStore } from './credentials.ts';
import { agentEnv } from './exec.ts';
import { acquireLock } from './lock.ts';
import { createPipeline, type PipelineInput, type PipelineResult, type Services } from './pipeline.ts';

/** Every run phat-mode started, newest last per issue. Stored on the root conversation. */
export const RunsDoc = defineDoc<{ runs: Record<string, { taskId: number; startedAt: number }[]> }>({
  kind: 'phat.runs',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ runs: {} }),
});

export const runKey = (input: PipelineInput) => `${input.repo}#${input.issue}`;

export function createCopilotModels(credentials: CredentialStore): Models {
  const models = createModels({ credentials });
  models.setProvider(githubCopilotProvider());
  return models;
}

export type PhatMode = {
  harness: Harness;
  root: Conversation;
  /** Start a run for an issue, or return the one still running for it. */
  start(input: PipelineInput, context: Context): Promise<{ taskId: TaskId<PipelineResult>; resumed: boolean }>;
  close(context: Context): Promise<void>;
};

export type OpenOptions = {
  /**
   * Pi Durable storage has no cross-process locking: one process may use it at a time. This lock enforces that.
   * Default: `<home>/state.sqlite.lock`. `false` only for storage that is not shared, such as in-memory storage.
   */
  lock?: { path?: string; command?: string } | false;
  /** Opens the storage; called only once the lock is held. Default: SQLite at `<home>/state.sqlite`. */
  storage?: () => Promise<Storage>;
  models?: Models;
  onReport?: (error: unknown) => void;
};

/** What phat-mode needs to open: where it lives, and how to get the services for a repo. */
export type Setup = {
  /** `<home>`: state, lock and credentials, shared by every repo. */
  home: string;
  /** The services for one repo; called once per repo that has a run. */
  servicesFor: (repo: string) => Promise<Services>;
};

export async function openPhatMode(setup: Setup, context: Context, options: OpenOptions = {}): Promise<PhatMode> {
  const config = { home: setup.home };
  const { Pipeline, extension } = createPipeline(setup.servicesFor);
  const registry = createRegistry();
  registry.install(Tools);
  registry.install(Guard);
  registry.install(extension);

  // Take the lock before touching the database, so a second process never resumes the same tasks.
  const lock =
    options.lock === false
      ? undefined
      : await acquireLock(options.lock?.path ?? paths.lock(config), options.lock?.command ?? 'phat-mode');

  let harness: Harness | undefined;
  let root: Conversation;
  try {
    const storage = await (options.storage ?? (() => openNodeSqliteStorage(paths.state(config))))();
    const models = options.models ?? createCopilotModels(new FileCredentialStore(paths.credentials(config)));
    const shellEnv = agentEnv();
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        // Each agent's tools run in its issue's workspace, without the user's tokens in the environment.
        env: ({ cwd }) => (cwd === undefined ? undefined : new NodeExecutionEnv({ cwd, shellEnv })),
        settings: { retry: { maxRetries: 3 }, stream: { timeoutMs: 300_000 } },
        onReport: (error) => options.onReport?.(error),
      },
      context,
    );
    root = await harness.root(context);
  } catch (error) {
    await harness?.close(context).catch(() => {});
    await lock?.release();
    throw error;
  }
  const opened = harness;

  async function start(input: PipelineInput, context: Context) {
    const key = runKey(input);
    const runs = (await opened.snapshot(RunsDoc, root.id, context))?.runs[key] ?? [];
    const latest = runs.at(-1);
    if (latest !== undefined) {
      const record = await opened.getTask(latest.taskId as unknown as TaskId<PipelineResult>, context);
      if (record !== undefined && record.state.status !== 'terminal') {
        return { taskId: latest.taskId as unknown as TaskId<PipelineResult>, resumed: true };
      }
    }
    const taskId = await root.commit(async (tx) => {
      // Background: runs for different issues never block each other or the root conversation.
      const id = await tx.createTask(Pipeline, input, { ownership: { kind: 'conversation' }, background: true });
      const doc = await tx.doc(RunsDoc, root.id);
      // Assign a new list: documents track assignments, not mutations of a detached array.
      doc.runs[key] = [...(doc.runs[key] ?? []), { taskId: id, startedAt: Date.now() }];
      return id;
    }, context);
    return { taskId, resumed: false };
  }

  let closed: Promise<void> | undefined;
  const close = (context: Context) =>
    (closed ??= (async () => {
      try {
        await opened.close(context);
      } finally {
        await lock?.release();
      }
    })());

  return { harness: opened, root, start, close };
}

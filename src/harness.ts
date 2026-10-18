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
  storage?: Storage;
  models?: Models;
  onReport?: (error: unknown) => void;
};

export async function openPhatMode(services: Services, context: Context, options: OpenOptions = {}): Promise<PhatMode> {
  const { config } = services;
  const { Pipeline, extension } = createPipeline(services);
  const registry = createRegistry();
  registry.install(Tools);
  registry.install(Guard);
  registry.install(extension);

  const storage = options.storage ?? (await openNodeSqliteStorage(paths.state(config)));
  const models = options.models ?? createCopilotModels(new FileCredentialStore(paths.credentials(config)));
  const shellEnv = agentEnv();

  const harness = await Harness.open(
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
  const root = await harness.root(context);

  async function start(input: PipelineInput, context: Context) {
    const key = runKey(input);
    const runs = (await harness.snapshot(RunsDoc, root.id, context))?.runs[key] ?? [];
    const latest = runs.at(-1);
    if (latest !== undefined) {
      const record = await harness.getTask(latest.taskId as unknown as TaskId<PipelineResult>, context);
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

  return { harness, root, start, close: (context) => harness.close(context) };
}

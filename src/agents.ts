import { StringEnum, Type } from '@earendil-works/pi-ai';
import {
  defineDoc,
  defineExtension,
  defineTool,
  hook,
  type Extension,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { bashBlockReason, writeBlockReason } from './guards.ts';
import { consoleLogger, type Logger, oneLine } from './log.ts';

export type Role = 'triage' | 'implement' | 'review';

/** Who a conversation is: stored with it, so hooks know its role and workspace, also after a restart. */
export const RoleDoc = defineDoc<{ role: Role | null; issue: number | null; workspace: string | null }>({
  kind: 'phat.role',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ role: null, issue: null, workspace: null }),
});

export type TriageReport = {
  decision: 'proceed' | 'needs_info' | 'reject';
  kind: 'bug' | 'feature' | 'chore' | 'docs' | 'question';
  summary: string;
  plan: string[];
  questions: string[];
};
export type DoneReport = { summary: string; testing: string };
export type ReviewReport = { verdict: 'approve' | 'changes'; summary: string; findings: string[] };

export type Report =
  | { type: 'triage'; data: TriageReport }
  | { type: 'done'; data: DoneReport }
  | { type: 'review'; data: ReviewReport };

/** Reports an agent made, in order. The pipeline reads the ones after a baseline it stored before asking. */
export const ReportsDoc = defineDoc<{ items: Report[] }>({
  kind: 'phat.reports',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ items: [] }),
});

const recorded = (text: string) => ({ output: [{ type: 'text' as const, text }], control: { terminate: true as const } });

export const reportTriage = defineTool({
  name: 'report_triage',
  description:
    'Report your triage decision. Call this exactly once, as your final action. Your turn ends when you call it.',
  parameters: Type.Object({
    decision: StringEnum(['proceed', 'needs_info', 'reject'], {
      description: 'proceed: clear enough to implement. needs_info: ask the author questions. reject: out of scope or unsafe.',
    }),
    kind: StringEnum(['bug', 'feature', 'chore', 'docs', 'question']),
    summary: Type.String({ description: 'One or two sentences: what the issue asks for, in your own words.' }),
    plan: Type.Array(Type.String(), { description: 'Implementation steps, when proceeding. Empty otherwise.' }),
    questions: Type.Array(Type.String(), { description: 'Questions for the author, when needs_info. Empty otherwise.' }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'triage', data: { ...args } as TriageReport });
    }, context);
    return recorded('Triage recorded.');
  },
});

export const reportDone = defineTool({
  name: 'report_done',
  description:
    'Report that your implementation is finished. Call this exactly once, as your final action, after `npm run check` passes.',
  parameters: Type.Object({
    summary: Type.String({ description: 'What you changed and why, for the pull request description.' }),
    testing: Type.String({ description: 'Which tests you added or changed, and what you ran.' }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'done', data: { ...args } });
    }, context);
    return recorded('Done recorded.');
  },
});

export const reportReview = defineTool({
  name: 'report_review',
  description: 'Report your review verdict. Call this exactly once, as your final action.',
  parameters: Type.Object({
    verdict: StringEnum(['approve', 'changes'], {
      description: 'approve: ready for a human to review. changes: there are problems that must be fixed first.',
    }),
    summary: Type.String({ description: 'One or two sentences on the overall change.' }),
    findings: Type.Array(Type.String(), {
      description: 'Concrete problems that must be fixed, each with file and reason. Empty when approving.',
    }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'review', data: { ...args } as ReviewReport });
    }, context);
    return recorded('Review recorded.');
  },
});

export const tools = {
  read: createReadTool(),
  bash: createBashTool(),
  write: createWriteTool(),
  edit: createEditTool(),
};

/** The tools each role may use. Only the implementer can change files. */
export const ROLE_TOOLS: Record<Role, ToolRegistration[]> = {
  triage: [tools.read, tools.bash, reportTriage],
  implement: [tools.read, tools.bash, tools.write, tools.edit, reportDone],
  review: [tools.read, tools.bash, reportReview],
};

let logger: Logger = consoleLogger;
export const setToolLogger = (next: Logger) => {
  logger = next;
};

function describeCall(name: string, args: Record<string, unknown>): string {
  if (name === 'bash') return `$ ${oneLine(String(args.command ?? ''), 90)}`;
  if (typeof args.path === 'string') return `${name} ${args.path}`;
  if (name.startsWith('report_')) return `${name} ${oneLine(JSON.stringify(args), 80)}`;
  return name;
}

/** Blocks unsafe commands and writes outside the workspace, and logs every tool call. */
export const Guard = defineExtension({
  name: 'phat.guard',
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const role = await api.snapshot(RoleDoc, api.conversationId, context);
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const label = role?.role ?? '?';
        let block: string | undefined;
        if (call.name === 'bash') {
          block = bashBlockReason(String(args.command ?? ''));
        } else if (call.name === 'write' || call.name === 'edit') {
          if (role?.role !== 'implement' || role.workspace === null) {
            block = 'Blocked: only the implementer may change files.';
          } else {
            block = writeBlockReason(String(args.path ?? ''), role.workspace);
          }
        }
        logger.tool(label, `${describeCall(call.name, args)}${block ? `  ✖ ${block}` : ''}`);
        return block === undefined ? undefined : { block };
      },
    }),
  ],
});

export const Tools: Extension = defineExtension({
  name: 'phat.tools',
  tools: [tools.read, tools.bash, tools.write, tools.edit, reportTriage, reportDone, reportReview],
});

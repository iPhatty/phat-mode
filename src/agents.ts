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

import type { SpecReport, StandardsReport } from './code-review.ts';
import type { VerificationReport } from './verify.ts';
import type { Role } from './config.ts';

/**
 * The agents of one issue. The two reviewers follow mattpocock/skills' code-review skill, one per axis, and both use
 * the `review` model.
 */
export type Agent = 'plan' | 'implement' | 'standards' | 'spec' | 'verify';
export const AGENTS: readonly Agent[] = ['plan', 'implement', 'standards', 'spec', 'verify'];
export const modelRole = (agent: Agent): Role => (agent === 'standards' || agent === 'spec' ? 'review' : agent);

/** Who a conversation is: stored with it, so hooks know its role and workspace, also after a restart. */
export const RoleDoc = defineDoc<{ role: Agent | null; issue: number | null; workspace: string | null }>({
  kind: 'phat.role',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ role: null, issue: null, workspace: null }),
});

export type PlanReport = {
  /** proceed: build it. needs_info: the spec has gaps only the author can fill. needs_human: an agent should not do it. */
  decision: 'proceed' | 'needs_info' | 'needs_human';
  summary: string;
  plan: string[];
  /** For needs_info: what is already clear, for the triage notes. */
  established: string[];
  questions: string[];
  /** For needs_human: why. */
  reason: string;
  /** What the planner found out that the implementer needs, so it does not redo the research. */
  notes?: string;
};
export type DoneReport = { summary: string; testing: string };

/** The pull request description, following mattpocock/skills' `pr` skill. Written by the implementer, last. */
export type PrReport = {
  /** Markdown: the smallest view that makes the key point clear (pseudocode, a tree, Mermaid, a diff-sketch…). */
  summary: string;
  /** Before and after, each as Markdown. */
  evidence: { before: string; after: string }[];
  door: 'one-way' | 'two-way';
  doorNote: string;
  /** One word. */
  blastRadius: string;
  blastNote: string;
};

export type Report =
  | { type: 'plan'; data: PlanReport }
  | { type: 'done'; data: DoneReport }
  | { type: 'pr'; data: PrReport }
  | { type: 'standards'; data: StandardsReport }
  | { type: 'spec'; data: SpecReport }
  | { type: 'verification'; data: VerificationReport };

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

export const reportPlan = defineTool({
  name: 'report_plan',
  description: 'Report your plan, or hand the issue back. Call this exactly once, as your final action. Your turn ends when you call it.',
  parameters: Type.Object({
    decision: StringEnum(['proceed', 'needs_info', 'needs_human'], {
      description:
        'proceed: the spec is clear and you have a plan. needs_info: the spec has gaps only its author can fill. ' +
        'needs_human: it needs judgment calls, design decisions, external access or manual testing an agent cannot do.',
    }),
    summary: Type.String({ description: 'One or two sentences: what the change is, in your own words.' }),
    plan: Type.Array(Type.String(), { description: 'Implementation steps, when proceeding. Empty otherwise.' }),
    established: Type.Array(Type.String(), { description: 'For needs_info: what is already clear. Empty otherwise.' }),
    questions: Type.Array(Type.String(), {
      description: 'For needs_info: specific, actionable questions for the author. Empty otherwise.',
    }),
    reason: Type.String({ description: 'For needs_human: why an agent should not do this. Empty otherwise.' }),
    notes: Type.String({
      description:
        'When proceeding: what you found out that the implementer needs (sources, URLs, commands that worked, facts about the data or code, files you left in the scratch folder), so it does not redo your research. Empty if nothing.',
    }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'plan', data: { ...args } as PlanReport });
    }, context);
    return recorded('Plan recorded.');
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

export const reportPr = defineTool({
  name: 'report_pr',
  description: 'Report the pull request description. Call this exactly once, as your final action.',
  parameters: Type.Object({
    summary: Type.String({
      description: 'The Summary section, in Markdown, without its heading: the smallest view that makes the key point clear.',
    }),
    evidence: Type.Array(
      Type.Object({
        before: Type.String({ description: 'Markdown: the behaviour, output or failing test run before the change.' }),
        after: Type.String({ description: 'Markdown: the same after the change.' }),
      }),
      { description: 'Before and after evidence you actually observed. Never invent output.' },
    ),
    door: StringEnum(['one-way', 'two-way'], {
      description: 'two-way: cheap to walk back. one-way: destructive or hard to reverse.',
    }),
    doorNote: Type.String({ description: 'Optional description of the door. Empty if none.' }),
    blastRadius: Type.String({ description: 'One word for the potential impact or scope of the change.' }),
    blastNote: Type.String({ description: 'Optional: potential ramifications of merging. Empty if none.' }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'pr', data: { ...args } as PrReport });
    }, context);
    return recorded('Pull request description recorded.');
  },
});

const axisFields = {
  summary: Type.String({ description: 'Your report on this axis, under 400 words.' }),
  worst: Type.String({ description: 'The worst issue on this axis, in one line. Empty when there are no findings.' }),
};

export const reportStandards = defineTool({
  name: 'report_standards',
  description: 'Report your Standards review. Call this exactly once, as your final action.',
  parameters: Type.Object({
    ...axisFields,
    findings: Type.Array(
      Type.Object({
        kind: StringEnum(['violation', 'smell'], {
          description: 'violation: breaks a documented repo standard. smell: a baseline smell, always a judgement call.',
        }),
        where: Type.String({ description: 'File and hunk or line, e.g. src/curriculum/path.ts:42.' }),
        rule: Type.String({
          description: 'For a violation: the standards file and the rule. For a smell: its name, e.g. "possible Feature Envy".',
        }),
        detail: Type.String({ description: 'What is wrong, quoting the hunk where useful, and how to fix it.' }),
      }),
      { description: 'Empty when the change follows the standards.' },
    ),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'standards', data: { ...args } as StandardsReport });
    }, context);
    return recorded('Standards review recorded.');
  },
});

export const reportSpec = defineTool({
  name: 'report_spec',
  description: 'Report your Spec review. Call this exactly once, as your final action.',
  parameters: Type.Object({
    ...axisFields,
    findings: Type.Array(
      Type.Object({
        kind: StringEnum(['missing', 'unasked', 'wrong', 'bug'], {
          description:
            'missing: asked for, but missing or partial. unasked: not asked for (scope creep). ' +
            'wrong: looks implemented, but the implementation looks wrong. ' +
            'bug: a bug, broken edge case or leftover debugging code, wherever it is.',
        }),
        where: Type.String({ description: 'File and hunk or line, when the finding is about code. Empty otherwise.' }),
        specLine: Type.String({ description: 'The spec line this is about, quoted exactly. Empty only for a bug no spec line covers.' }),
        detail: Type.String({ description: 'What is wrong, and how to fix it.' }),
      }),
      { description: 'Empty when the change does what the spec asks.' },
    ),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'spec', data: { ...args } as SpecReport });
    }, context);
    return recorded('Spec review recorded.');
  },
});

export const reportVerification = defineTool({
  name: 'report_verification',
  description: 'Report your verification. Call this exactly once, as your final action, after cleanup.',
  parameters: Type.Object({
    summary: Type.String({ description: 'What you verified and what you found, in a few sentences.' }),
    beforeNote: Type.String({
      description: 'When there is no before run: why (e.g. "Every feature is new: nothing to show before."). Empty otherwise.',
    }),
    features: Type.Array(
      Type.Object({
        feature: Type.String({ description: 'The feature file name without .md, e.g. learning-path.' }),
        subFeatures: Type.Array(Type.String(), { description: 'Sub-feature IDs this result covers.' }),
        status: StringEnum(['verified', 'failed', 'not_verified'], {
          description:
            'verified: proved on the change. failed: a check failed on the change. ' +
            'not_verified: needs a capability the harness lacks (name it in detail).',
        }),
        preExisting: Type.Boolean({
          description: 'For failed: true only if you re-ran the same check on the base checkout and it fails there too.',
        }),
        detail: Type.String({ description: 'What you saw. For failed: what was expected and what happened.' }),
        checks: Type.Array(Type.String(), {
          description: 'Each check you ran on the change and its result, e.g. "ok: expect.sh label \"HSK 1\"".',
        }),
        before: Type.Array(Type.String(), {
          description: 'Absolute paths of evidence from the base checkout. Empty for a new feature.',
        }),
        after: Type.Array(Type.String(), { description: 'Absolute paths of evidence from the change.' }),
      }),
    ),
    drift: Type.Array(Type.String(), {
      description: 'Where the feature map no longer matches an intended change, for a human to fix. Empty if none.',
    }),
    couldNotRun: Type.String({
      description: 'Why verification could not run at all (e.g. no simulator, a script failed to launch). Empty when it ran.',
    }),
  }),
  execute: async (args, api, context) => {
    await api.commit(async (tx) => {
      (await tx.doc(ReportsDoc, api.conversationId)).items.push({ type: 'verification', data: { ...args } as VerificationReport });
    }, context);
    return recorded('Verification recorded.');
  },
});

export const tools = {
  read: createReadTool(),
  bash: createBashTool(),
  write: createWriteTool(),
  edit: createEditTool(),
};

/** The tools each role may use. Only the implementer can change files. */
export const ROLE_TOOLS: Record<Agent, ToolRegistration[]> = {
  plan: [tools.read, tools.bash, reportPlan],
  implement: [tools.read, tools.bash, tools.write, tools.edit, reportDone, reportPr],
  standards: [tools.read, tools.bash, reportStandards],
  spec: [tools.read, tools.bash, reportSpec],
  verify: [tools.read, tools.bash, reportVerification],
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
  tools: [tools.read, tools.bash, tools.write, tools.edit, reportPlan, reportDone, reportPr, reportStandards, reportSpec, reportVerification],
});

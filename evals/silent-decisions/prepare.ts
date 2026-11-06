/**
 * Step 2 of the silent-decisions eval kit: a folder per sampled ticket, for the reviewer (review/, worktree/) and the
 * judge (judge/, meta.json). See README.md. Not part of phat-mode's runtime.
 *
 *   node evals/silent-decisions/prepare.ts --collect tickets.json --clone ../repo --out runs/2026-12-01 --every 5
 */
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../../src/exec.ts';
import {
  editedAfter,
  recordedDepartures,
  recordedSilentDecisions,
  sample,
  type SampleBy,
  type TicketRecord,
} from './core.ts';

/**
 * What prepare reads from GitHub: issues (the ticket and its parent), each with when its body was last edited (null
 * when never), and pull request descriptions.
 */
export type GitHubReader = {
  issue(number: number): Promise<{ title: string; body: string; lastEditedAt: string | null }>;
  pullRequestBody(number: number): Promise<string>;
};

export type PrepareOptions = { clone: string; out: string; github: GitHubReader };

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** What the reviewer (step 3) and the judge (step 4) write into a ticket folder. */
const AGENT_OUTPUTS = ['gaps.md', 'judgement.json', 'judgement.md'];

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The ticket as the planner's spec had it: the body, then the Agent Brief when that was the spec. */
function ticketMarkdown(record: TicketRecord, issue: { title: string; body: string }): string {
  const parts = [`# ${issue.title} (#${record.number})`, issue.body.trim()];
  if (record.spec.source === 'brief' && record.spec.brief !== undefined) {
    parts.push(
      '## Spec (Agent Brief)',
      'The Agent Brief below, from a comment on the issue, is the spec; the issue body above is background.',
      record.spec.brief.trim(),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * The folder for one ticket, `<out>/<owner>__<name>-<n>/`:
 * - `review/`: `ticket.md` and `parent.md` (when it has a parent), all the reviewer may read besides `worktree/`;
 * - `worktree/`: a detached checkout of the planning base commit, made from `clone`;
 * - `judge/`: the plan comment, the PR description, the window, the merge commit, and the recorded silent decisions and
 *   departures (only when the run recorded them);
 * - `meta.json`: the times, commits and flags.
 * Returns a warning per flag: a body edited after planning (as GitHub says now, for the body the reviewer gets), a plan
 * comment updated after it was posted. Preparing a folder again replaces its inputs; a worktree left at another
 * commit is made again. A folder the reviewer or judge already wrote into is refused, so no evaluation is ever scored
 * against inputs it was not made from.
 */
export async function prepareTicket(record: TicketRecord, options: PrepareOptions): Promise<{ dir: string; warnings: string[] }> {
  const { github } = options;
  const name = `${record.repo.replace('/', '__')}-${record.number}`;
  // Absolute: git resolves a relative worktree path inside the clone, not here.
  const dir = resolve(options.out, name);
  const ticket = `${record.repo}#${record.number}`;
  if (record.baseCommit === null) throw new Error(`${ticket}: no base commit at planning time`);
  // The reviewer's and judge's outputs belong to the inputs they were made from: never mix them with new inputs.
  const evaluated = [];
  for (const output of AGENT_OUTPUTS) if (await exists(join(dir, output))) evaluated.push(output);
  if (evaluated.length > 0) {
    throw new Error(
      `${ticket}: ${dir} is already evaluated (${evaluated.join(', ')}). Prepare into another --out folder, or delete this one first.`,
    );
  }
  // Start the inputs afresh, so none left by an earlier prepare (a parent, a PR, recorded decisions) survives.
  for (const input of ['review', 'judge', 'meta.json']) await rm(join(dir, input), { recursive: true, force: true });
  await mkdir(join(dir, 'review'), { recursive: true });
  await mkdir(join(dir, 'judge'), { recursive: true });

  const issue = await github.issue(record.number);
  await writeFile(join(dir, 'review', 'ticket.md'), ticketMarkdown(record, issue));
  if (record.parent !== null) {
    const parent = await github.issue(record.parent);
    await writeFile(join(dir, 'review', 'parent.md'), `# ${parent.title} (#${record.parent})\n\n${parent.body.trim()}\n`);
  }

  await writeFile(join(dir, 'judge', 'plan.md'), `${record.plan.body.trim()}\n`);
  const prBody = record.pr === null ? undefined : await github.pullRequestBody(record.pr.number);
  if (prBody !== undefined) await writeFile(join(dir, 'judge', 'pr.md'), `${prBody.trim()}\n`);
  await writeFile(
    join(dir, 'judge', 'window.json'),
    json({ writtenAt: record.spec.writtenAt, plannedAt: record.plannedAt, baseCommit: record.baseCommit, ...record.window }),
  );
  const mergeCommit = record.pr?.mergeCommit ?? null;
  if (mergeCommit !== null) await writeFile(join(dir, 'judge', 'merge-commit.txt'), `${mergeCommit}\n`);
  const decisions = recordedSilentDecisions(record.plan.body);
  if (decisions !== undefined) await writeFile(join(dir, 'judge', 'silent-decisions.json'), json(decisions));
  const departures = prBody === undefined ? undefined : recordedDepartures(prBody);
  if (departures !== undefined) await writeFile(join(dir, 'judge', 'departures.json'), json(departures));

  // The body written above is the one fetched now, so its edit time is too: collect's may be older.
  const bodyEditedAt = issue.lastEditedAt;
  const bodyEditedAfterPlanning = editedAfter(bodyEditedAt, record.plannedAt);
  const planReplanned = record.plan.updatedAt !== record.plan.createdAt;
  await writeFile(
    join(dir, 'meta.json'),
    json({
      repo: record.repo,
      number: record.number,
      url: record.url,
      specSource: record.spec.source,
      writtenAt: record.spec.writtenAt,
      plannedAt: record.plannedAt,
      planUpdatedAt: record.plan.updatedAt,
      baseCommit: record.baseCommit,
      pr: record.pr,
      mergeCommit,
      bodyEditedAt,
      bodyEditedAfterPlanning,
      planReplanned,
      silentDecisionsRecorded: decisions !== undefined,
      departuresRecorded: departures !== undefined,
    }),
  );

  await checkOut(options.clone, join(dir, 'worktree'), record.baseCommit);

  const warnings: string[] = [];
  if (bodyEditedAfterPlanning) {
    warnings.push(`${ticket}: the body was edited after planning (${bodyEditedAt}); the reviewer sees the edited body`);
  }
  if (planReplanned) {
    warnings.push(`${ticket}: the plan comment was updated after it was posted (${record.plan.updatedAt}): it may be from a retry`);
  }
  if (mergeCommit === null) warnings.push(`${ticket}: no merged pull request; the judge has no merged code`);
  return { dir, warnings };
}

/**
 * A detached worktree of `clone` at `commit`. One already there is kept only when it is detached at `commit` (an
 * earlier prepare of the same ticket); otherwise it is removed and made again.
 */
async function checkOut(clone: string, worktree: string, commit: string): Promise<void> {
  if (await exists(join(worktree, '.git'))) {
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: worktree, allowFailure: true })).stdout.trim();
    const branch = await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: worktree, allowFailure: true });
    if (head === commit && branch.code !== 0) return;
    await run('git', ['-C', clone, 'worktree', 'remove', '--force', worktree], { allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
  }
  await run('git', ['-C', clone, 'worktree', 'prune']);
  await run('git', ['-C', clone, 'worktree', 'add', '--detach', worktree, commit]);
}

/** GitHub through the `gh` CLI. */
function ghReader(repo: string): GitHubReader {
  const gh = async (args: string[]) => (await run('gh', args)).stdout;
  return {
    issue: async (number) => {
      // `gh issue view --json` has no lastEditedAt; GraphQL has.
      const [owner = '', name = ''] = repo.split('/');
      const result = JSON.parse(
        await gh([
          'api', 'graphql',
          '-f', 'query=query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){title body lastEditedAt}}}',
          '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `i=${number}`,
        ]),
      ) as { data: { repository: { issue: { title: string; body: string; lastEditedAt: string | null } } } };
      return result.data.repository.issue;
    },
    pullRequestBody: async (number) =>
      (JSON.parse(await gh(['pr', 'view', String(number), '-R', repo, '--json', 'body'])) as { body: string }).body,
  };
}

function sampleBy(values: { issues?: string; from?: string; to?: string; every?: string }): SampleBy {
  if (values.issues !== undefined) return { issues: values.issues.split(',').map(Number) };
  if (values.every !== undefined) return { every: Number(values.every) };
  if (values.from !== undefined && values.to !== undefined) return { from: values.from, to: values.to };
  throw new Error('Choose a sample: --issues 12,15, --from <iso> --to <iso>, or --every 5');
}

async function main() {
  const { values } = parseArgs({
    options: {
      collect: { type: 'string' },
      clone: { type: 'string' },
      out: { type: 'string' },
      issues: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      every: { type: 'string' },
    },
  });
  if (!values.collect || !values.clone || !values.out) {
    throw new Error('Usage: prepare.ts --collect <tickets.json> --clone <path> --out <dir> (--issues 12,15 | --from <iso> --to <iso> | --every 5)');
  }
  const records = JSON.parse(await readFile(values.collect, 'utf8')) as TicketRecord[];
  const picked = sample(records, sampleBy(values));
  for (const record of picked) {
    const { dir, warnings } = await prepareTicket(record, { clone: values.clone, out: values.out, github: ghReader(record.repo) });
    console.log(dir);
    for (const warning of warnings) console.error(`⚠️  ${warning}`);
  }
  console.error(`Prepared ${picked.length} ticket(s) in ${values.out}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

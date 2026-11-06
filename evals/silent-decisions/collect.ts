/**
 * Step 1 of the silent-decisions eval kit: every ticket phat-mode built (labelled `phat-mode:done`) in a repo, as JSON
 * on stdout, with a summary on stderr. Deterministic: `gh` and git only. See README.md. Not part of phat-mode's runtime.
 *
 *   node evals/silent-decisions/collect.ts --repo owner/name --clone ../name > tickets.json
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { branchFor, loadMachineConfig, parseRepoSettings } from '../../src/config.ts';
import { run } from '../../src/exec.ts';
import { GhGitHub, PROGRESS_LABELS } from '../../src/github.ts';
import { findSpec, parentRef } from '../../src/spec.ts';
import {
  FIRST_PARENT_LOG_ARGS,
  listDoneIssues,
  parseFirstParentLog,
  pickPlanComment,
  type RestComment,
  type RestIssueItem,
  type TicketRecord,
  windowOf,
} from './core.ts';

const gh = async (args: string[]) => (await run('gh', args)).stdout;
const git = async (clone: string, args: string[]) => (await run('git', ['-C', clone, ...args], { allowFailure: true })).stdout;

/** Trusted authors, as phat-mode decides them: the repo's .phat-mode.json, else your config.json, else the gh user. */
async function trustedAuthors(clone: string, base: string, viewer: string): Promise<string[]> {
  const settings = await git(clone, ['show', `origin/${base}:.phat-mode.json`]);
  if (settings.trim() !== '') {
    const authors = parseRepoSettings(settings).allowedAuthors;
    if (authors !== undefined) return authors;
  }
  return (await loadMachineConfig()).allowedAuthors ?? [viewer];
}

/** The base branch: the repo's .phat-mode.json in the clone, else GitHub's default branch. */
async function baseBranch(repo: string, clone: string): Promise<string> {
  const settings = await readFile(join(clone, '.phat-mode.json'), 'utf8').catch(() => '');
  if (settings.trim() !== '') {
    const branch = parseRepoSettings(settings).baseBranch;
    if (branch !== undefined) return branch;
  }
  return (await gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim();
}

const adrTitle = async (clone: string, sha: string, path: string) =>
  /^# +(.+?)\s*$/m.exec(await git(clone, ['show', `${sha}:${path}`]))?.[1];

async function collectTicket(
  repo: string,
  number: number,
  options: { clone: string; bot: string; authors: string[]; log: ReturnType<typeof parseFirstParentLog> },
): Promise<TicketRecord | string> {
  const github = new GhGitHub(repo);
  const comments = (JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`])) as RestComment[][]).flat();
  const plan = pickPlanComment(comments, options.bot);
  if (plan === undefined) return `#${number}: no plan comment by ${options.bot}`;
  const plannedAt = plan.createdAt;

  const issue = await github.getIssue(number);
  // The spec the planner saw: comments added after planning started (a later amendment) do not count.
  const seen = { ...issue, comments: issue.comments.filter((comment) => Date.parse(comment.createdAt) <= Date.parse(plannedAt)) };
  const spec = findSpec(seen, options.authors, repo);
  if (spec === undefined || spec.writtenAt === undefined) return `#${number}: no spec by ${options.authors.join(', ')}`;

  const parent = (await github.parentIssue(number)) ?? parentRef(issue.body, repo) ?? null;
  const prs = JSON.parse(
    await gh([
      'pr', 'list', '-R', repo, '--head', branchFor(number), '--state', 'all', '--limit', '100',
      '--json', 'number,state,mergeCommit,url,isCrossRepository',
    ]),
  ) as { number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergeCommit: { oid: string } | null; url: string; isCrossRepository: boolean }[];
  const pr = prs.filter((candidate) => !candidate.isCrossRepository).sort((a, b) => b.number - a.number)[0];

  const [owner, name] = repo.split('/');
  const edited = JSON.parse(
    await gh([
      'api', 'graphql',
      '-f', 'query=query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt}}}',
      '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `i=${number}`,
    ]),
  ) as { data: { repository: { issue: { lastEditedAt: string | null } } } };

  const window = windowOf(options.log, spec.writtenAt, plannedAt);
  const docChanges = [];
  for (const change of window.docChanges) {
    const title = change.doc === 'adr' ? await adrTitle(options.clone, change.sha, change.path) : undefined;
    docChanges.push({ ...change, ...(title === undefined ? {} : { title }) });
  }

  return {
    repo,
    number,
    title: issue.title,
    url: issue.url,
    spec: {
      source: spec.source,
      author: spec.author,
      writtenAt: spec.writtenAt,
      ...(spec.source === 'brief' ? { brief: spec.text } : {}),
    },
    plannedAt,
    plan,
    bodyEditedAt: edited.data.repository.issue.lastEditedAt,
    parent: parent === number ? null : parent,
    pr: pr === undefined ? null : { number: pr.number, state: pr.state, mergeCommit: pr.mergeCommit?.oid ?? null, url: pr.url },
    baseCommit: window.baseCommit ?? null,
    window: { commits: window.commits, docChanges },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      clone: { type: 'string' },
      base: { type: 'string' },
      bot: { type: 'string' },
      authors: { type: 'string' },
    },
  });
  if (!values.repo || !values.clone) {
    throw new Error('Usage: collect.ts --repo owner/name --clone <path> [--base <branch>] [--bot <login>] [--authors a,b]');
  }
  const { repo, clone } = values;
  const base = values.base ?? (await baseBranch(repo, clone));
  await run('git', ['-C', clone, 'fetch', 'origin', base]);
  const viewer = (await gh(['api', 'user', '--jq', '.login'])).trim();
  const bot = values.bot ?? viewer;
  const authors = values.authors?.split(',') ?? (await trustedAuthors(clone, base, viewer));
  const log = parseFirstParentLog((await run('git', ['-C', clone, ...FIRST_PARENT_LOG_ARGS, `origin/${base}`])).stdout);

  const perPage = 100;
  const label = encodeURIComponent(PROGRESS_LABELS.done.name);
  const done = await listDoneIssues(
    async (page) =>
      JSON.parse(await gh(['api', `repos/${repo}/issues?labels=${label}&state=all&per_page=${perPage}&page=${page}`])) as RestIssueItem[],
    perPage,
  );
  const records: TicketRecord[] = [];
  for (const number of done) {
    const record = await collectTicket(repo, number, { clone, bot, authors, log });
    if (typeof record === 'string') console.error(`Skipped ${record}`);
    else records.push(record);
  }
  console.log(JSON.stringify(records, null, 2));

  const adrChanged = records.filter((record) => record.window.docChanges.some((change) => change.doc === 'adr'));
  const adrAdded = records.filter((record) => record.window.docChanges.some((change) => change.doc === 'adr' && change.kind === 'added'));
  console.error(
    `${repo}: ${records.length} ticket(s); ${adrChanged.length} with an ADR added or changed between writing and planning; ${adrAdded.length} with a new ADR.`,
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

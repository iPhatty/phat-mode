# Silent decisions eval kit

Measures, on a sample of tickets phat-mode built, how well **silent decisions** and **departures** (#27,
[ADR 0005](../../docs/adr/0005-silent-decisions-agreed-with-the-implementer-and-checked-by-the-spec-reviewer.md)) catch
the gaps in tickets, so we know when the cheap approach stops being enough.

A fresh **Goldfish** reviewer sees only a ticket, its parent and the code the planner saw, and lists the gaps it finds.
A **judge** then scores each Blocker/Major gap against what was actually planned, described and merged.

This kit is **not part of phat-mode**: nothing in `src/` imports it, `watch` never runs it, and no schedule or CI runs
it. Only its unit tests (`evals/**/*.test.ts`) run with `npm test`, without network.

```
1 collect  (gh + git)  → tickets.json
2 prepare  (gh + git)  → runs/<date>/<owner>__<name>-<n>/{review/, worktree/, judge/, meta.json}
3 review   (agent)     → gaps.md                    one fresh read-only subagent per ticket
4 judge    (agent)     → judgement.json, judgement.md   one fresh subagent per ticket, after 3
5 score    (node)      → results/<date>.md
```

| File | What |
|---|---|
| `collect.ts`, `prepare.ts`, `score.ts` | the deterministic steps |
| `core.ts`, `judgement.ts` | their pure parts (unit tested in `test/`); `judgement.ts` holds the judgement schema |
| `reviewer.md`, `judge.md` | the agent instructions for steps 3 and 4 |
| `egm/` | the Elephant-Goldfish Model's implementation-readiness reviewer and standard, pinned (see `egm/README.md`) |
| `results/` | one Markdown report per evaluation, starting with the [2026-11-06 baseline](results/2026-11-06-baseline.md) |

## Prerequisites

- `gh`, logged in as a user who can read the repo. Collect assumes the plan comments were posted by this user, as
  phat-mode posts as the `gh` user; pass `--bot <login>` otherwise.
- A local clone of the repo, with `origin` pointing at GitHub. Prepare adds worktrees to it.
- Node 24, run from the root of this repository.

Keep the ticket folders outside this repository (for example in a scratch folder): they hold worktrees and are never
committed. Only the report in `results/` is.

## 1. Collect

```bash
node evals/silent-decisions/collect.ts --repo owner/name --clone ../name > tickets.json
```

For every issue labelled `phat-mode:done`, it records:

- when its spec was written, by #27's rule (`findSpec` in `src/spec.ts`, reused): the Agent Brief's creation time, else
  the body's `shaped-at` time, else the issue's creation time. Only comments made before planning count, so a brief
  added later is not the spec the planner saw;
- when planning started: the creation time of the plan comment (phat-mode's own `<!-- phat-mode:plan -->` comment with
  a proceed plan; its last update is recorded too);
- its parent, its pull request (number, state, merge commit) and when its body was last edited;
- the base branch's commit when planning started, and the first-parent commits between written and planned, with the
  ADRs and glossaries (`GLOSSARY.md`, `CONTEXT.md`) they added or changed, classified as phat-mode's planner does.

On stderr it prints the tickets it skipped (no plan comment, no trusted spec) and a summary: tickets, tickets with an
ADR change in the window, tickets with a new ADR.

Options: `--base <branch>` (default: the repo's `.phat-mode.json`, else GitHub's default branch), `--bot <login>`
(default: the `gh` user), `--authors a,b` (trusted authors; default: the repo's `.phat-mode.json`, else your
`config.json`, else the `gh` user).

## 2. Prepare

Pick a sample, one of:

- **all tickets in a window**: `--from 2026-11-01T00:00:00Z --to 2026-12-01T00:00:00Z` (planned in `[from, to)`);
- **about 1 in 5 merged tickets**: `--every 5` (every fifth merged ticket by issue number);
- **chosen tickets**: `--issues 12,15`.

```bash
node evals/silent-decisions/prepare.ts --collect tickets.json --clone ../name --out ~/scratch/runs/2026-12-01 --every 5
```

Each ticket gets a folder `<out>/<owner>__<name>-<n>/`:

| Path | For | What |
|---|---|---|
| `review/ticket.md` | reviewer | the ticket body, and the Agent Brief when that was the spec |
| `review/parent.md` | reviewer | the parent's body, if it has one |
| `worktree/` | both | a detached worktree at the planning base commit |
| `judge/plan.md`, `judge/pr.md` | judge | the plan comment and the PR description |
| `judge/window.json`, `judge/merge-commit.txt` | judge | the commits in the window, with ADR and glossary changes; the merge commit |
| `judge/silent-decisions.json`, `judge/departures.json` | judge | the plan's silent decisions and the implementer's departures, only when the run recorded them |
| `meta.json` | judge | times, commits and flags |

It prints a warning for each ticket whose body was **edited after planning** (the reviewer sees a different ticket from
the planner's), whose plan comment was **updated after it was posted** (a retry), or that has no merged PR. Decide
whether to keep it in the sample; the judge sees the flags in `meta.json`. The edit flag uses the body's edit time read
together with the body prepare writes, not the one collect saw, so an edit made between the two steps is flagged too.

Preparing a ticket again (for example after collecting again) replaces its inputs (`review/`, `judge/`, `meta.json`),
so nothing from the earlier record survives. Its worktree is kept only when it is still detached at the planning base
commit, and is made again otherwise. A folder the reviewer or judge already wrote into (`gaps.md`, `judgement.json`,
`judgement.md`) is refused, so an evaluation is never scored against inputs it was not made from: prepare into a new
`--out` folder, or delete that ticket's folder first.

## 3. Review and 4. Judge

Both need a **fresh subagent context per ticket**: a reviewer that has seen another ticket, the plan or this README is
no longer a Goldfish. Use any harness that can start fresh subagents in parallel, one per ticket folder (for example
pi-subagents), started from the root of this repository:

- Review, for every ticket folder, in parallel:
  `Follow evals/silent-decisions/reviewer.md for <folder>`.
  The reviewer must stay read-only and see nothing but `review/` and `worktree/`; where the harness can, give it read
  tools only, no network, and a write tool limited to `<folder>/gaps.md`.
- Judge, once every `gaps.md` exists, for every ticket folder, in parallel:
  `Follow evals/silent-decisions/judge.md for <folder>`.
  It writes only `judgement.json` and `judgement.md` in the folder.

## 5. Score

```bash
node evals/silent-decisions/score.ts ~/scratch/runs/2026-12-01 --out evals/silent-decisions/results/2026-12-01.md
```

It reads every `<dir>/*/judgement.json` (failing, with the file and field, on one that breaks the schema) and writes:

- the baseline table: tickets, Blocker/Major gaps, real, handled / guessed / missed / moot, where the decisions are
  visible (plan, PR only, code only), relevant ADRs in the windows and whether they were followed;
- **recall**: the share of real Blocker/Major gaps listed in the plan's silent decisions, over the runs that recorded
  them;
- **unreported departures**: silent decisions the merged code does not follow, not reported as departures;
- what the **Spec reviewer passed**: unjustified departures, unsound silent decisions and unreported departures it
  raised nothing about;
- the **guessed and missed** gaps.

Add a line or two of context to the report (the sample, any flagged tickets) and commit it as `results/<date>.md`.
Then remove the worktrees: `git -C ../name worktree remove --force <folder>/worktree` for each, or delete the folders
and run `git -C ../name worktree prune`.

## When to revisit ADR 0005

Look at roughly the last 20 evaluated tickets, across the results files. Revisit
[ADR 0005](../../docs/adr/0005-silent-decisions-agreed-with-the-implementer-and-checked-by-the-spec-reviewer.md) (for
example, add the pre-planning Goldfish reviewer it rejected) when either:

- any **merged** PR rests on a bad silent decision, or on an unreported or unjustified departure, that the Spec reviewer
  passed; or
- **recall** falls below about **70%** for Blocker/Major gaps.

Score does not decide this; read it off the reports.

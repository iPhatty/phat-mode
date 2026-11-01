# phat-mode

Turns GitHub issues into **pull requests**, unattended, one after another. Built on [Pi Durable](https://earendil.com/posts/pi-durable/), so a run survives crashes, Ctrl-C and a sleeping laptop, and continues where it stopped.

> **Stage 1 MVP.** It runs on your Mac and works on one issue when you run it. Everything here may change.

## What it does

phat-mode is the **AFK agent** in a [mattpocock/skills](https://github.com/mattpocock/skills) workflow. You and the skills decide *what* to build; phat-mode builds it.

```
/triage, /to-tickets or /to-spec  →  issue labelled ready-for-agent  →  phat-mode watch  →  PR  →  you merge  →  next issue
```

1. **Prepare**: only works on issues that are open, labelled `ready-for-agent`, specified by a trusted author, and not blocked by open issues. Anything else is left alone, with no reply. Labels it `phat-mode:working` and checks out branch `phat-mode/issue-12` in its own workspace.
2. **Plan** (AI, Claude Opus 5.5): reads the spec and the code, and plans *how* to build it. If the spec has a gap, it posts triage notes and moves the issue back to `needs-info`. If an agent shouldn't do it, it moves it to `ready-for-human`.
3. **Implement** (AI, Claude Opus 5.5): changes the code and adds tests.
4. **Verify** (code, not AI): runs `npm run check`. On failure, the output goes back to the implementer (up to 3 times).
5. **Code review** (GPT-6.1 Sol, a different model family, read-only): two reviewers in parallel, following Matt Pocock's [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) skill. See [Code review](#code-review).
6. **Verify** (AI, read-only, in the real app): follows the repo's own verification skill. See [Verification](#verification).
7. **Describe** (AI, the implementer): writes the PR description following Matt Pocock's [pr](https://github.com/mattpocock/skills/blob/main/skills/engineering/pr/SKILL.md) skill: **Summary** (the smallest diagram that makes the point), **Evidence** (before and after) and **Merge Danger** (one- or two-way door, blast radius). It must not change files; if it does, the change is checked and reviewed again.
8. **Publish** (code): commits, pushes, and opens a PR, ready for review, labelled `ready-for-human`. (A draft left by an earlier version is updated and made ready for review.) The description is the pr skill's three sections, then what phat-mode adds: its own verified check result under Evidence, the acceptance criteria to tick off, the code review, and `Closes #N`.

It never pushes to `main`, and it never merges unless you run it with [`--yolo`](#yolo). Otherwise you review and merge every PR.

### The spec

phat-mode builds from, in order:

1. the newest **Agent Brief** comment by a trusted author (`allowedAuthors`), from `/triage`, either the `## Agent Brief` template or a short inline `Agent brief: …`. The issue body is then background.
2. otherwise the **issue body**, if a trusted author opened the issue, as `/to-tickets` and `/to-spec` write them.

Acceptance criteria, out-of-scope lists and `Blocked by` references are read from either. The **parent issue** (GitHub's native parent, else `## Parent #N` in the body), when a trusted author wrote it, is given to every agent as background: the larger plan, followed where the spec is silent, never against it. Blockers are also read from GitHub's native issue dependencies.

### Labels

| Label | Set by | Meaning |
|---|---|---|
| `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | the triage skills, and phat-mode when it hands back | the issue's triage state (names configurable under `labels`) |
| `phat-mode:working` / `phat-mode:done` / `phat-mode:failed` | phat-mode | its own progress; one at a time |
| `agent-mode` | you | shape this vague issue into tickets ([agent mode](#agent-mode-shaping), being built); never built itself (name configurable under `labels`) |
| `phat-mode:shaped` | phat-mode | agent mode shaped this issue into tickets; stays on while they are built |

`phat-mode init` creates any of these the repo is missing, with a colour and description, under the names in `labels`; it never changes a label that is already there. Creating labels needs write access: if it cannot, `init` names the labels and GitHub's reason, and exits 1. Run it again after renaming labels.

| Outcome | Issue labels afterwards |
|---|---|
| PR opened | `ready-for-agent` + `phat-mode:done` (the PR gets `ready-for-human`; the issue closes when the PR merges) |
| Spec has gaps | `needs-info`, with triage notes in the skills' format |
| Not for an agent | `ready-for-human`, with the reason |
| Gave up (e.g. checks keep failing) | `ready-for-human` + `phat-mode:failed`, with the reason |

To retry, label the issue `ready-for-agent` again and run it.

## Agent mode: shaping

> **Being built.** Today shaping runs triage's checks and stops there; grilling, the spec and the tickets come next.

Label a vague issue you opened `agent-mode` and run `phat-mode run <issue>`: phat-mode **shapes** it, with no human answering questions. Shaping is its own durable task, next to building: it survives crashes and Ctrl-C like a build, and `status`, `resume` and `abort` cover it (`status` says `shaping: running (triage)` or `building: running (implement)`).

1. **Prepare** (code): shapes only issues that are open, labelled `agent-mode`, and opened by a trusted author (`allowedAuthors`); anything else is ignored without touching GitHub. An issue that is already `phat-mode:shaped`, or also carries a triage state label (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), is refused with a comment, and its labels are left for you to sort out. Then it checks out the base branch, detached and read-only, in `workspaces/<owner>__<name>/shape-<n>`, and runs `installCommand` once.
2. **Triage** (AI, the answerer, `shape` model): follows **phat-mode's pinned copy** of mattpocock/skills' [`triage`](skills/triage/) skill, verbatim (a copy in the repo is never used), plus phat-mode's autonomy overlay: *"the user is the answering agent. Wherever the skill asks the user to check, choose, approve or answer, ask the answering agent. Never wait for a human."* It runs triage's checks: is it already implemented (and where it looked), was something like it rejected before (`.out-of-scope/`), and for a bug, does it reproduce. It reads files and runs commands, but cannot change the checkout (no write or edit tools, and its files are read-only on disk); git, `gh` and credential folders are blocked, as for every agent.

The agents get the issue body and the comments of `allowedAuthors` only; anyone else's comments never reach them.

| Outcome | Labels afterwards | Comment |
|---|---|---|
| Unintelligible or contradicts itself | `needs-info` | triage notes in the skills' format |
| Needs a human (design taste, outside access, manual testing) | `ready-for-human` | the reason |
| Already implemented, or rejected before | `ready-for-human` | the findings; never `wontfix`, only you close an idea for good |
| Failure | `ready-for-human` + `phat-mode:failed` | the reason |
| Nothing in the way | unchanged (`agent-mode` stays) | none yet: the run ends here until grilling is built |

Every way out removes `agent-mode`. Everything shaping writes starts with `> *Shaped by phat-mode (AI) from #N.*`.

## Watch

`phat-mode watch` keeps going on its own: after you merge a PR, it starts the next issue. It works on the repos named on the command line (`phat-mode watch owner/a owner/b`), else the `repos` in your config.json (`phat-mode init` adds each repo it sets up), else the repo of the current folder. Run inside a set-up repo (one with `.phat-mode.json`) while other repos are listed, it asks whether to watch that repo alone (the default) or all of them; when it cannot ask (not a terminal), it watches all. It runs in the foreground until Ctrl-C and looks at GitHub every `watchIntervalMs` (default 2 minutes).

One run at a time across all repos, in the order they are listed. The rules below apply per repo: a PR waiting for you in one repo does not hold up the others. Each time, for each repo, it:

1. finishes any run that is still going;
2. waits while a PR from a `phat-mode/issue-*` branch is open: that one is waiting for you to merge (with [`--yolo`](#yolo), it merges the ones it can first, lowest issue first, and says why it does not merge the others);
3. hands an issue to a human if its PR was closed without merging (`ready-for-human`, with a comment; label it `ready-for-agent` again to retry);
4. starts the **lowest-numbered issue that is ready and not blocked**: open, `ready-for-agent`, specified by a trusted author, no open blockers, and not `phat-mode:working` or `phat-mode:done`. `phat-mode:failed` with `ready-for-agent` again means: try again.

Merging a PR closes its issue (`Closes #N`), which unblocks the issues that wait for it, so blockers set up as GitHub issue dependencies or `Blocked by` lines give the order. When nothing can start, it says why, once: e.g. `#9 is blocked by #18 (ready-for-human)`.

It polls rather than using GitHub webhooks: a webhook needs a public address for your Mac, and anything sent while the Mac sleeps would be lost. Polling works out everything from GitHub on each look, so it catches up after sleep, Ctrl-C or a crash. While `watch` runs, it holds the lock: `status`, `run` and `abort` say phat-mode is already running.

### Yolo

`phat-mode watch --yolo` and `phat-mode run --yolo <issue>` also merge phat-mode's pull requests, so a queue of issues can go all the way to `main` without you. It prints a warning when it starts; the flag is never saved. It squash-merges a PR (and deletes its branch) only when:

1. **phat-mode found it clean**: both reviewers reported and no must-fix findings are open, and verification either was skipped (no verify skill in the repo) or ran, reported, and left no failure this change caused. Every PR description carries phat-mode's verdict in a hidden marker, with the commit it pushed; no marker, no merge.
2. **nobody pushed since**: the head is still the commit phat-mode judged (and the merge is pinned to it);
3. **it has settled**: that commit is at least 5 minutes old, so checks still being queued show up;
4. **every check passed**: every check run and commit status on it, required or not (skipped and neutral count). A PR with no checks merges: phat-mode's own checks, review and verification passed it.

Checks running or settling: it waits. Anything else is yours, with one line saying why: `not merging: checks failed: ci/test`, `code review has open findings`, `commits added after phat-mode`, `GitHub refused: …`. It never bypasses branch protection (no `--admin`) and only squash-merges. Each merge gets a comment on the PR.

`run --yolo` opens the PR as `run` does, then looks every `watchIntervalMs` until it merges (exit 0) or something needs you (exit 1, with the reason). Ctrl-C is safe: `run --yolo <issue>` again goes straight back to waiting when the PR is open and no run is going. Why it works this way: [ADR 0002](docs/adr/0002-yolo-merges.md).

## Code review

phat-mode's reviewers follow mattpocock/skills' `code-review` skill. The pipeline does the skill's coordinator steps (fixed point: the base branch; spec: the one phat-mode built from; standards sources: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `.github/copilot-instructions.md`, `docs/**/*.md`), and two reviewer agents, in parallel and in separate conversations, review one axis each:

- **Standards**: the repo's documented standards (hard violations, citing the rule) plus the skill's baseline of 12 Fowler code smells (always judgement calls).
- **Spec**: requirements missing or partial, scope creep, and what looks wrong, each quoting the spec line. Plus one addition from phat-mode, which runs unattended: bugs, broken edge cases and leftover debugging code anywhere in the diff.

Each reviewer gets the skill's brief verbatim, from **phat-mode's own pinned copy** in [`skills/code-review/`](skills/code-review/) (upstream commit `49dd158`, MIT, © Matt Pocock). It is the same for every repo, and a copy installed in the repo under review is never used:

- The **review process** belongs to phat-mode: identical on every repo, and exactly what the tests cover. The code under review cannot change how it is reviewed.
- **What good code means** belongs to each repo: its `AGENTS.md`, `CONTRIBUTING.md` and similar, which the Standards reviewer reads. A documented repo rule overrides a baseline smell, as the skill says.

Matt's skills are pinned together in `skills/`: the ones phat-mode follows (`code-review`, `pr`, and `triage` when shaping) and the ones `init` installs into each repo (see [Setup](#setup)). To upgrade: copy the new upstream files in, update `MATTPOCOCK_SKILLS` in `src/skills.ts` and the commit in each `skills/*/README.md`, and run `npm test` (it fails if a skill's layout changed).

### Evidence

Each piece of evidence in the PR records who supplied it: the verifier's, from the real app; the implementer's before/after (what it says it observed); and phat-mode's own check run.

## Verification

How to prove an app works differs per project, so the **project** owns it: run pstack's [`/create-verification-skill`](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md) in the repo once, commit the `verify-<app>` skill it generates (launch, doctor, drive, evidence, cleanup, plus a feature map), and keep it current with [`/maintain-verification-skill`](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md). phat-mode finds and follows it. `phat-mode init` installs both, pinned in [`skills/`](skills/) (upstream commit `ae5650f`, MIT, © Lauren Tan); `create-verification-skill` only while the repo has no verify skill.

1. **Find** (code): a `verify-*/SKILL.md` under `.agents/skills`, `.claude/skills` or `.cursor/skills`, read from the commit the work is based on (a symlinked copy counts once). None: verification is skipped and the PR says how to add one.
2. **Protect** (code): the implementer cannot change the skill's `SKILL.md` or scripts (blocked, and reverted before verifying if changed anyway). It may update `features/` when it changes behaviour on purpose, as the skill expects; the PR flags such edits.
3. **Verify** (AI, the verifier, `defaultModel`, reads screenshots): picks the features the change touches, then
   - **before**, only if there genuinely is one: drives the same user path on a clean checkout of the base branch. A new feature has no before, and the PR says so;
   - **after**: drives and checks each feature as the feature map says, in the change's checkout;
   - a failure is re-run on the base branch: if it fails there too, this change did not cause it.
   It always runs the skill's cleanup. Whatever it changes in the change's files is discarded (snapshot and restore).
4. **Decide** (code): a failure this change caused goes back to the implementer, then checks, review and verification run again (`maxVerifyRounds`: 2). Not verified (missing capability), drift and pre-existing failures never block; they are shown.
5. **Publish** (code): evidence files (screenshots, accessibility trees, logs) inside the two checkouts are copied, pushed to the **`phat-mode/evidence`** branch (never the PR branch), and shown in the PR's Evidence section as before/after images, pinned to the evidence commit.

The skill gives no verdict, so phat-mode decides:

| Finding | Effect |
|---|---|
| Any Spec finding (incl. bugs) | must fix: back to the implementer |
| Standards violation | must fix: back to the implementer |
| Code smell | judgement call: sent along with must-fix findings, but never blocks the PR |

With nothing to fix, the PR opens. Otherwise the implementer fixes and both reviewers look again; after `maxReviewRounds` (2: one round of fixes) the PR opens with the open findings flagged. The PR's **Code review** section shows Standards and Spec side by side, never merged or reranked, and the skill's one-line summary (findings per axis and the worst within each).

## Setup

Needs Node 24+, git (with `user.name` and `user.email` set; phat-mode commits as you), and the GitHub CLI signed in (`gh auth login`).

```bash
cd ~/code/phat-mode
npm install
npm link                     # puts `phat-mode` on your PATH, running this checkout
phat-mode login --from-pi    # reuse the pi coding agent's GitHub Copilot login
# or: phat-mode login        # sign in to GitHub Copilot in the browser
```

Then, once per repo, in a clone of it:

```bash
cd ~/code/some-repo
phat-mode init               # writes .phat-mode.json, creates the labels, adds mattpocock/skills, says what is missing
git add .phat-mode.json .agents/skills   # and .claude/skills, if init linked skills there
git commit -m "Set up phat-mode" && git push
phat-mode doctor             # checks everything, including this repo's settings on GitHub
```

`init` suggests the install and check commands from the repo's files (npm, pnpm, yarn or bun scripts, Cargo, Go, `make check`) and asks before writing them; `--yes` accepts the suggestions, `--check "<cmd>"` and `--install "<cmd>"` set them. It copies mattpocock/skills' `triage`, `to-tickets`, `to-spec` and `tdd`, with every skill they use (`setup-matt-pocock-skills`, `grilling`, `domain-modeling`, `codebase-design`, `code-review`), pinned in [`skills/`](skills/) (same commit, MIT, © Matt Pocock), into the repo's `.agents/skills/`, linked from `.claude/skills/` if the repo uses Claude Code (a `.claude/` folder or `CLAUDE.md`), so everyone preparing issues has the skills phat-mode reads, and anyone building test-first has `tdd`; a skill the repo already has, in any skills folder, is kept as it is, and `--no-skills` copies none. It also copies pstack's [verification skills](#verification), `maintain-verification-skill` and, while the repo has no `verify-*` skill, `create-verification-skill`, the same way. Run `/setup-matt-pocock-skills` once afterwards: it writes the issue tracker and label settings `triage`, `to-tickets` and `to-spec` need; and `/create-verification-skill`, if the repo has no verification skill yet. It runs the check command once to see that it passes, and reports whether the repo has what makes phat-mode's work good: an `AGENTS.md` (or `CLAUDE.md`, `CONTRIBUTING.md`) with the repo's rules, a [verification skill](#verification), and the triage setup from [mattpocock/skills](https://github.com/mattpocock/skills).

A repo without a `.phat-mode.json` on its default branch is refused: phat-mode never guesses the check command that decides whether a change is good enough for a pull request.

## Commands

| Command | |
|---|---|
| `phat-mode init` | Set up the repo in this folder. See [Setup](#setup). |
| `phat-mode watch [--yolo] [repo…]` | Work through the ready issues one at a time, until Ctrl-C. In a set-up repo, asks: this repo or all. `--yolo` merges the clean PRs itself. See [Watch](#watch). |
| `phat-mode run [--yolo] <issue>` | Work on one issue until a PR is open, or shape it if it is labelled `agent-mode`. Run it again to resume. `--yolo` then waits and merges the PR. See [Yolo](#yolo). |
| `phat-mode resume` | Continue every interrupted run, building or shaping. |
| `phat-mode status` | List runs (every repo): shaping or building, and where they are. |
| `phat-mode abort <issue>` | Stop a run. |
| `phat-mode doctor [repo]` | Check git, gh, the Copilot login, the models, and each repo's settings, access and labels. |

`<issue>` is `12` (an issue in the repo of the current folder), `owner/name#12`, or the issue's URL; `[repo]` is `owner/name`. Without the link, `node src/cli.ts …` in this folder does the same.

Ctrl-C is always safe: progress is saved, and `run` or `resume` continues from the last step.

Only one phat-mode process can use `~/.phat-mode` at a time (Pi Durable storage has no cross-process locking), whatever the repo. A second one exits with `phat-mode is already running (…)`. A lock left by a crashed process is taken over automatically.

## Configuration

Two files: what each repo decides for itself, in the repo, and your own settings, on your Mac.

### Each repo: `.phat-mode.json`

At the repo root, read from GitHub (the default branch), so changes are reviewed like code and a branch cannot change them. Written by `phat-mode init`.

```json
{
  "installCommand": "npm ci",
  "checkCommand": "npm run check"
}
```

| Setting | |
|---|---|
| `installCommand` | Required. Runs once in each fresh workspace (`"true"` for none). |
| `checkCommand` | Required. Must pass before a pull request opens; agents run it too. Make it run every check you rely on. |
| `baseBranch` | Branch pull requests target. Default: the repo's default branch. |
| `allowedAuthors` | Trusted GitHub users for this repo. Default: yours (below). |
| `labels` | Triage label names, if the repo's `docs/agents/triage-labels.md` renames them: `needsTriage`, `needsInfo`, `readyForAgent`, `readyForHuman`, `wontfix`, and `agentMode`. |

Unknown settings are an error, so a typo is not silently ignored. Settings are read once per process: restart `watch` after changing them.

### Yours: `~/.phat-mode/config.json`

Optional; anything left out uses the defaults in [`src/config.ts`](src/config.ts).

```json
{
  "repos": ["iPhatty/phatty-lingo"],
  "allowedAuthors": ["iPhatty"],
  "limits": { "maxCheckFixes": 3, "maxReviewRounds": 2 },
  "watchIntervalMs": 120000
}
```

- `limits`: also `maxGrillRounds` (6) and `maxTickets` (8), for agent mode's shaping.
- `repos`: what `watch` works on when no repos are named (inside a set-up repo, it asks: that one or all). `init` adds to it.
- `allowedAuthors`: trusted on every repo that does not list its own. Default: you, the `gh` user.
- Repo settings (`checkCommand`, `repo`, …) here are an error, pointing to `.phat-mode.json`.

#### Models

Every agent uses `defaultModel` (built in: **Claude Opus 5.5, medium thinking**) unless `models` overrides it for its role (`plan`, `implement`, `review`, `verify`; both reviewers use `review`; agent mode's questioner uses `grill` and its answerer `shape`). Built in, `review` and `grill` use **GPT-6.1 Sol**, so a different model family checks the code and grills the answerer; `shape` follows `defaultModel`.

```json
{
  "defaultModel": { "provider": "github-copilot", "modelId": "claude-opus-5.5", "thinkingLevel": "medium" },
  "models": {
    "implement": { "thinkingLevel": "high" },
    "review": { "modelId": "gpt-6.1-sol" }
  }
}
```

- An override only needs the fields it changes; the rest come from `defaultModel`.
- `"review": null` drops the built-in reviewer model, so it follows `defaultModel`.
- `thinkingLevel`: `minimal`, `low`, `medium` or `high`.
- `phat-mode doctor` shows the model each role uses and checks it is on your Copilot account.
- A run keeps the models it started with, also when resumed. New runs use the new config.

`~/.phat-mode/` also holds the state database (`state.sqlite`, every repo's runs) and its lock, the Copilot login (`auth.json`, owner-only), and per repo the clone, workspaces (`workspaces/<owner>__<name>/issue-<n>`, and `shape-<n>` for shaping) and evidence.

## Safety

- Only `ready-for-agent` issues (a label only people with triage access can set) specified by `allowedAuthors` are worked on, and only `agent-mode` issues opened by `allowedAuthors` are shaped; others are ignored without any reply. Briefs from anyone else are ignored.
- Issue and brief text is treated as untrusted input in every prompt.
- Public repos: only pull requests from branches in the repo itself count as phat-mode's (a fork's `phat-mode/issue-N` branch is ignored), and only comments posted by the `gh` user are updated as phat-mode's own.
- Agents never touch git history or GitHub: `git push/commit/checkout/...` and `gh` are blocked. The pipeline does those itself.
- phat-mode only merges with `--yolo`, only the exact commit it judged clean, after every check passed, and never past branch protection. See [Yolo](#yolo).
- Only the implementer can write files, and only inside its workspace (never `.git`). Shaping's checkout is read-only on disk too (its files and folders, `node_modules` aside), and its agent may not change permissions, so commands it runs cannot change it.
- Agent commands run without your tokens in their environment, and credential folders are blocked, for commands and for the read tool (checked where a path really leads, so symlinks and `..` do not get around it).
- **Not a sandbox yet.** Agents run shell commands as you, on your Mac. Use it on repos and issues you trust. Containers come in a later stage.

## How it works

- `src/shaping.ts`: shaping, a second durable task with the same patterns (prepare, triage, fail). `src/task-kit.ts`: what both tasks share (asking an agent with a fixed request ID, reading its report, per-repo services). `src/runs.ts`: how `run` and `status` describe either kind of run.
- `src/pipeline.ts`: the build pipeline's durable task, one phase per step. Each phase saves a checkpoint before the next one starts. Agent requests have fixed IDs, so after a restart they reattach to the same request instead of asking again. Each run uses the settings and services of its own repo, so one process works on any number of repos.
- `src/config.ts` / `src/repos.ts`: your settings and each repo's `.phat-mode.json` (read from GitHub), and which repo an issue reference means. `src/init.ts`: what `phat-mode init` detects, installs and reports.
- `src/spec.ts`: finds the spec (Agent Brief or issue body), its acceptance criteria and blockers, and decides eligibility.
- `src/verify.ts`: finds the repo's verify skill, protects it, collects evidence, and decides what blocks.
- `src/skills.ts`: the pinned mattpocock/skills and pstack versions, and which skills `init` installs. `src/pr.ts`: the pr skill and evidence sources.
- `src/code-review.ts`: reads phat-mode's pinned code-review skill, finds standards sources, and decides what must be fixed.
- `src/yolo.ts`: `--yolo`: the verdict a run writes on its PR, and whether and when to merge it. `src/watch.ts`: what `watch` does next.
- `src/agents.ts`: the build agents (planner, implementer, Standards and Spec reviewers, verifier) and shaping's answerer, their tools, the report tools agents finish with, and the guard hook.
- `src/workspace.ts` / `src/github.ts`: git and GitHub, called only by pipeline code.
- Issue comments carry hidden markers, so a rerun updates its comment instead of posting again.

## Development

```bash
npm run check   # typecheck + tests
```

The tests run the whole pipeline with a scripted fake model, a fake GitHub and real git, including a crash and restart in the middle of a run.

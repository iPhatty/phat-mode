# phat-mode

Turns GitHub issues into **draft pull requests**, unattended. Built on [Pi Durable](https://earendil.com/posts/pi-durable/), so a run survives crashes, Ctrl-C and a sleeping laptop, and continues where it stopped.

> **Stage 1 MVP.** It runs on your Mac and works on one issue when you run it. Everything here may change.

## What it does

phat-mode is the **AFK agent** in a [mattpocock/skills](https://github.com/mattpocock/skills) workflow. You and the skills decide *what* to build; phat-mode builds it.

```
/triage, /to-tickets or /to-spec  →  issue labelled ready-for-agent  →  phat-mode run 12  →  draft PR
```

1. **Prepare**: only works on issues that are open, labelled `ready-for-agent`, specified by a trusted author, and not blocked by open issues. Anything else is left alone, with no reply. Labels it `phat-mode:working` and checks out branch `phat-mode/issue-12` in its own workspace.
2. **Plan** (AI, Claude Opus 5.5): reads the spec and the code, and plans *how* to build it. If the spec has a gap, it posts triage notes and moves the issue back to `needs-info`. If an agent shouldn't do it, it moves it to `ready-for-human`.
3. **Implement** (AI, Claude Opus 5.5): changes the code and adds tests.
4. **Verify** (code, not AI): runs `npm run check`. On failure, the output goes back to the implementer (up to 3 times).
5. **Code review** (GPT-6.1 Sol, a different model family, read-only): two reviewers in parallel, following Matt Pocock's [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) skill. See [Code review](#code-review).
6. **Publish** (code): commits, pushes, and opens a **draft** PR that closes the issue, lists the acceptance criteria for you to tick off, and is labelled `ready-for-human`.

It never merges and never pushes to `main`. You review and merge every PR.

### The spec

phat-mode builds from, in order:

1. the newest **Agent Brief** comment by a trusted author (`allowedAuthors`), from `/triage`, either the `## Agent Brief` template or a short inline `Agent brief: …`. The issue body is then background.
2. otherwise the **issue body**, if a trusted author opened the issue, as `/to-tickets` and `/to-spec` write them.

Acceptance criteria, out-of-scope lists and `Blocked by` references are read from either. Blockers are also read from GitHub's native issue dependencies.

### Labels

| Label | Set by | Meaning |
|---|---|---|
| `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | the triage skills, and phat-mode when it hands back | the issue's triage state (names configurable under `labels`) |
| `phat-mode:working` / `phat-mode:done` / `phat-mode:failed` | phat-mode | its own progress; one at a time |

| Outcome | Issue labels afterwards |
|---|---|
| Draft PR opened | `ready-for-agent` + `phat-mode:done` (the PR gets `ready-for-human`; the issue closes when the PR merges) |
| Spec has gaps | `needs-info`, with triage notes in the skills' format |
| Not for an agent | `ready-for-human`, with the reason |
| Gave up (e.g. checks keep failing) | `ready-for-human` + `phat-mode:failed`, with the reason |

To retry, label the issue `ready-for-agent` again and run it.

## Code review

phat-mode's reviewers follow mattpocock/skills' `code-review` skill. The pipeline does the skill's coordinator steps (fixed point: the base branch; spec: the one phat-mode built from; standards sources: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `.github/copilot-instructions.md`, `docs/**/*.md`), and two reviewer agents, in parallel and in separate conversations, review one axis each:

- **Standards**: the repo's documented standards (hard violations, citing the rule) plus the skill's baseline of 12 Fowler code smells (always judgement calls).
- **Spec**: requirements missing or partial, scope creep, and what looks wrong, each quoting the spec line. Plus one addition from phat-mode, which runs unattended: bugs, broken edge cases and leftover debugging code anywhere in the diff.

Each reviewer gets the skill's brief verbatim. The skill text comes from the target repo's committed copy (`.agents/skills/code-review/SKILL.md` or `.claude/skills/...`), read from the **base branch** so the implementer cannot change the rules it is reviewed by; otherwise from the bundled copy in [`skills/code-review/`](skills/code-review/) (MIT, © Matt Pocock).

The skill gives no verdict, so phat-mode decides:

| Finding | Effect |
|---|---|
| Any Spec finding (incl. bugs) | must fix: back to the implementer |
| Standards violation | must fix: back to the implementer |
| Code smell | judgement call: sent along with must-fix findings, but never blocks the PR |

With nothing to fix, the PR opens. Otherwise the implementer fixes and both reviewers look again; after `maxReviewRounds` (2: one round of fixes) the PR opens with the open findings flagged. The PR's **Code review** section shows Standards and Spec side by side, never merged or reranked, and the skill's one-line summary (findings per axis and the worst within each).

## Setup

Needs Node 24+, git, and the GitHub CLI signed in (`gh auth login`).

```bash
npm install
node src/cli.ts login --from-pi   # reuse the pi coding agent's GitHub Copilot login
# or: node src/cli.ts login       # sign in to GitHub Copilot in the browser
node src/cli.ts doctor            # checks everything
```

## Commands

| Command | |
|---|---|
| `node src/cli.ts run <issue>` | Work on an issue until a draft PR is open. Run it again to resume. |
| `node src/cli.ts resume` | Continue every interrupted run. |
| `node src/cli.ts status` | List runs and where they are. |
| `node src/cli.ts abort <issue>` | Stop a run. |
| `node src/cli.ts doctor` | Check git, gh, the Copilot login and the models. |

Ctrl-C is always safe: progress is saved, and `run` or `resume` continues from the last step.

Only one phat-mode process can use `~/.phat-mode` at a time (Pi Durable storage has no cross-process locking). A second one exits with `phat-mode is already running (…)`. A lock left by a crashed process is taken over automatically.

## Configuration

Optional `~/.phat-mode/config.json`; anything left out uses the defaults in [`src/config.ts`](src/config.ts).

### Models

Every agent uses `defaultModel` (built in: **Claude Opus 5.5, medium thinking**) unless `models` overrides it for its role (`plan`, `implement`, `review`; both reviewers use `review`). Built in, `review` uses **GPT-6.1 Sol**, so a different model family checks the code.

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
- `node src/cli.ts doctor` shows the model each role uses and checks it is on your Copilot account.
- A run keeps the models it started with, also when resumed. New runs use the new config.

### Everything else

```json
{
  "repo": "iPhatty/phatty-lingo",
  "allowedAuthors": ["iPhatty"],
  "labels": { "readyForAgent": "ready-for-agent", "readyForHuman": "ready-for-human", "needsInfo": "needs-info" },
  "checkCommand": "npm run check",
  "limits": { "maxCheckFixes": 3, "maxReviewRounds": 2 }
}
```

`~/.phat-mode/` also holds the state database (`state.sqlite`) and its lock, the Copilot login (`auth.json`, owner-only) and the workspaces (`workspaces/<repo>/issue-<n>`).

## Safety

- Only `ready-for-agent` issues (a label only people with triage access can set) specified by `allowedAuthors` are worked on; others are ignored without any reply. Briefs from anyone else are ignored.
- Issue and brief text is treated as untrusted input in every prompt.
- Agents never touch git history or GitHub: `git push/commit/checkout/...` and `gh` are blocked. The pipeline does those itself.
- Only the implementer can write files, and only inside its workspace (never `.git`).
- Agent commands run without your tokens in their environment, and credential folders are blocked.
- **Not a sandbox yet.** Agents run shell commands as you, on your Mac. Use it on repos and issues you trust. Containers come in a later stage.

## How it works

- `src/pipeline.ts`: the durable task, one phase per step. Each phase saves a checkpoint before the next one starts. Agent requests have fixed IDs, so after a restart they reattach to the same request instead of asking again.
- `src/spec.ts`: finds the spec (Agent Brief or issue body), its acceptance criteria and blockers, and decides eligibility.
- `src/code-review.ts`: reads the code-review skill (from the base branch, or the bundled copy), finds standards sources, and decides what must be fixed.
- `src/agents.ts`: the four agents (planner, implementer, Standards and Spec reviewers), their tools, the report tools agents finish with, and the guard hook.
- `src/workspace.ts` / `src/github.ts`: git and GitHub, called only by pipeline code.
- Issue comments carry hidden markers, so a rerun updates its comment instead of posting again.

## Development

```bash
npm run check   # typecheck + tests
```

The tests run the whole pipeline with a scripted fake model, a fake GitHub and real git, including a crash and restart in the middle of a run.

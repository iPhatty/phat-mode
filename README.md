# phat-mode

Turns GitHub issues into **draft pull requests**, unattended. Built on [Pi Durable](https://earendil.com/posts/pi-durable/), so a run survives crashes, Ctrl-C and a sleeping laptop, and continues where it stopped.

> **Stage 1 MVP.** It runs on your Mac and works on one issue when you run it. Everything here may change.

## What it does

```
phat-mode run 12
```

1. **Prepare**: checks the issue was opened by an allowed author, labels it `phat-mode:working`, and checks out branch `phat-mode/issue-12` in its own workspace.
2. **Triage** (AI): reads the issue and the code. Proceeds with a plan (posted on the issue), asks questions (`phat-mode:needs-info`), or declines.
3. **Implement** (AI): changes the code and adds tests.
4. **Verify** (code, not AI): runs `npm run check`. On failure, the output goes back to the implementer (up to 3 times).
5. **Review** (a different AI model, read-only): checks the diff. Findings go back to the implementer (up to 2 rounds).
6. **Publish** (code): commits, pushes, opens a **draft** PR that closes the issue, and labels it `phat-mode:done`.

It never merges and never pushes to `main`. You review and merge every PR.

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

Optional `~/.phat-mode/config.json`; anything left out uses the defaults in [`src/config.ts`](src/config.ts):

```json
{
  "repo": "iPhatty/phatty-lingo",
  "allowedAuthors": ["iPhatty"],
  "checkCommand": "npm run check",
  "models": {
    "implement": { "provider": "github-copilot", "modelId": "claude-sonnet-5.5" },
    "review": { "provider": "github-copilot", "modelId": "gpt-6.1-sol" }
  },
  "limits": { "maxCheckFixes": 3, "maxReviewRounds": 2 }
}
```

`~/.phat-mode/` also holds the state database (`state.sqlite`) and its lock, the Copilot login (`auth.json`, owner-only) and the workspaces (`workspaces/<repo>/issue-<n>`).

## Safety

- Only issues opened by `allowedAuthors` are worked on; others are ignored without any reply.
- Issue text is treated as untrusted input in every prompt.
- Agents never touch git history or GitHub: `git push/commit/checkout/...` and `gh` are blocked. The pipeline does those itself.
- Only the implementer can write files, and only inside its workspace (never `.git`).
- Agent commands run without your tokens in their environment, and credential folders are blocked.
- **Not a sandbox yet.** Agents run shell commands as you, on your Mac. Use it on repos and issues you trust. Containers come in a later stage.

## How it works

- `src/pipeline.ts`: the durable task, one phase per step. Each phase saves a checkpoint before the next one starts. Agent requests have fixed IDs, so after a restart they reattach to the same request instead of asking again.
- `src/agents.ts`: the three roles, their tools, the report tools agents finish with, and the guard hook.
- `src/workspace.ts` / `src/github.ts`: git and GitHub, called only by pipeline code.
- Issue comments carry hidden markers, so a rerun updates its comment instead of posting again.

## Development

```bash
npm run check   # typecheck + tests
```

The tests run the whole pipeline with a scripted fake model, a fake GitHub and real git, including a crash and restart in the middle of a run.

# `--yolo` merges phat-mode's own pull requests, behind gates it decides from GitHub alone

phat-mode used to never merge. `phat-mode watch --yolo` and `phat-mode run --yolo` now squash-merge a phat-mode pull request (`--squash --delete-branch`) when all of these hold:

1. **phat-mode found it clean.** At publish, the run writes a hidden marker in the PR description, `<!-- phat-mode:yolo clean|not-clean sha=<pushed commit> reason="…" -->`, on every PR, with or without `--yolo`. Not clean: a code reviewer did not report, must-fix review findings are still open, verification found failures this change caused, the verifier did not report, verification could not run, or the implementer changed the verification skill (even though it was reverted). Skipped verification (the repo has no verify skill), smells, pre-existing failures and feature map edits stay clean, as they never block a PR either. No marker (e.g. a PR from an older phat-mode, or a human removed it) means: do not merge.
2. **The head is still the commit phat-mode judged**, and the merge is pinned to it with `--match-head-commit`, so nothing pushed in between slips in.
3. **That commit is at least 1 minute old** (`SETTLE_MS`, fixed), so checks GitHub has not queued yet can still show up.
4. **Every check run and commit status on it passed** (skipped and neutral count as passed); required or not. A PR with no checks at all merges: phat-mode's own check command, code review and verification already passed it.

Checks running or settling: wait. Anything else (a failed check, not clean, new commits, GitHub refusing because of branch protection, conflicts or a disabled squash merge) leaves the PR to the human, with one line saying why. phat-mode never uses `--admin` and never falls back to another merge method. Each merge gets a PR comment naming the command.

## Considered Options

- **GitHub auto-merge** (`gh pr merge --auto`). Rejected: it only waits for *required* checks, needs a repo setting and branch protection, and keeps going after phat-mode stops.
- **The verdict in a PR label, or in the local state database.** Rejected: a label cannot carry the commit; the database is lost with `~/.phat-mode` and breaks watch's rule of working everything out from GitHub on each look.
- **Merging with zero checks only after a human sets up CI.** Rejected: phat-mode's own checks, review and verification are the gate that matters; the settle time covers CI that has not shown up yet.
- **Waiting for the merge inside the durable pipeline (a `merge` phase).** Rejected: `watch` would be stuck in a run while CI runs, holding up every repo. `run --yolo` waits in the CLI after the run instead; after Ctrl-C, `run --yolo <issue>` goes straight back to waiting when the PR is open and no run is going.
- **Bypassing branch protection with `--admin`.** Rejected: if GitHub says no, the answer is no.

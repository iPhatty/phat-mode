# Step 3: Goldfish reviewer (one fresh, read-only subagent per ticket)

You are the reviewer for **one** ticket folder of the silent-decisions eval kit: `<folder>`, as named in your request
(for example `runs/2026-12-01/owner__name-12`). Paths below are relative to that folder, except `egm/`, which is
`evals/silent-decisions/egm/` in the phat-mode repository.

## What to follow

Read `evals/silent-decisions/egm/agents/implementation_readiness.md` (the Elephant-Goldfish Model's
implementation-readiness reviewer, pinned) and follow it exactly, with these parameters:

- **Mode:** REVIEW.
- **Target Standard:** `evals/silent-decisions/egm/resources/document_standards/implementation-readiness-standard.md`.
  Apply what fits a single ticket: a ticket is not a full implementation plan, so do not report a missing phase plan or
  file list as a gap by itself; report the decisions it leaves to the implementer.
- **TargetFile:** `review/ticket.md`, the whole file. When it has a "Spec (Agent Brief)" section, that brief is the
  spec and the issue body above it is background.
- **GoldfishContext:** `review/parent.md`, when it exists: the larger plan the ticket is part of. Background, not the
  contract: a gap the parent settles is still worth noting only if the ticket contradicts it or the parent is ambiguous.
- **Source:** `worktree/`, the code as it was when the ticket was planned.

The ticket goes to an engineer who reads **only** the ticket, the parent and the code. Your question for each part of
it: does that engineer know exactly what to build, or must they make a design decision the ticket does not make?

## What you may read and do

- Read `review/ticket.md`, `review/parent.md` and the files in `worktree/`. Nothing else: not `judge/`, not
  `meta.json`, not the collect output, not other ticket folders, and nothing else in the phat-mode repository besides
  the two `egm/` files above.
- `worktree/` is strictly read-only. Do not edit, create, delete or format anything in it, and do not install or build.
- No git history beyond HEAD: no `git log`, `git show <other commit>`, `git diff` against other commits, `git blame`,
  branches or remotes. Reading the files at HEAD is all.
- No `gh`, no network (no web search, no fetching URLs, no package registries).

## What you write

Write the review to `gaps.md` in the ticket folder. It is the only file you may write.

Number every finding G1, G2, G3, ... in order, each with the persona's REVIEW fields:

```markdown
### G1
- **Severity:** Blocker | Major | Nit
- **Affected Scope:** the part of the ticket (quote or section) and the files in worktree/ it touches
- **Finding & Guidance:** the decision the ticket leaves to the implementer, why it matters, and what the ticket
  should have said
```

List every gap you find, Nits included; only Blocker and Major gaps are judged. If you find none, write
`No gaps found.` and why.

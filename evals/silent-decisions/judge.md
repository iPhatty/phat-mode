# Step 4: Judge (one fresh subagent per ticket)

You judge **one** ticket folder of the silent-decisions eval kit: `<folder>`, as named in your request (for example
`runs/2026-12-01/owner__name-12`). The reviewer has already written `gaps.md` there. Paths below are relative to that
folder.

## What you are judging

A fresh reviewer read only the ticket, its parent and the code the planner saw, and listed the gaps it found
(`gaps.md`). phat-mode then planned and built the ticket. You decide, for each Blocker or Major gap, whether it was real
and how the build settled it; then how the build dealt with the ADRs that landed while the ticket waited, with the
plan's silent decisions, and with the implementer's departures from them.

**Be skeptical in both directions.** The reviewer can nitpick, or miss that the ticket, the parent or the code already
answers a gap. The builder can quietly guess, and a plan or PR can claim more than the code does. Check the code.

## What you may read

- `gaps.md`, everything in `review/` (`ticket.md`, `parent.md`) and `judge/`, and `meta.json`.
  - `judge/plan.md`: the plan comment, with **Decided where the ticket was silent** (the silent decisions) when the run
    recorded them.
  - `judge/pr.md`: the pull request description, with the silent decisions, any **Departures**, and the **code
    review**: what the Spec reviewer found, or that it found nothing.
  - `judge/silent-decisions.json`, `judge/departures.json`: the same lists, parsed; present only when the run recorded
    them (`meta.json`: `silentDecisionsRecorded`, `departuresRecorded`).
  - `judge/window.json`: the commits between the spec being written and planning, and the ADRs and glossaries they
    added or changed.
  - `judge/merge-commit.txt`: the merged code.
  - `meta.json`: times, commits and flags. `bodyEditedAfterPlanning`: the ticket the reviewer saw may differ from the
    one the planner saw; `planReplanned`: the plan comment was updated after it was posted (a retry). Allow for both.
- `worktree/` (a checkout of the base commit planning started from), the repo's docs (ADRs, glossary, README) in it,
  and the merged code: in `worktree/` you may run read-only git commands such as `git show <merge>:<path>`,
  `git diff <baseCommit> <merge>` and `git log <baseCommit>..<merge>`. Do not check anything out or change the worktree.
- No `gh` and no network.

## How to score

### Each Blocker and Major gap in `gaps.md` (skip Nits)

- `real`: `false` when the ticket, the parent or the code already answered it, or it is an irrelevant nitpick;
  otherwise `true`.
- `outcome`, for a real gap (`null` when not real):
  - `handled`: settled consistently with the ticket, the parent and the repo's docs, and acceptable to a reasonable
    maintainer;
  - `guessed`: settled questionably: it conflicts with the docs or the parent, a maintainer would likely have chosen
    differently, or it introduced a defect;
  - `missed`: not addressed, and it matters;
  - `moot`: not addressed, and it didn't matter.
- `visible`, for a handled or guessed gap (`null` otherwise): where a maintainer could see the decision first:
  `plan` (the plan comment), `pr` (only the PR description), or `code-only` (only in the code).
- `inSilentDecisions`, when the run recorded silent decisions (`null` when it did not): `true` when the plan's silent
  decisions list the gap's question (in substance, not word for word), else `false`.
- `evidence`: one or two sentences naming where you saw it (file and line, plan item, PR section).

### Each ADR in `judge/window.json` (`docChanges` with `"doc": "adr"`)

- `relevant`: whether the ADR constrains this ticket.
- `followed`, for a relevant ADR (`null` otherwise): `yes`, `partly` or `no`, in the merged code.

### Each departure in `judge/departures.json`

- `justified`: whether doing something other than the agreed decision was right, for the reason given.
- `caughtBySpecReviewer`, for an unjustified departure (`null` when justified): whether the Spec reviewer's findings in
  `judge/pr.md` raised it.

### Each silent decision in `judge/silent-decisions.json`

- `sound`: whether a reasonable maintainer would accept the decision, given the ticket, the parent and the docs.
- `followed`: whether the merged code follows it.
- `reportedAsDeparture`, for a decision the code does not follow (`null` when followed): whether `judge/departures.json`
  reports it.
- `passedBySpecReviewer`, for an unsound decision or one departed from without a report (`null` otherwise): `true` when
  the Spec reviewer raised nothing about it.

## What you write

Write exactly two files in the ticket folder, and nothing else:

1. `judgement.json`, in this schema (`score.ts` rejects anything else; every field is required, `null` where the rules
   above say so, and lists may be empty). Copy `repo`, `number`, `silentDecisionsRecorded` and `departuresRecorded`
   from `meta.json`. `silentDecisions` and `departures` stay empty when the run did not record them.

   ```json
   {
     "repo": "owner/name",
     "number": 12,
     "silentDecisionsRecorded": true,
     "departuresRecorded": true,
     "gaps": [
       { "id": "G1", "severity": "Blocker", "real": true, "outcome": "handled", "visible": "plan", "inSilentDecisions": true, "evidence": "Plan decision 2 settles the order; src/list.ts:40 follows it." },
       { "id": "G2", "severity": "Major", "real": true, "outcome": "guessed", "visible": "code-only", "inSilentDecisions": false, "evidence": "src/retry.ts:12 retries forever; ADR 0003 caps retries at 3." },
       { "id": "G3", "severity": "Major", "real": true, "outcome": "missed", "visible": null, "inSilentDecisions": false, "evidence": "Nothing handles an empty list; it crashes in src/list.ts:52." },
       { "id": "G4", "severity": "Major", "real": false, "outcome": null, "visible": null, "inSilentDecisions": false, "evidence": "The ticket's second criterion answers it." }
     ],
     "adrs": [
       { "path": "docs/adr/0003-retries.md", "relevant": true, "followed": "no", "evidence": "src/retry.ts retries forever." },
       { "path": "docs/adr/0004-colours.md", "relevant": false, "followed": null, "evidence": "UI colours only; this ticket has no UI." }
     ],
     "departures": [
       { "decision": "Newest first.", "justified": false, "caughtBySpecReviewer": false, "evidence": "No reason that holds; the code review lists no finding about it." }
     ],
     "silentDecisions": [
       { "decision": "Newest first.", "sound": true, "followed": false, "reportedAsDeparture": true, "passedBySpecReviewer": null, "evidence": "Reported as a departure." },
       { "decision": "Keep the old column.", "sound": true, "followed": true, "reportedAsDeparture": null, "passedBySpecReviewer": null, "evidence": "Migration keeps it." }
     ]
   }
   ```

2. `judgement.md`: a short prose summary (a few paragraphs at most): how ready the ticket was, how the build settled
   its gaps, and anything worth a maintainer's attention, such as a guessed or missed gap, an ADR not followed, an
   unjustified or unreported departure, or a flag in `meta.json` that affected your judgement.

Do not edit `gaps.md`, anything in `review/`, `judge/` or `worktree/`, or anything outside the ticket folder.

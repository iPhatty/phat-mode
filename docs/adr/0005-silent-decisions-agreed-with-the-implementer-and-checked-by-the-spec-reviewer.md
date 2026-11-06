# Silent decisions are agreed with the implementer and checked by the Spec reviewer

Tickets are never fully self-contained, and the planner fills the gaps. phat-mode now makes that gap-filling explicit instead of leaving it as free text in the plan. The planner reports each question the spec leaves open, with its answer and why, as a structured **silent decision** in `report_plan`. A plan to proceed with none must say why the spec settles everything, or code rejects it and the planner reports again, as for test seams. The implementer gets the silent decisions as **agreed decisions**, next to the agreed seams. It follows them, or reports each one it does not follow as a **departure** in `report_done`, with what the change does instead and why. It may depart when the code shows a decision was wrong, but it must say so. The plan comment and the pull request list the silent decisions, and the pull request lists the departures separately, so a `--yolo` maintainer can scan both on a merged PR. The existing Spec reviewer checks them. It judges whether each silent decision is a reasonable reading of the spec, whether the change follows it, and whether each departure is justified, and it reports a must-fix `decision` finding where not.

Before planning, the plan request also lists the ADRs and glossary changes (`GLOSSARY.md`, `CONTEXT.md`) made on the base branch after the spec was written, each with its commit's short sha and subject. The spec was written at the Agent Brief's creation time, else the `shaped-at` time of a body shaping rewrote, else the issue's creation time. Only ADRs and glossaries count, because nearly every commit touches the other docs. The planner follows a later constraint the ticket doesn't mention and records it as a silent decision. Where a later change contradicts the ticket, it doesn't choose: it reports `needs_info` and names the conflict.

## Why

An evaluation of 15 built tickets (phatty-lingo and phat-mode, 2026-11-06) gave a fresh reviewer only the ticket, its parent and the code at that moment. It found about 7 real Blocker/Major gaps per ticket, 106 in all. Judged against the plans, PRs and merged code:

- the planner and build settled 102 of them (96%);
- 3 were guessed, and 0 were missed;
- 90% of the decisions were already written somewhere in the plan comment;
- of the ADRs that landed while a ticket waited and were relevant to it, 12 of 12 were followed.

None of the failures were gaps the planner left. They all happened after planning:

- **phatty-lingo #11 (Practise weakest):** the plan decided a right answer leaves an item's box unchanged. The implementer did the opposite, and nobody compared the code to the plan.
- **phatty-lingo #11 (speaking):** the plan said to ship listening-only if speaking didn't exist. The build added a partial speaking feature instead.
- **phatty-lingo #73:** the code shows "Preparing…" on every cold launch, though the ticket says only during the first preparation. The Spec review passed it.

Separately, phatty-lingo #75 went stale before it was planned: an ADR written by a sibling ticket after #75 was shaped added a requirement the ticket never got.

So the planner fills gaps well. What's missing is holding the build to the planner's answers, and telling the planner what changed since the ticket was written. Agreed decisions, reported departures and a Spec reviewer that checks both cover that, using agents that already exist.

## Considered Options

- **A separate zero-context "Goldfish" reviewer before planning**, which reads the ticket cold and lists its gaps for the planner. Rejected: the evaluation shows the planner already settles 96% of the gaps and misses none, so another agent and pipeline phase would add cost and latency to fix what already works. The failures came after planning, which a pre-planning reviewer never sees.
- **Leaving the decisions as free text in the plan.** Rejected: that is what failed. The implementer didn't see them as decisions it had to keep, and nobody checked the code against them.
- **Deciding in code which changed docs are relevant to the ticket.** Rejected: relevance is a judgement for the planner. Code lists every ADR and glossary change, and nothing else.

## When to revisit

Revisit when a merged PR rests on a bad silent decision, or on an unreported departure, that the Spec reviewer passed.

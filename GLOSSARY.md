# phat-mode

phat-mode turns GitHub issues into pull requests with no human in the loop. Agent mode extends it backwards: a vague issue is shaped into tickets it can build.

## Language

**Shaping**:
Turning a vague issue labelled `agent-mode` into a spec and `ready-for-agent` Tickets, with no human answering questions.
_Avoid_: Triage, planning, grooming

**Parent**:
The shaped issue holding the spec, labelled `phat-mode:shaped`; it is never built itself, only its Tickets are.
_Avoid_: Epic, umbrella issue

**Ticket**:
A tracer-bullet sub-issue of a Parent, labelled `ready-for-agent`, that can be built and verified on its own.
_Avoid_: Task, story, slice

**Questioner**:
The agent on the `grill` role that follows the pinned `grilling` skill as its Standing skill, asking rounds of questions, each with a recommended answer.
_Avoid_: Interviewer, griller

**Answerer**:
The agent on the `shape` role that decides each of the Questioner's questions from the codebase, the glossary and the ADRs; it also does triage's checks, the spec and the Ticket breakdown.
_Avoid_: User, human, responder

**Standing skill**:
A skill a role follows for its whole conversation, rendered from phat-mode's pinned copy into a section of its system prompt, so it is on every request and survives compaction: `grilling` for the Questioner, `codebase-design` for the planner, `tdd` for the implementer.
_Avoid_: System skill, global skill, always-on skill

**Step skill**:
The skill for one step, pasted verbatim into that one request: phat-mode's pinned copy of `triage`, `to-spec`, `domain-modeling`, `to-tickets`, `code-review` or `pr`, or the repo's own verify skill.
_Avoid_: Request skill, inline skill

**Project lock**:
The lock a process holds on one project (repo) while it has that project's durable database open; its file names the holder's pid and command and what it is doing (issue, kind, phase). See ADR 0004.
_Avoid_: Global lock, state lock

**Silent decision**:
A question the spec leaves open that the plan answers, reported by the planner in `report_plan` with its decision and why; the implementer agrees to follow it, and the Spec reviewer checks it. See ADR 0005.
_Avoid_: Assumption, gap, plan note

**Departure**:
A silent decision the change does not follow, reported by the implementer in `report_done` with what the change does instead and why; the Spec reviewer judges whether it is justified.
_Avoid_: Deviation, override, exception

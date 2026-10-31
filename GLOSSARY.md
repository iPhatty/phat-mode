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
The agent on the `grill` role that follows the pinned `grilling` skill, asking rounds of questions, each with a recommended answer.
_Avoid_: Interviewer, griller

**Answerer**:
The agent on the `shape` role that decides each of the Questioner's questions from the codebase, the glossary and the ADRs; it also does triage's checks, the spec and the Ticket breakdown.
_Avoid_: User, human, responder

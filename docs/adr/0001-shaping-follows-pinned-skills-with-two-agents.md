# Shaping follows pinned skills, with two agents grilling each other

Shaping follows phat-mode's own pinned copies of the `triage`, `grilling`, `domain-modeling`, `to-spec` and `to-tickets` skills, given verbatim, plus an autonomy overlay that makes the answering agent stand in for the user; a copy installed in the repo being shaped is never used. A Questioner (`grill` role) and an Answerer (`shape` role), in separate conversations and on different model families by default, grill each other and decide everything without a human, until the Questioner finds nothing left to ask (there is no round limit). Every decision they make for the human is written down as an assumption, one-way doors first, so the maintainer can check it after the fact instead of answering questions during it.

## Considered Options

- **A human in the loop** (the skills as written: someone answers each question and approves the breakdown). Rejected: the point of agent mode is that a rough issue becomes merged PRs without the maintainer at every step.
- **One agent grilling itself.** Rejected: one model asking and answering in one conversation tends to agree with itself; two conversations on two model families keep the grilling honest, as the code review already does.
- **The repo's own copy of the skills.** Rejected: the repo's copy can drift or be edited by anyone who can open a PR; pinned copies keep shaping's behaviour fixed and tested.

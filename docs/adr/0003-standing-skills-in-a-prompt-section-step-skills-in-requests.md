# Standing skills in a prompt section, step skills in requests

phat-mode gives its agents skills two ways. A **step skill** belongs to one request (`triage`, `to-spec`, `domain-modeling`, `to-tickets`, `code-review`, `pr`, the repo's verify skill) and is pasted verbatim into that request. A **standing skill** is one a role follows for its whole conversation: the questioner's `grilling` (with the autonomy overlay), the planner's `codebase-design` and the implementer's `tdd` (with an overlay that makes the planner the user and the seams the plan reports, listed in the implementer's request, the agreed seams). Standing skills are rendered from phat-mode's own pinned `skills/` into a Pi Durable system prompt section, `skills` from the `phat.skills` extension, which reads the conversation's role and renders before every request. Each role's standing skills are fixed in code, like its tools. Where phat-mode gives a skill, either way, its copy wins over one installed in the project; every agent's shared rules say so.

A section is there on every request, and Pi Durable re-plans the full system prompt after a compaction, so a long grilling (no round limit, automatic compaction) cannot summarise its skill away, as it could when `grilling` came only in the round-1 request. No agent can skip it, and old conversations pick it up without a migration, since they follow the host's default extensions.

## Considered Options

- **Keep every skill in the request.** Rejected for skills that span a conversation: compaction can summarise the first request, and the skill and its overlay with it, while the agent keeps going.
- **On-demand skill loading** (a list of skill names in the system prompt, read when the agent chooses). Rejected: a required step must not depend on the agent choosing to load it, and what it reads would not be fixed or tested.
- **Following the repo's installed copy** (its `AGENTS.md` may point at `.agents/skills`). Rejected, as in ADR 0001: pinned copies keep behaviour the same on every repo and covered by the tests; the repo's copies are background.
- **Standing skills configurable per repo or in `config.json`.** Not now: like `ROLE_TOOLS`, the set is part of how each role works and is tested as such.

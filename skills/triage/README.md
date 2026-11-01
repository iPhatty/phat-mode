# Pinned: mattpocock/skills `triage`

Everything here but this README and `LICENSE` is an unmodified copy of
[skills/engineering/triage/](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336/skills/engineering/triage)
at commit `49dd158d1076134a641b33efb035946536778336` (2026-10-09), © Matt Pocock, MIT License (see `LICENSE`).

phat-mode follows this copy when it shapes an `agent-mode` issue: its answering agent gets `SKILL.md` and
`OUT-OF-SCOPE.md` verbatim, plus an autonomy overlay, and runs triage's checks. A copy installed in the repo being
shaped is never used. `phat-mode init` also copies it into the repo it sets up (`.agents/skills/triage/`), so the
people preparing issues for phat-mode have it. It never replaces a copy the repo already has: once installed, the repo
owns it.

To upgrade: copy the new upstream files here, update the commit above and `MATTPOCOCK_SKILLS` in `src/skills.ts`
(shared with every pinned skill), and run `npm test`.

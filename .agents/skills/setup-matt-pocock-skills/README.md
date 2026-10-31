# Pinned: mattpocock/skills `setup-matt-pocock-skills`

Everything here but this README and `LICENSE` is an unmodified copy of
[skills/engineering/setup-matt-pocock-skills/](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336/skills/engineering/setup-matt-pocock-skills)
at commit `49dd158d1076134a641b33efb035946536778336` (2026-10-09), © Matt Pocock, MIT License (see `LICENSE`).

phat-mode does not run this skill itself. `phat-mode init` copies it into the repo it sets up (`.agents/skills/setup-matt-pocock-skills/`),
so the repo can be configured for `triage`, `to-tickets` and `to-spec`: they need its issue tracker and triage
label settings (`docs/agents/`). It never replaces a copy the repo already has: once installed,
the repo owns it.

To upgrade: copy the new upstream files here, update the commit above and `MATTPOCOCK_SKILLS` in `src/skills.ts`
(shared with every pinned skill), and run `npm test`.

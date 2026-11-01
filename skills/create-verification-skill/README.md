# Pinned: pstack `create-verification-skill`

Everything here but this README and `LICENSE` is an unmodified copy of
[pstack/skills/create-verification-skill/](https://github.com/cursor/plugins/tree/ae5650febf4320793844c12c4adaa937f417f8da/pstack/skills/create-verification-skill)
at commit `ae5650febf4320793844c12c4adaa937f417f8da` (2026-10-31), © Lauren Tan, MIT License (see `LICENSE`).

phat-mode does not run this skill itself. `phat-mode init` copies it into a repo that has no verification skill yet
(`.agents/skills/create-verification-skill/`). Run `/create-verification-skill` once there: it writes the
`verify-<app>` skill (to `.cursor/skills/`, where phat-mode looks too) that phat-mode's verifier follows. Its
counterpart `maintain-verification-skill` is installed with it. It never replaces a copy the repo already has: once
installed, the repo owns it.

To upgrade: copy the new upstream files here, update the commit above and `PSTACK_SKILLS` in `src/skills.ts`
(shared with `maintain-verification-skill`), and run `npm test`.

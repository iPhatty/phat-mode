# Pinned: pstack `maintain-verification-skill`

Everything here but this README and `LICENSE` is an unmodified copy of
[pstack/skills/maintain-verification-skill/](https://github.com/cursor/plugins/tree/ae5650febf4320793844c12c4adaa937f417f8da/pstack/skills/maintain-verification-skill)
at commit `ae5650febf4320793844c12c4adaa937f417f8da` (2026-10-31), © Lauren Tan, MIT License (see `LICENSE`).

phat-mode does not run this skill itself. `phat-mode init` copies it into the repo it sets up
(`.agents/skills/maintain-verification-skill/`), to keep the repo's `verify-<app>` skill and its feature map current.
When phat-mode's verifier finds the feature map drifting from the app, the pull request points at
`/maintain-verification-skill`. It never replaces a copy the repo already has: once installed, the repo owns it.

To upgrade: copy the new upstream files here, update the commit above and `PSTACK_SKILLS` in `src/skills.ts`
(shared with `create-verification-skill`), and run `npm test`.

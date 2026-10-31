# Pinned: mattpocock/skills `codebase-design`

Everything here but this README and `LICENSE` is an unmodified copy of
[skills/engineering/codebase-design/](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336/skills/engineering/codebase-design)
at commit `49dd158d1076134a641b33efb035946536778336` (2026-10-09), © Matt Pocock, MIT License (see `LICENSE`).

phat-mode does not run this skill itself. `phat-mode init` copies it into the repo it sets up (`.agents/skills/codebase-design/`),
because `tdd` calls it for the deep-module vocabulary when an interface's shape is in question. It never replaces a copy
the repo already has: once installed, the repo owns it.

To upgrade: copy the new upstream files here, update the commit above and `MATTPOCOCK_SKILLS` in `src/skills.ts`
(shared with every pinned skill), and run `npm test`.

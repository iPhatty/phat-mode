# Pinned: mattpocock/skills `code-review`

Everything here but this README and `LICENSE` is an unmodified copy of
[skills/engineering/code-review/](https://github.com/mattpocock/skills/tree/49dd158d1076134a641b33efb035946536778336/skills/engineering/code-review)
at commit `49dd158d1076134a641b33efb035946536778336` (2026-10-09), © Matt Pocock, MIT License (see `LICENSE`).

phat-mode's two reviewers always follow this copy, on every repo. A copy installed in the repo under review is never used.

`phat-mode init` also copies it into the repo it sets up (`.agents/skills/code-review/`), because `tdd` leaves
refactoring to it. It never replaces a copy the repo already has; that copy is the repo's, and phat-mode's reviewers
still use this one.

To upgrade:

1. Copy the new upstream files here.
2. Update the commit above and `MATTPOCOCK_SKILLS` in `src/skills.ts` (shared with every pinned skill).
3. Run `npm test`. It fails if the skill's layout changed so that the briefs or the smell baseline can no longer be read.

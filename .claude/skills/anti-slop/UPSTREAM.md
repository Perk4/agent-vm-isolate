# Provenance

- Upstream: https://github.com/dmmulroy/anti-slop
- Pinned commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10, "Merge pull request #36", `package.json` version 0.1.2)
- License: MIT, Copyright (c) 2026 Dillon Mulroy. Full text in `LICENSE.upstream`.

## What upstream is

`oxlint-plugin-anti-slop` is an Oxlint JS plugin: 18 generic AST/scope rules plus 5 opt-in Effect rules, under `src/`. Upstream recommends running it together with the built-in `oxc/no-accumulating-spread`. It also ships one agent skill, `skills/install-anti-slop`. That skill installs the plugin: it copies `src/` into `tools/oxlint/anti-slop/`, installs `oxlint` and `@oxlint/plugins`, and edits the Oxlint config. It is not guidance for writing code. Upstream is designed to be vendored and edited, and there is no npm package.

## What we took

None of the upstream code is copied. `SKILL.md` restates rules from the upstream README in our own words and adapts them to this repo. `scripts/anti-slop.sh` re-implements three rules as grep (rules 9-11). Grep is less precise than the AST rules: a chain with an assertion nested inside a call, or an assertion that spans lines, is missed.

| Upstream rule | Here |
| --- | --- |
| `no-chained-type-assertions` | CI grep (rule 9), non-test files |
| `no-reflect-apply`, `no-reflect-get` | CI grep (rule 10) |
| `no-module-mocking` (Vitest/Jest) | CI grep (rule 11), extended to `node:test` `mock.module` |
| `require-safety-comment-for-type-assertion` | Review only, for new casts. Current code has about 8 unannotated casts in non-test files, so a grep gate would fail on today's code. |
| `no-known-value-widening`, `no-widen-then-assert`, `no-object-parameters`, `no-array-filter-map`, `no-reduce-accumulator-copy` (+ `oxc/no-accumulating-spread`) | Review only (they need type or scope info) |
| `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`, `no-runtime-typeof`, `no-unsafe-dictionary-type` | **Not adopted.** We are zero-dependency and have no schema library, and REVIEW.md says "`unknown` and narrow". Hand narrowing with `typeof` at the JSON boundary is our parsing. |
| `no-conditional-empty-object-spread` | **Not adopted.** It conflicts with our `exactOptionalPropertyTypes` convention (CLAUDE.md: "omit it or spread conditionally"). |
| `no-shape-in-symbol-names` | **Not adopted.** It is upstream's naming taste, not a correctness issue. |
| `require-readable-spacing` | **Not adopted.** Formatting is a formatter's job. |
| Effect rules | **Not applicable.** We don't use Effect. |

## Getting the real Oxlint rules

For AST precision, run upstream's installer skill. It adds two dev dependencies (`oxlint` and `@oxlint/plugins`, pinned to the same version) and a vendored `tools/oxlint/anti-slop/`:

```sh
npx skills add dmmulroy/anti-slop --skill install-anti-slop
# then ask Claude Code to "install anti-slop", and disable the rules marked "Not adopted" above
```

## Updating

Re-read the upstream README at a newer commit, carry over any new rules that fit, and update the pinned commit above.

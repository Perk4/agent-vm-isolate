---
name: anti-slop
description: Rules for writing and reviewing TypeScript in this repo without model-generated slop (type laundering, unjustified casts, module mocks, quadratic reducers, narrating comments). Use whenever you write, edit, or review .ts code under src/ or iphone-agent/src/, and before opening a PR.
---

# Anti-slop for this repo

Three layers enforce these rules. You are the first one: write code that passes all three.

1. **You, while writing** (this skill).
2. **CI, deterministically**: `bash scripts/anti-slop.sh` greps for the rules marked **[CI]** and prints `file:line` for each hit. Run it before you commit.
3. **Claude review in GitHub Actions** (`.github/workflows/claude-review.yml`): reviews each PR push against `REVIEW.md` and this file, and flags the rules marked **[review]**.

Several rules are adapted from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT). Upstream ships them as Oxlint AST rules. We keep this repo free of dependencies, so CI checks the greppable ones and review checks the rest. `UPSTREAM.md` lists what we adopted, what we left out, and why.

## Types

- **[CI]** No `any`: no `: any`, no `as any`, no `<any>`. Use `unknown` at the boundary and narrow it.
- **[CI]** No `@ts-ignore` or `@ts-nocheck`. If a suppression is truly unavoidable, use `@ts-expect-error` and give a reason.
- **[CI]** No chained assertions (`x as unknown as T`, `x as object as T`) in non-test code. They make up evidence the code doesn't have. Parse or narrow instead. A chain that ends in `as const` is fine. Tests may chain to build partial SDK fixtures.
- **[review]** A new non-`const` `as` in non-test code needs a justification on the line above, e.g. `// SAFETY: JSON.parse of a WDA body; every field is narrowed below.` The same goes for `!` used to silence `noUncheckedIndexedAccess` (REVIEW.md). Existing casts are grandfathered.
- **[review]** Don't widen a value you already know. For example, `const handlers: Record<string, H> = { start }` throws away the `start` key. Use `satisfies Record<string, H>` and keep the inferred type.
- **[review]** Don't widen and then assert back. If a value is assigned to `unknown` or `Record<string, unknown>` and later cast to the type it already had, keep the original type.
- **[review]** Don't type function inputs as `object`. Name the fields you read.
- **Allowed here, unlike upstream:** `unknown` parameters, `typeof` narrowing, and `Record<string, unknown>` at the JSON boundary (WDA responses, MCP and tool inputs). We have no schema library, so narrowing by hand *is* our boundary parsing. Keep it at the boundary: once a value is narrowed, give it a real type.
- **Allowed here, unlike upstream:** conditional spreads such as `...(x !== undefined ? { x } : {})`. With `exactOptionalPropertyTypes` they are how we omit an optional property (CLAUDE.md).

## Runtime

- **[CI]** No `Reflect.apply` or `Reflect.get`. Call the function, or read the property through a typed reference.
- **[CI]** No `console.log` outside `iphone-agent/src/cli.ts` and `mock-wda.ts`.
- **[CI]** No empty `catch`. Handle the error, or write a comment saying why it is safe to ignore.
- **[review]** Don't run `.filter(...).map(...)` or `.map(...).filter(...)` over an array as two eager passes. Use one `flatMap`, a loop, or a `reduce` that pushes into a fresh local array. (Node 22 has iterator helpers, but our `lib` is ES2022 and has no types for them.)
- **[review]** Don't copy the accumulator inside a reducer: `{...acc, x}`, `Object.assign({}, acc, x)`, `acc.concat([x])` or `acc.slice()`. Mutate the fresh accumulator and return it.
- **[review]** Retry loops must be bounded, and WDA errors must come back as `tool_result` with `is_error: true` (REVIEW.md).

## Tests

- **[CI]** No module mocking (`vi.mock`, `jest.mock`, or `mock.module` from `node:test`). Inject the dependency instead, the way the tests inject the mock WDA (`startMockWda`) and a fake model client.
- **[CI]** No `.only(` and no `{ only: true }`.
- **[review]** Don't write tests that only assert the mock returned what the test just told it to return.
- Never weaken, skip, or delete a test to get to green (CLAUDE.md).

## Text and comments

- **[CI]** No `TODO` or `FIXME` without an issue number, as in `TODO(#123): ...`. No `eslint-disable`. No placeholder text (`Lorem ipsum`, `your-api-key`, `<insert ...>`).
- **[review]** Don't write comments that narrate the code ("increment i") or describe the change ("added for X"). A comment should say why, or name the constraint.
- **[review]** No speculative abstractions, options with one caller, unused exports, defensive checks for states the types already rule out, or `try/catch` that rethrows the error unchanged.
- **[review]** "How it was tested" in a PR or README must match what was actually run.

## Before you commit

```sh
bash scripts/anti-slop.sh
npm test && (cd iphone-agent && npm run typecheck && npm test)
```

Don't use `// SAFETY:` comments, casts, or renames to quiet the grep. If a rule is wrong for some code, say so in the PR and change the rule in `scripts/anti-slop.sh` and in this file.

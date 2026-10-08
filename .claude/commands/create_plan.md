---
description: Research the codebase and write a phased implementation plan to thoughts/plans/
argument-hint: <task description, issue number, or path to a ticket>
---

You are writing an implementation plan for: $ARGUMENTS

Do not write any implementation code in this command.

## 1. Research

- Read every file the task mentions, in full. Read `CLAUDE.md` and `REVIEW.md`.
- Find the code paths involved (agent loop, tools, WDA client, device view, mock, isolate). Note `file:line` for each fact you rely on.
- Check how similar things are already done (existing tools, tests, mock routes) and follow that pattern.
- If the task is an incident, reproduce it against the mock device first and record the exact repro.
- If something is ambiguous and the code can't answer it, stop and ask. Don't plan on guesses.

## 2. Write the plan

Save it as `thoughts/plans/YYYY-MM-DD-<slug>.md` (today's date, short kebab-case slug). Use this structure:

```markdown
# <Title>

## Goal
One paragraph: what changes and why. Link the issue.

## Current state
What exists today, with file:line references. Constraints (strip-types, strict tsconfig, points-not-pixels, approve gate).

## Out of scope
What we are deliberately not doing.

## Phase 1: <name>
### Changes
- `path/to/file.ts`: what changes and why.
### Success criteria
Automated:
- [ ] `cd iphone-agent && npm run typecheck && npm test`
- [ ] `npm test` (root), `bash scripts/anti-slop.sh`
- [ ] <specific new test name> passes
Manual:
- [ ] <e.g. run `npm run agent -- --mock "..."` and see ...>
- [ ] <real device step, if any, with --confirm>

## Phase 2: ...

## Risks & rollback
What could go wrong on a real device; how to revert.
```

Rules:
- Each phase should be shippable as one small PR and leave CI green.
- Every phase has at least one automated check that would fail without the change.
- New device actions must name how they go through the `approve` gate and which mock route covers them.
- No open questions in the final plan. Resolve them or ask.

Finish by printing the plan path and a 3-line summary of the phases.

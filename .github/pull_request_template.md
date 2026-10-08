## Summary

<!-- What changes and why, in 1-3 sentences. Link the issue: Closes #123 -->

## Plan / design notes

<!-- Link the plan this implements: thoughts/plans/YYYY-MM-DD-slug.md (see /create_plan).
     Note any deviation from the plan and why. Small fixes can say "no plan: one-line fix". -->

Plan:

## How it was tested

<!-- Back-pressure: what actually exercised this change? Paste commands and results. -->

- [ ] Unit tests added/updated (`npm test` at root and/or in `iphone-agent/`)
- [ ] Typecheck (`npm run typecheck` in `iphone-agent/`, root `tsc -p .`)
- [ ] Mock end-to-end: ran against `npm run mock` (describe the task / tool calls)
- [ ] Real device or Simulator: <!-- device + iOS version, or "not run" and why -->

## Risk & rollback

<!-- What could break (device actions, coordinate mapping, safety gate, API usage/cost)?
     How do we roll back: revert this PR? feature flag? anything stateful? -->

## Checklist

- [ ] CI green (root, iphone-agent, anti-slop)
- [ ] `bash scripts/anti-slop.sh` clean locally
- [ ] Docs updated (README / CLAUDE.md Learnings / REVIEW.md) if behavior or conventions changed
- [ ] Follow-up issues filed for anything deferred (and referenced in any TODO as `TODO(#123)`)

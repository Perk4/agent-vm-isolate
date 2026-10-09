---
description: Verify an implementation against its plan in thoughts/plans/ and run every success criterion
argument-hint: <path to thoughts/plans/YYYY-MM-DD-slug.md> (defaults to the most recent plan)
---

Validate the implementation of: $ARGUMENTS

If no path is given, use the most recently modified file in `thoughts/plans/`.

## 1. Load context

- Read the plan in full.
- Inspect what was implemented: `git log --oneline main..HEAD` and `git diff main...HEAD --stat`, then read the changed files.

## 2. Check each phase

For every phase in the plan:
- Compare the planned changes with the actual diff. Note anything missing, extra, or done differently.
- Run every **automated** success criterion exactly as written. At minimum:
  - `npm test` at the root, and `bash scripts/anti-slop.sh`
  - `cd iphone-agent && npm ci && npm run typecheck && npm test`
  - Mock smoke: `npm run mock &`, then `curl -sf localhost:8100/status`, `/screenshot`, `/source` return JSON with `value`. Stop the mock afterwards.
- Do not mark a criterion as passing unless you ran it and saw it pass. Paste the command and a one-line result.
- Review the diff against `REVIEW.md` blockers: unhandled WDA errors, points vs pixels, approve-gate bypass, secrets, missing tests.

## 3. Report

Write the report in chat (do not edit the plan except to tick checkboxes that you verified):

```markdown
## Validation: <plan title>

### Automated
- [x] `command` : passed (N tests)
- [ ] `command` : FAILED: <first error line>

### Deviations from plan
- ...

### REVIEW.md findings
- blocker: ...
- nit: ...

### Manual checks still needed
- [ ] <manual criterion from the plan>, with exact steps

### Verdict
Ready for PR / Needs work (list what).
```

Also suggest any new entry for the Learnings section of `CLAUDE.md` if the implementation hit a surprise.

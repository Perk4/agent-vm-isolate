---
description: Write a handoff note so a fresh session can resume mid-ticket without re-discovering anything
argument-hint: [short slug or note about why you are stopping, optional]
---

Write a handoff for the work in this session. Note from the user (may be empty): $ARGUMENTS

Cloud sessions start from a fresh clone, so anything not committed and pushed is lost. Before writing:
- Commit work in progress on the ticket branch (a `wip:` commit is fine) and push it. Never leave changes only in the container.
- Run the checks once and record their real result (`npm test`, `bash scripts/anti-slop.sh`, `cd iphone-agent && npm test`).

Save `thoughts/handoffs/YYYY-MM-DD-<issue>-<slug>.md`, under 50 lines:

```markdown
# Handoff: #<issue> <title>

## Status
Branch `claude/<issue>-<slug>` @ <short sha>, pushed. PR: <link or "not opened">. CI: <green/red/not run>.
Plan: `thoughts/plans/...` (phase N of M done) or "oneshot".

## Done
- <what is finished and verified, with the command that proved it>

## Next
1. <the very next concrete step, with file:line>
2. ...

## Gotchas
- <surprises, dead ends tried and why they failed, flaky checks, decisions the user made>

## Blocked on the user
- <plan approval, Mac-only checks with exact commands, secrets/API key> or "nothing"

## Resume prompt
Check out branch claude/<issue>-<slug>, read thoughts/handoffs/<this file> and continue issue #<issue> following CLAUDE.md and /start_ticket.
```

Rules:
- Only write "verified" for things you ran in this session and saw pass.
- Link files by path and `file:line`; don't paste large code.
- Commit the handoff on the ticket branch (same push), and post a one-line comment on the issue linking it, so the next session finds it from the issue too.

Finish by printing the resume prompt exactly, ready to paste into a new session. The handoff lives on the ticket branch, not `main`, so the prompt must name the branch.

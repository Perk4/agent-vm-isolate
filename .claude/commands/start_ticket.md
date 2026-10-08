---
description: Take a GitHub issue from read to merged-ready PR, following CLAUDE.md (plan or oneshot, mock back-pressure, CI green)
argument-hint: <issue number> [autonomous]
---

Work on issue #$ARGUMENTS in this repo. If the arguments include `autonomous`, don't pause for plan approval; otherwise pause where marked.

## 1. Read (no code yet)
- Read the issue, its comments, its parent/tracking issue and any linked PRs with the GitHub MCP tools (`issue_read` get / get_comments / get_parent, `pull_request_read`).
- Read `CLAUDE.md`, `REVIEW.md`, `iphone-agent/RESEARCH.md` if the issue touches WDA, and every file the issue names, in full. Note `file:line` for facts you rely on.
- Check `thoughts/plans/` and `thoughts/handoffs/` for earlier work on this issue. If a handoff exists, resume from it.
- **Mac-only tickets** (real iPhone, Simulator, iPhone Mirroring, e.g. #4, #9): a cloud container has no Xcode, Simulator or USB. Do the Linux-testable part only (mock fidelity, pure mapping code, unit tests). Never claim a device result you didn't observe. Stop and post an issue comment with a checklist the user runs on their Mac (exact commands, what to record), then `/handoff`.

## 2. Decide: plan or oneshot
- Oneshot if it's one file or under ~50 lines (CLAUDE.md threshold). Say so in one line and go to step 3.
- Otherwise run `/create_plan #<issue>` and save it as `thoughts/plans/YYYY-MM-DD-<issue>-<slug>.md`: at most 3 phases, each a vertical slice with automated checks that would fail without it.
- **Pause:** print the plan path, the `/show_me` view of the change, and the phase summary. Wait for the user to approve or edit the plan. Do not start implementing until they do (skip only in `autonomous` mode).

## 3. Implement
- Branch: `git checkout -b claude/<issue>-<slug>` from the latest `main` (or from the base branch the issue names).
- One phase at a time. After each phase run its automated checks and commit. Don't move on while red.
- Write the failing test first for bugs and new tools. Never edit or delete a test to make it pass.
- Test against the fake phone: the `iphone-mock` MCP server (`.mcp.json`) for tool-level checks, and `cd iphone-agent && npm run agent -- --mock "<task>"` if `ANTHROPIC_API_KEY` is set.

## 4. Verify everything CI runs
```sh
npm test && bash scripts/anti-slop.sh
npm install --no-save --no-package-lock typescript@5.9.3 @types/node@22 && npx --no-install tsc -p .
cd iphone-agent && npm ci && npm run typecheck && npm test
npm run mock &  # then curl -sf localhost:8100/status, /screenshot, /source; kill the mock
```
- If there is a plan, run `/validate_plan <plan path>` and fix every finding.
- Self-review the diff against `REVIEW.md` blockers (WDA errors, points vs pixels, approve gate, secrets, missing tests).

## 5. Open the PR
- Push the branch. Fill in `.github/pull_request_template.md`: `Closes #<issue>`, the plan path, the `/show_me` output (file-tree diff, call path, signatures), and "How it was tested" listing only what you actually ran.
- Open it as a draft if anything manual is still unchecked.
- Subscribe to PR activity (`subscribe_pr_activity`). Fix CI failures and review comments until green; reply to each thread with what changed.

## 6. Compound
- Anything that surprised you goes into `CLAUDE.md` Learnings (one or two lines) in the same PR. A mistake you could grep for becomes a rule in `scripts/anti-slop.sh` + `REVIEW.md`.
- Deferred work becomes a new issue linked from the PR, referenced as `TODO(#N)` if it's in code.
- If the session is ending before the PR is green, run `/handoff`.

Finish with: PR link, CI status, what's left for the user (manual checks, plan review), and any new issues filed.

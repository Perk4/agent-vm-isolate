---
description: When the current tickets are done, mine what happened and propose the next batch of one-PR tickets for approval
argument-hint: [focus or goal for the next batch, optional]
---

Plan the next batch of work. Focus from the user (may be empty): $ARGUMENTS

Do not write code and do not create issues until the user approves step 4.

## 1. Gather state
- Issues: open and closed (GitHub MCP `list_issues`), the latest tracking issue and its sub-issues, and every `incident` issue.
- PRs merged since the last roadmap note (newest file in `thoughts/roadmap/`, or all if none). For each: what shipped, what was deferred.
- CI history: recent failed runs (`actions_list`) and what failed. Repeated failures are findings.
- Repo memory: `CLAUDE.md` Learnings, `REVIEW.md`, `thoughts/plans/`, `thoughts/handoffs/` (unfinished work), `iphone-agent/README.md` "Where to go next", `TODO(#N)` in code.
- Run the checks once (`npm test`, `bash scripts/anti-slop.sh`, `cd iphone-agent && npm ci && npm test`) so the plan starts from a known-green or known-red state.

## 2. Mine the review threads
- Read review comments on the merged PRs. Group repeated findings (same mistake twice or more).
- For each group propose one rule: a grep check for `scripts/anti-slop.sh`, a `REVIEW.md` blocker, or a `CLAUDE.md` Learnings line. Say which, and why a grep can or can't catch it.

## 3. Propose 3-7 tickets
Rank by: unblocks other work > fixes incidents/flakiness > user-visible capability > polish. Each ticket must be:
- one PR in size (under ~3 plan phases), with a type (Feature / Task / Bug);
- concrete acceptance criteria, each checkable;
- a back-pressure plan: which test, mock WDA route or CI check fails before the change and passes after;
- tagged with the files it touches, so parallel sessions can be scheduled;
- marked **Mac-only** if it needs a real device, Simulator or macOS.

## 4. Show it and wait
Print a `/show_me`-style view and stop for approval:

| # | title | type | why now | touches | parallel-safe with | Mac-only | acceptance (short) |
|---|---|---|---|---|---|---|---|

Then: proposed rules from step 2, a suggested order with which tickets can run in parallel sessions, and anything you'd deliberately not do yet.

## 5. After approval only
- Create a tracking issue ("<theme>: next batch") and each ticket as a sub-issue (`issue_write`, `sub_issue_write`), using the feature/incident template fields and the issue types the repo has (`list_issue_types`). Search first to avoid duplicates.
- Close or relabel anything stale you found, with a comment saying why.
- Write `thoughts/roadmap/YYYY-MM-DD.md` (under 40 lines): state at time of planning, the batch with issue links, the order and parallel groups, proposed rules, and what was deferred and why. Commit it on a branch and open a small PR (rule changes can ride along if trivial).

Finish with the tracking issue link and the kickoff prompt per ticket: `/start_ticket <N>`.

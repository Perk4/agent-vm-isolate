# Review guidelines

Applied by Claude Code Review and by human reviewers. Review the diff against these rules, in this order. Lead with blockers; label everything else as a nit. Don't restate what CI already enforces (tests, typecheck, anti-slop) unless CI missed it.

## Blocks merge

**Correctness**
- The change doesn't do what the PR summary or linked plan says, or breaks an existing behavior without saying so.
- Logic errors, off-by-one bugs, unhandled `undefined` from indexed access (we compile with `noUncheckedIndexedAccess`; a `!` or `as` cast to silence it needs a reason).
- Race conditions in the agent loop: a tool result returned before the device action actually finished, or a missing `await`.

**Unhandled WDA errors**
- Every WDA call can fail with a non-2xx status, a non-JSON body, an `{ value: { error, message } }` payload, or a dead session. New code must surface these as a typed error or a `tool_result` with `is_error: true`. It must not throw out of the loop or silently return a default.
- No retry loop without a bound. A stale session must re-create the session or fail loudly, not spin.

**Coordinate space (points vs pixels)**
- WDA tap/swipe coordinates are **points**. Raw screenshots are **pixels** (usually 3x). Anything the model sees and anything we send to WDA must be in points.
- Block any new path that hands the model a full-resolution screenshot, multiplies or divides by a scale factor in more than one place, or mixes `describe_ui` centers with pixel math.
- New geometry code needs a test with a non-1x scale.

**Safety gate bypass for device actions**
- Every tool that changes device state (tap, swipe, type, press button, launch app, and anything new) must be listed in `ACTIONS` in `iphone-agent/src/agent.ts`, so it goes through `approve` before reaching WDA. A new action tool that skips the gate is a blocker even if the prompt tells the model to be careful.
- Don't weaken the step cap, `--confirm`, or the system-prompt stop rules (passwords, purchases, sending messages, security settings) without an explicit design note in the PR.

**Secrets**
- No API keys, tokens, device UDIDs, signing identities, or personal data in code, fixtures, logs, or test snapshots. Keys come from the environment (`ANTHROPIC_API_KEY`).
- Logs and transcripts must not echo typed text from sensitive fields.

**Tests missing**
- A new agent tool needs: a mock WDA route (if it calls a new endpoint), a unit test of `execute()` for success and error, and coverage in the mock end-to-end path.
- A bug fix needs a regression test that fails without the fix.
- New root `isolate` behavior needs a test in `src/isolate.test.ts`.

**Build hygiene**
- New runtime dependencies without a stated reason (we stay zero-dep where we can). Lockfile changes that don't match `package.json`.
- Syntax that `node --experimental-strip-types` can't run: constructor parameter properties, `enum`, `namespace`, decorators that need emit.

## Nits (comment, don't block)

- Naming, comment wording, small refactors that don't change behavior.
- Log message phrasing; ordering of imports or object keys.
- A slightly broader type than necessary, when it's still sound.
- Docs that could be clearer. Missing docs for a **behavior change** is not a nit: see the PR checklist.

Prefix these with `nit:` so authors (and agents) can triage.

## Anti-slop list

`scripts/anti-slop.sh` enforces these in non-test `.ts` under `src/` and `iphone-agent/src/`. Reviewers also flag the ones a grep can't catch.

| Pattern | Why | Instead |
| --- | --- | --- |
| `: any`, `as any`, `<any>` | Turns off the type checker | `unknown` and narrow |
| `@ts-ignore`, `@ts-nocheck` | Hides real errors | Fix the type; `@ts-expect-error` with a reason if truly needed |
| `console.log(` outside `iphone-agent/src/cli.ts` and `mock-wda.ts` | Library code shouldn't print | Return data; CLIs print |
| `TODO` / `FIXME` without `#123` | Untracked work rots | File an issue, write `TODO(#123): ...` |
| Empty `catch {}` / `catch (e) {}` | Swallows failures | Handle it, or leave a comment saying why it is safe to ignore |
| `eslint-disable` | Suppression without review | Fix the code |
| `.only(` / `{ only: true }` in tests | Silently skips the rest of the suite | Remove before pushing |
| `Lorem ipsum`, `your-api-key`, `<insert ...>` | Placeholder shipped as real | Real values or config |

Not greppable, still slop:
- Comments that narrate the code ("// increment i") or describe the change ("// added for new feature").
- Defensive checks for states the types already rule out; `try/catch` that rethrows unchanged.
- Speculative abstractions and options with one caller; unused exports.
- Tests that assert the mock returned what the test just told it to return.
- README or PR text that claims testing that didn't happen. "How it was tested" must match what CI or the author actually ran.

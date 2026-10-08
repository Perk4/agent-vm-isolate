---
description: Show a change visually before (or after) building it, instead of prose
---

Show me $ARGUMENTS. Do not explain in paragraphs. Answer with only the views that apply:

1. **File-tree diff**: the files added (+), changed (~) or removed (-), each with a one-line purpose.
2. **Call path**: the runtime path the change touches, e.g. `cli.ts main → runAgent → execute → IPhone.tap → WdaClient.sc → POST /session/:id/wda/tap`.
3. **Type signatures**: new or changed exported types and functions, as TypeScript declarations.
4. **Sequence**: a short mermaid `sequenceDiagram` when more than two components talk to each other (model ↔ harness ↔ WDA ↔ phone).
5. **Test plan**: which tests prove it, and what each one asserts against the mock WDA.

Read the code first and cite `file:line`. If something is unknown, list it under **Open questions**. Don't guess.

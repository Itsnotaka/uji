# June — agent instructions

June is a client/server coding-agent platform: a core (protocol + agent loop + durable
harness/session) with peer clients (CLI, desktop, web). `blueprint.md` is the design
document of record. Pi (`earendil-works/pi`, primarily `@earendil-works/pi-agent-core`)
is the upstream reference — see "Porting basis" in blueprint.md; ported files carry a
`Based on <link>` credit to their pi source.

## Core design test: loop-needed, not client-needed

When deciding whether a feature belongs in core, do not ask "can a client render or
consume this yet?" Ask: **does the agent loop or the conversation need it?**

- The conversation is chat. Any modality that can legitimately appear in a conversation
  (text, images, …) must be carriable by the wire and the loop — that is a core
  primitive. If core's wire cannot carry it, no extension can add it; hosts would be
  forced into side channels, which violates the one-session-model rule.
- Heavy or policy-laden work on a modality (image resize/convert, native deps) is
  host/extension territory — injectable, like pi's `imageProcessor`.
- Presentation is the client's requirement. A client that cannot render a modality
  ignores it.
- We provide `sdk.*` primitives for users to build on. Providing does not mean every
  consumer must use it.

Worked example (decided and implemented 2026-08-14): image support in `read`.
- Detection (magic bytes, `tools/support/image.ts`) — core.
- Tool results are strictly parts (`AgentToolResult.content: ToolResultPart[]`, pi's
  contract — no `string | parts` union to parse). Sessions store the parts verbatim
  (`function_call_output.output: ToolResultPart[]`); the provider adapter in
  `@june/ai` encodes them into its API's shape at request time — adapters encode,
  sessions do not. `toolResultText` flattens for text-only display.
- Resizing/conversion — injectable `ImageProcessor` (`read`'s option, and
  `normalizeToolResultImages` for images from any other tool), never core.
- Rendering — client.

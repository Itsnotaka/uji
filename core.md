# June core: design and implementation record

Status: document of record for `@june/core`, the `@june/schema` wire it stores, and the `@june/ai` boundary it streams through. `blueprint.md` remains the brainstorm and decision journal; when the two disagree on a contract, this document wins and blueprint gets a correction entry. This file is living and appendable. Add sections; do not rewrite history silently.

Register: **must** and **must not** are normative. "Landed" marks facts verified in the working tree on 2026-08-18. File and line references are to that snapshot and may drift; the contract statements do not.

Upstream reference: pi (`earendil-works/pi`), primarily `@earendil-works/pi-agent-core` 0.84.2 and the AgentHarness implementation specification (`packages/agent/docs/harness.md`, "the pi spec" below). Ported files carry a `Based on <link>` credit header.

Demos (`packages/demo/*`) are frozen. They are consumers, not drivers. No core contract may change to satisfy a demo, and demo breakage does not block core work.

---

# Part 0: Orientation

## 0.1 What June core is

`@june/core` is a durable runtime for agent conversations, built as composable blocks: a standalone agent loop, a harness that composes durability over it, a session storage contract with a SQLite backend, and a coding tool set. Clients never import it; they speak `@june/schema` and (later) `@june/protocol`. The core is opinionated the way VSCode is: a small set of load-bearing extension seams with exactly one obvious way to use each, not a plugin socket on every wall.

Three ideas organize everything below:

1. **The agent loop is a solved problem.** pi solved it. June ports it and tracks upstream. Part 1 states the adoption policy.
2. **The harness and the wire are where June thinks for itself.** The session model (Part 3) and the wire schema (Part 2) are owned designs with owned rationale.
3. **A seam earns its keep with two real implementations or one named concrete consumer.** Part 4 applies this test to every injection point and kills the ones that fail it.

## 0.2 System model

### A session is a tree plus a ledger

A session is four things, ordered by one per-session `seq` counter (`harness/session/types.ts:243`):

- **Entry tree.** Write-once entries (`Entry`, `types.ts:125`): messages, model changes, thinking-level changes, custom entries. Each entry names its parent; branches share prefixes. An entry is never mutated or deleted.
- **Records ledger.** Append-only orchestration records (`LaneRecord`, `types.ts:202`): `operation_started`, `operation_finished`, `step_attempt`, `tool_started`, `queue_enqueued`, `queue_cancelled`, `abort_requested`, `usage`. Records are the durable memory of what the harness was doing; entries are the durable memory of what was said.
- **Lane pointers.** Named mutable cursors into the tree. Every session has `main`; today `main` is the only lane (`agent-harness.ts:41`). A lane owns its leaf and at most one open operation.
- **Facts.** Mutable named values (today: the session name).

Entries and records are write-once. Lane pointers and facts are the only mutable state. One `seq` orders all four, which is what makes `getLog({afterSeq})` a coherent replay cursor for any client.

### The loop is a pure function over context

`runAgentLoop` (`agent-loop.ts:99`) takes messages, tools, a config of hooks, an event sink, a signal, and a `StreamFn`. It owns turn sequencing, tool batch execution (sequential or parallel), steering and follow-up drains, and the length-stop rule (a turn cut off by the token limit fails its whole tool batch rather than executing possibly truncated arguments, `agent-loop.ts:219`). It imports nothing from the harness, sessions, or providers. That is the locked one-way rule from blueprint (Decision 2026-08-12): harness → loop, never loop → harness.

### A tool result is parts, always

`AgentToolResult.content` is `ToolResultPart[]` (`@june/schema`), a discriminated union of text and image parts. There is no `string | parts` union to sniff. Sessions store parts verbatim in `function_call_output.output`; the provider adapter in `@june/ai` encodes them into its API's shape at request time. Adapters encode; sessions never store pre-encoded provider payloads. `toolResultText` flattens to text for display.

### An operation is an effect sandwich

Every uncertain effect is bracketed by durable commits. A run commits `operation_started` before the loop turns, `step_attempt` before each provider request, and a `tool_started` intent (carrying a provisioned `resultEntryId` and a `replay: "never" | "safe"` policy) before each tool executes (`agent-harness.ts:467`). The settlement is the `function_call_output` entry appended at that provisioned id. After a crash, an intent whose settlement entry does not exist is exactly the set of effects whose outcome is unknown. `resume()` settles them by policy: `safe` tools re-execute; `never` tools get a synthetic error entry telling the model to re-issue the call (`agent-harness.ts:261`). Nothing that settled ever replays.

## 0.3 The core design test

From `CLAUDE.md`, restated because every scoping argument comes back to it. Do not ask "can a client render this yet?" Ask: **does the agent loop or the conversation need it?**

- Any modality that can legitimately appear in a conversation must be carriable by the wire and the loop. If the wire cannot carry it, no extension can add it.
- Heavy or policy-laden work on a modality (image resizing, native deps) is injectable, never a core dependency.
- Presentation is the client's problem. A client that cannot render a modality ignores it.

Worked precedent (2026-08-14): image support in `read`. Detection by magic bytes is core (`tools/support/image.ts`). Resizing is an injectable `ImageProcessor` (`tools/read.ts:41`). Rendering is the client's.

## 0.4 Non-goals

- **Exactly-once external effects.** The sandwich gives at-most-once for `never` tools and at-least-once for `safe` tools. Nothing stronger.
- **Multiple writers per session.** One process owns a session; the SQLite lease enforces it (Part 3). Lanes are the answer to workloads that look multi-writer.
- **Provider stream resumption.** A partial stream is process-local. Only settled turns persist.
- **Rebuilding pi.** Where pi has already answered a loop question, June adopts the answer (Part 1).
- **Product chrome in core.** Approval cards, permission modals, plan mode, MCP marketplaces: composition or client territory, per blueprint's core-vs-UI litmus.

---

# Part 1: The agent loop is a solved problem

## 1.1 Adoption, not invention

June's loop, tools, and harness skeleton are ports of pi, and that is the policy, not an embarrassment. pi's loop encodes years of fixes June must not rediscover: the length-stop batch failure, ordered delta emission under async sinks, blocked-tool termination, parallel batches that preserve result order, abort checks between every phase. The blueprint's "handwritten" rule means June owns the code in this repo and composes its own product; it does not mean rewriting solved logic for the sake of authorship.

**Corollary, from the user's directive (2026-08-18): invented "normalizing functions" with no pi counterpart are wasted energy and must stop.** Where June found itself writing shape-sniffing helpers pi does not need (`isAssistantMessage`, the guards in `getToolCalls`), the correct response is not a better helper; it is fixing the type that made the helper necessary (Part 2). A helper that exists to compensate for a too-loose type is a symptom, and symptoms do not get polished.

## 1.2 Which files track upstream

Every ported file must carry a `Based on <url>` header naming its pi source. A file that materially tracks upstream should also carry a `Synced with pi <commit or version>` line; today only `agent-loop.ts:6` does (commit `b1efcf7`), and the others must gain one at their next reconciliation.

| June file | pi source (0.84.2) | class |
|---|---|---|
| `src/agent-loop.ts` | `src/agent-loop.ts` | tracked port |
| `src/types.ts` | `src/types.ts` | tracked port, wire-substituted |
| `src/utils/event-stream.ts` | pi `EventStream` (pi-ai) | tracked port |
| `src/harness/agent-harness.ts` | `src/harness/agent-harness.ts` + the pi spec | tracked port, scoped |
| `src/harness/result.ts` | `src/harness/result.ts` | tracked port |
| `src/harness/session/types.ts` | the pi spec (ported before upstream code existed) | tracked port of the spec |
| `src/harness/session/sqlite.ts` | `packages/session-backends/sqlite-node` + spec Part 1 | owned divergence (Part 3) |
| `src/tools/read,bash,edit,edit-diff,write` | `src/harness/tools/*` | tracked ports |
| `src/tools/grep,find,ls` | pi-coding-agent `core/tools/*` | tracked ports (agent-core 0.84.2 still has no grep/find/ls; coding-agent remains the sanctioned fallback source) |
| `src/tools/support/*` | pi tool support modules | tracked ports |

June-original files, kept deliberately small:

- `src/responses-wire.ts` (37 lines). The loop's wire boundary. Exists only because of the open-struct wire type; Part 2 shrinks it.
- `src/stream-fn.ts` (63 lines). Binds `@june/ai`'s streamed Responses client to the loop's `StreamFn` contract. Its one genuine job is the never-throw guarantee (failures become `stopReason: "error" | "aborted"`, never rejections).
- `src/utils/tool-result.ts` (13 lines). `toolResultContent` / `toolResultText` part helpers.

## 1.3 What "synced with pi \<version\>" means

A sync line asserts: this file was diffed against that upstream point, upstream changes were adopted or explicitly declined, and the only remaining differences fall in the allowed classes of §1.4. Re-syncing is a diff against the published upstream at a named version, not a vibe check. The recovered 0.84.2 sources (from npm source maps) are legitimate diff material when upstream git is unreachable.

## 1.4 What June may change in a ported file

As little as possible. The verified normalized diff of `agent-loop.ts` against pi 0.84.2 shows exactly the allowed classes, and nothing else may join them:

1. **Wire substitution.** pi's `AssistantMessage`/`Message` become June's `ResponseItem`/`AssistantTurn`; the conversion helpers live in `responses-wire.ts`, not inline. Mechanical, boundary-contained.
2. **No process-global StreamFn registry.** pi 0.84.2 has `setDefaultStreamFn`/`getDefaultStreamFn` (module-global mutable state); June deleted it and every composition passes its `StreamFn` explicitly. This is a deliberate, permanent divergence: an implicit global default is exactly the hidden state the blocks posture forbids.
3. **Rejection containment.** June's `agentLoop`/`agentLoopContinue` route loop rejections into `stream.fail(...)` where pi only handles resolution. Keeps the never-throw discipline airtight at one more boundary. Divergence noted, kept.

Everything else in a ported file must match upstream modulo formatting. New behavior goes in composition files (harness, stream-fn, tools options), never spliced into a ported file. If upstream later fixes something June also fixed, the re-sync adopts upstream's version.

---

# Part 2: The wire (`@june/schema`)

## 2.1 The root cause

`ResponseItem` (`packages/schema/src/index.ts`) is one open struct: every field optional, plus an index signature. The type cannot say "a function_call always has `call_id`, `name`, `arguments`", so every consumer re-proves it at runtime:

- `responses-wire.ts:9` answers "is this assistant output?" by sniffing `type === "message" || "reasoning" || "function_call"`.
- `responses-wire.ts:24` filters on `call_id === undefined` and papers over the type with `?? ""` and `?? "{}"` defaults.
- `agent-harness.ts:322` re-sniffs `lastMessage.role === "user" || lastMessage.type === "function_call_output"` to decide resumability.
- The grok-bot renderer carries a TODO begging for discriminated parts (`conversation.tsx:242`).

pi does not have this problem because pi does not hand-roll wire types at all: pi-ai leans on the official provider SDK types and hand-rolls only its own provider-neutral domain model, which is a proper discriminated union. June chose wire-shaped storage (Responses items as the v0 session wire); that choice is fine, but it obliges June to type the wire it stores.

## 2.2 The specification

`ResponseItem` must become a discriminated union on `type`. Target shape:

```ts
export type ResponseItem =
  | { type: "message"; role: "user" | "system" | "developer" | "assistant";
      content: string | ContentPart[] }
  | { type: "reasoning"; content?: ContentPart[]; summary?: ContentPart[];
      encrypted_content?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: ToolResultPart[] };
```

Rules:

1. **Every stored item carries `type`.** Bare `{role, content}` user input is normalized to `type: "message"` by one parse function at the boundary where untyped data enters (harness `normalize`, provider response decoding). Internal code never sees an untyped item.
2. **The index signature dies.** Unknown provider fields do not ride along in session storage. A provider field June must round-trip gets a named optional field on its variant (as `encrypted_content` already does). If a provider needs more, the union grows a field, visibly, in one file.
3. **`function_call_output.output` is `ToolResultPart[]`, not `string | ToolResultPart[]`.** The parse function converts legacy bare strings to a single text part on read. Adapters encode parts at request time; nothing stores an encoded string.
4. **Exhaustive matching is mandatory.** Consumers switch on `type` with a `never` default. A new variant becomes a compile error at every consumer, which is the point.

## 2.3 What dies as a result

- `isAssistantMessage`'s type-sniff body. Assistant authorship becomes a one-line check over the union (`reasoning`, `function_call`, or `message` with `role: "assistant"`).
- The `call_id === undefined` filter and both `??` defaults in `getToolCalls`. A `function_call` item proves its own fields.
- The `agent-harness.ts:322` shape re-sniff, which becomes a typed match.
- The grok-bot TODO, and every future client's private re-derivation of the same facts.
- Most of `responses-wire.ts`. What remains is honest conversion (`toToolDefinition`, argument decoding), not compensation.

`@june/ai`'s `encodeToolResultOutput`/`encodeInputItem` (`api/responses.ts`) are not in this kill list. They are the adapter doing its stated job, encoding stored parts into a specific API's shape at request time. The ban is on normalizers that compensate for June's own types, not on adapters that translate at a real boundary.

## 2.4 Type ownership (landed)

`@june/schema` now owns the scalar vocabulary shared by core and ai: `ThinkingLevel`, `StopReason`, `StreamDelta`, `TurnUsage`, `ToolResultPart` and friends. `core/src/types.ts` and `@june/ai` import them (`types.ts:9`, `ai/src/api/responses.ts:1`, `ai/src/provider.ts:1`); `ReasoningEffort` is derived as `Exclude<ThinkingLevel, "off">` rather than restated. The previous state (four structurally identical type families defined twice, reconciled by hand in `stream-fn.ts`) is the canonical example of what duplicate vocabulary costs, and must not recur: **a shared shape is defined once, in schema, and derived elsewhere.**

---

# Part 3: The harness and session model

## 3.1 What is pi's and what is June's

The durability *model* is pi's spec, adopted whole: write-once entries and records over mutable lane pointers, one `seq`, the effect sandwich, replay policy, crash resume from the durable branch. June ported it from the spec before upstream had shipped harness code, and June tracks the spec as the contract. Where the spec and shipped pi code disagree, the spec wins.

One such disagreement exists today and matters. The current pi spec (Part 0 §0.3, Part 3) has moved to a **total operation-state register** model: recovery reads one `op.state/{operationId}` register holding the complete program counter and switches on it, and the terminal transaction deletes the operation's registers. Shipped pi 0.84.2 code, and June's port, still use the earlier **append-only records ledger** model, where recovery infers position from which records lack settlements. Both implement the same sandwich; the register model has strictly better recovery properties (point lookups, no history folding, no dead state accumulating in finished sessions). Position: June's records ledger is the current, correct realization of the spec's earlier revision; migrating to total `op.state` registers is a named future schema-evolution step, taken when June next reconciles the harness against upstream's landed implementation, not improvised piecemeal. Open question 1 records it.

## 3.2 The run lifecycle (as built)

`AgentHarness` (`harness/agent-harness.ts`) is the only composition over the loop. One lane, run operations only.

- **Accept.** `prompt()` drains the `nextRun` queue, commits `operation_started` carrying the original prompt and the provisioned initial message entries, then appends those entries (`agent-harness.ts:187`). A second `prompt` while a run is active gets `LaneBusy`; the queues are the correct path (`steer`, `followUp`, `nextRun`).
- **Drive.** The harness drives `runAgentLoopContinue` through the loop's hook surface, never a fork of the loop: `turn_start` commits `step_attempt`, `beforeToolCall` commits the `tool_started` intent, `message_end` appends the entry at its provisioned id, usage events append `usage` records (`agent-harness.ts:453`).
- **Queues are records.** `steer`/`followUp`/`nextRun` commit `queue_enqueued` with a provisioned target entry; a queue item is consumed exactly when its target entry exists, cancelled exactly when a `queue_cancelled` record names it (`agent-harness.ts:366`). Queued input therefore survives crashes.
- **Finish.** Every outcome path, including harness-internal throw, commits `operation_finished` (`agent-harness.ts:564`). Errors are result-typed (`Result`, `TaggedError`: `LaneBusy`, `NoActiveRun`, `NothingToResume`, `Closed`), never thrown across the public surface.
- **Resume.** `create()` reports operations left open by a crash; `resume()` re-appends missing intent-declared entries, settles unsettled tool intents by replay policy, then either continues the loop (durable branch ends in user input or tool output) or closes the operation as completed (`agent-harness.ts:261`).

Deferred scope, recorded so nobody mistakes absence for a decision: additional lanes, compaction, branch navigation and forks, skills and prompt templates, deferred tool settlement and wake (the cross-agent gap in blueprint), manual action stepping. All compose onto the same log without schema changes; that was the point of adopting the model whole.

## 3.3 Owned divergences in the SQLite backend

`harness/session/sqlite.ts` diverges from the pi spec in three deliberate ways. These are June decisions with rationale, not drift.

1. **One database file holds every session**, keyed by `session_id`, where the spec's S2 slice prescribes one file per session. Rationale: June's first product surface wants cross-session listing and cross-session search as cheap queries, and a desktop host managing thousands of per-session files earns nothing for the added lifecycle code. Cost accepted: a corrupt database risks every session, and per-session `VACUUM INTO` forks are harder. Revisit if either cost materializes.
2. **The writer lease is fenced and heartbeat-renewed** (`sqlite.ts:38`, comment block). The spec requires a fenced lease; June's implementation adds transactional renewal on every write plus an idle heartbeat, keyed on `(owner, fence)`, so a stale owner can neither write past its successor nor release the successor's lease, and an expired lease genuinely means a dead owner. WAL would happily interleave writers from several processes; the lease is what makes one-writer-per-session an enforced property rather than a convention.
3. **FTS5 search is built into the backend** rather than the spec's standalone `SessionSearchService` with durable cursors. The single-file decision makes one FTS index across sessions nearly free (external-content index over `entries`). When June grows a second backend, search must be re-cut along the spec's service boundary; until then a service abstraction would have a population of one (Part 4 rule).

Two implementation notes that are load-bearing and must survive any rewrite: every writing transaction opens `BEGIN IMMEDIATE` (a deferred read-then-upgrade can hold a stale snapshot that `busy_timeout` cannot refresh), and payloads are stored as JSON blobs while queried columns (`type`, `lane`, `run_id`, `seq`) are denormalized for indexes.

## 3.4 Session contract invariants

The comment at `session/types.ts:238` is normative and repeated here: entries and records are write-once; lane pointers and facts are the only mutable state; one `seq` per session orders all four kinds. A backend must not give each table its own counter; doing so breaks `getLog` and every `afterSeq` cursor. `findOpenOperations` returns newest first, and more than one open operation on a lane is corruption, not a case to handle gracefully.

`toJsonValue` (`types.ts:27`) guards the durable boundary: a value is committed only if live execution and JSON replay are equivalent (finite numbers, no `-0`, plain objects and arrays, no shared or circular references, no getters). This is the parse-at-the-boundary discipline pointed inward, and tool arguments cross it before they are ever durable (`agent-harness.ts:478`).

---

# Part 4: Extension seams

## 4.1 The rule

**An abstraction earns its keep with at least two real implementations or one named concrete consumer.** "Someone might want to intercept this" is not a consumer. A seam that fails the test is deleted, and the direct call inlined, until a real second implementation shows up. This is the VSCode posture: few seams, each load-bearing, each with an obvious default.

## 4.2 Load-bearing seams (keep)

| Seam | Contract | Why it passes |
|---|---|---|
| `StreamFn` | `(LlmContext, StreamFnOptions) => Promise<AssistantTurn>`; must never throw; failures are `stopReason` values (`types.ts:54`) | The provider boundary itself. Two real implementations exist today (`createProviderStreamFn` over `@june/ai`, test doubles in `agent-loop.test.ts`), and it is the loop's independence from providers made concrete. Always passed explicitly; no default registry (§1.4). |
| `SessionStorage` / `SessionRepo` / `SessionSearch` | `session/types.ts:243` | The storage boundary. SQLite ships; the pi spec names Memory and JSONL siblings, blueprint names Durable Objects; the conformance-suite pattern from the spec is the planned second consumer. |
| `ImageProcessor` | `read.ts:41`; async, receives bytes and mime, returns possibly converted bytes | The injectable-heavy-modality precedent from §0.3. Named consumers: hosts with sharp/native codecs; core stays dependency-free. |
| Tool factories | `createAllTools(cwd, options)` plus per-tool `create*Tool` (`tools/index.ts`) | The composition surface for hosts choosing tool sets. Pruned to the factories with actual callers (landed; the speculative `createTool`/`createCodingTools`/`createReadOnlyTools`/`allToolNames` are gone). |
| `HarnessListener` / `AgentEvent` | `subscribe()` on the harness; the loop's event vocabulary (`types.ts:196`) | The client rendering surface. Every UI attaches here; the protocol layer will fan it out. |
| `HarnessTool.replay` | `"never" \| "safe"` per tool (`agent-harness.ts:77`) | Small, but it is the entire crash-recovery policy surface for tools. |

## 4.3 The effects boundary (direction), and what it kills

The four per-tool seams `BashOperations` (`tools/bash.ts:84`), `GrepOperations` (`tools/grep.ts:77`), `FindOperations` (`tools/find.ts:70`), and `LsOperations` (`tools/ls.ts:37`) each have exactly one implementation and no named second consumer. Four bespoke interfaces are the wrong shape for the real requirement, which blueprint already names: **tool host placement**. The thing a host actually swaps is "where filesystem and shell effects execute" (this machine, a VM, a container), and pi 0.84.2 models it as one interface:

```ts
// pi-agent-core 0.84.2, harness/types.ts:315
export interface ExecutionEnv extends FileSystem, Shell {}
// harness/tools/tool-context.ts
export interface ExecutionToolContext { env: ExecutionEnv }
```

Specification: June adopts an `ExecutionEnv`-shaped effects boundary. One interface in core covering the file and shell operations the built-in tools need; tools receive it as context; `createAllTools` wires the local Node implementation by default. The four `*Operations` interfaces are then deleted, per the migrate-callers-then-delete rule, in one wave. The remote tool host (blueprint's local-vs-cloud placement table) is the named second implementation this seam is built for; until it lands, the local implementation plus the pi contract keep the seam honest.

Interim status: `bash.ts`'s header already documents `BashOperations` as a stand-in for `env.executeShell`. That stand-in must not gain siblings or features; it dies with the wave.

## 4.4 Seams that stay closed

- No hook to replace the loop's turn sequencing. Compose around the loop or fork the project.
- No pluggable id scheme, seq scheme, or entry base shape. The storage contract is the contract.
- No logger injection (`blueprint` observability decision): the event stream is the product log; process diagnostics get a telemetry context later, OTel-shaped.
- No second session model, ever (the prior-host cautionary tale in blueprint). One harness instance owns a session.

---

# Part 5: Invariants

Storage and session:

1. Entries and records are write-once. Writing under an existing id is corruption.
2. One `seq` per session orders entries, records, lane moves, and facts. Backends must not shard counters.
3. Lane pointers and facts are the only mutable state.
4. An entry's parent chain never changes; a lane's leaf moves only by append (navigation later).
5. At most one operation is open per lane. `findOpenOperations` returning two is corruption, not load.
6. A value crosses into durable storage only through `toJsonValue` equivalence checking.

Effect sandwich:

7. The `tool_started` intent, with its provisioned `resultEntryId` and replay policy, must commit before the tool executes.
8. A settlement entry is written exactly once, at its provisioned id. Recovery must not mint a new id for a settled or synthetic result.
9. Recovery never re-executes a settled effect. Unsettled `safe` intents re-execute with persisted arguments; unsettled `never` intents settle as synthetic errors that instruct the model to re-issue.
10. Every accepted operation eventually commits `operation_finished`, including on harness-internal failure.

Loop and boundaries:

11. The loop must not import harness, session, provider, or Node-host modules. The harness reaches the loop only through its public hook surface.
12. A `StreamFn` must not throw or reject; all failure is in-band `stopReason`.
13. A turn with `stopReason: "length"` fails its entire tool batch; no possibly-truncated call executes.
14. Tool results are `ToolResultPart[]` end to end; adapters encode at request time; sessions store parts verbatim.
15. Queue items are durable records; consumption is the existence of the target entry, cancellation is a `queue_cancelled` record. In-memory queue state is never authoritative.
16. Public harness surfaces return `Result`; tagged errors (`LaneBusy`, `NoActiveRun`, `NothingToResume`, `Closed`) are values, not throws.

Policy:

17. Ported files change only within §1.4's three classes. New behavior composes; it does not splice.
18. Shared type vocabulary is defined once in `@june/schema` and derived elsewhere.
19. Every seam in Part 4 keeps its two-implementations-or-named-consumer justification current; a seam that loses it gets deleted, not grandfathered.

---

# Part 6: Build order

Sequenced so each slice ends in a check, and subtraction precedes construction. Slices 1 and 2 are the cleanup work order (Part 7 is the itemized ledger); nothing new builds on the old base.

| # | Slice | Implement | Acceptance |
|---|---|---|---|
| 1 | **Subtract** | Finish the cleanup ledger's open deletions: react out of `@june/ai`'s runtime deps, remaining dead exports. | `pnpm check` clean; ledger's open rows closed or re-justified. |
| 2 | **Wire union** | The Part 2 `ResponseItem` union in `@june/schema`, the boundary parse function, migration of every consumer (`responses-wire.ts` shrinks, `agent-harness.ts:322` sniff becomes a typed match, adapters unchanged in role). | Compile-time exhaustiveness at every `type` switch; loop conformance tests green; a legacy bare-string `output` parses to parts. |
| 3 | **Effects boundary** | `ExecutionEnv` in core, local Node implementation, tools take context, delete all four `*Operations` seams in the same wave. | Tool behavior tests (slice 4 can land first if sequencing demands); no `*Operations` symbol remains. |
| 4 | **Tool test debt** | Focused tests for bash, edit, edit-diff (527 lines of fuzzy matching with zero tests), grep, find, read, write, truncate (278 lines of byte math), and the support modules. Port pi's cases where they exist. | Every tool file has behavior tests; edit-diff and truncate get edge-case suites. |
| 5 | **Session conformance suite** | Backend-agnostic conformance tests in the spirit of the pi spec's testing slice, run against SQLite; Memory backend as the second implementation that keeps the contract honest. | Both backends pass one suite; the suite covers crash positions from §3.2. |
| 6 | **Reconcile with upstream harness** | Diff harness, session types, and tools against pi's landed implementation at a named version; decide the records-ledger → `op.state` register migration (open question 1) as a schema-evolution step with a migration, or a recorded decline. | Sync lines updated on every tracked file; decision recorded here. |
| 7 | **Lanes, then the deferred list** | Additional lanes first (the model already carries `lane` everywhere), then compaction, forks, skills, deferred settlement and wake, in blueprint's cross-agent-invariants order. | Each lands with its crash drills, per the effect-sandwich invariants. |

---

# Part 7: Cleanup ledger

Snapshot 2026-08-18. "Landed" rows were verified in the working tree this session; they are recorded so the ledger doubles as the audit trail. Line references are to the snapshot.

## Landed

| Item | Where | Disposition |
|---|---|---|
| Dead module `tool-result-images.ts` (88 lines, `normalizeToolResultImages` had zero call sites) | `core/src/tools/support/` | Deleted; export removed from `tools/index.ts`; `read.ts` now owns its `ReadImageProcessor` types (`read.ts:36`) |
| Dead path helpers `formatPathRelativeToCwdOrAbsolute`, `getCwdRelativePath`, `expandPath`, sync `resolveReadPath` (line-for-line duplicate of the async version) | `tools/support/path-utils.ts` | Deleted; `resolveReadPathAsync` remains (`path-utils.ts:119`) |
| Speculative factories `createTool`, `createCodingTools`, `createReadOnlyTools`, `allToolNames` (zero consumers) | `tools/index.ts` | Deleted; `createAllTools` is the surface |
| No-op stubs `trackDetachedChildPid` / `untrackDetachedChildPid` | `tools/support/shell.ts` | Deleted |
| Duplicate type families: `StreamDelta`≡`ResponsesDelta`, `TurnUsage`≡ inline usage, `ThinkingLevel`≡`ReasoningEffort`+"off", `StopReason`⊃`"stop"\|"length"` defined in both core and ai | `core/src/types.ts` vs `ai/src/{api/responses,provider}.ts` | Merged into `@june/schema`; core and ai derive (`core/types.ts:9`, `ai/provider.ts:8`) |

## Open

| Item | Where | Required disposition |
|---|---|---|
| `react` + `react-dom` as **runtime** deps of `@june/ai`, solely for `renderToStaticMarkup` of the OAuth callback page | `ai/package.json:14`, `ai/src/auth/oauth/callback-page.ts` | Replace with a static HTML template string; drop both deps and their `@types` |
| `ResponseItem` open struct and everything it forces | `schema/src/index.ts`; consumers per §2.1 | Part 2 slice 2 |
| Four `*Operations` seams, population of one each | `bash.ts:84`, `grep.ts:77`, `find.ts:70`, `ls.ts:37` | Part 4 §4.3, slice 3, deleted in one wave |
| Zero tests for bash, edit, edit-diff, grep, find, read, write, truncate, and support modules (`tools.test.ts` covers two ls cases) | `core/test/` | Slice 4 |
| Records ledger vs spec's `op.state` registers | `harness/session/types.ts` model | Open question 1; decide at slice 6 |
| Demos: stopped | `packages/demo/*` | Frozen. No development, no core changes on their behalf. Unfreezing is a product decision recorded in blueprint, not a drive-by. |

---

# Open questions

1. **Records → total-state registers.** The pi spec's current revision replaces the append-only records ledger with one overwritten `op.state/{operationId}` register per operation and terminal register deletion. Shipped pi 0.84.2 still uses records, as does June. Adopt at slice 6 with a migration, or record a reasoned decline. The spec's recovery-by-point-lookup argument is strong; the migration touches every record type and the SQLite schema.
2. **Union passthrough breadth.** Part 2 rule 2 says unknown provider fields do not ride along and named fields are added deliberately. If a second provider dialect needs materially different item fields, revisit whether variants grow fields or the adapter owns a private extension map. Default position stands until a concrete provider forces the question.
3. **Search service boundary.** The in-backend FTS5 index is justified by the single-file decision (§3.3). The moment a second storage backend lands, search must be re-cut as the spec's standalone service with durable cursors. Tied to slice 5.

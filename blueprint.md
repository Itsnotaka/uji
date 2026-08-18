# June blueprint

Living brainstorm notes. Not a finished plan. Product/architecture brain dump for June.

Updated: 2026-08-13

> Brain dump. Grow freely. Prior Core+Clients attempts are cautionary only — not product requirements.

---

## Thesis (Daniel)

June is a **new, independent core for building cross-platform agentic UI**, distributed like shadcn: copy-pastable, composable source primitives. Quality bar: drop-in host for Core+Clients products (desktop/web/CLI on one core). It is not a fork of any prior host attempt.

Not "the chat product." Not "just an agent loop."

Emphasis on **UI**. People already build harnesses and agent systems; what is missing is a good way to build the UI layer on top. Pi is not there yet for a full product system. OpenCode v2 is WIP but its SDK shape is the one we like.

Flue-like posture:

- deploy the core to the cloud if you want
- embed in a website (streaming / AI-SDK-like client experience) if you want
- most importantly: give builders the primitives they actually need in the core to build everything else

Especially target **GUI apps**. Flue already covers cloud + React web. The gap is a desktop / Cursor-class client built on shared primitives.

It is a harness in the sense of **primitives that help you build a harness**, aimed at GUI.

### Non-negotiable demos

1. Mimic Cursor UI
2. Cloud agent UI demo
3. Our own GUI client
4. Quick start: shadcn chat component on June Core
5. Longer arc: demos that prove recreate-all (Cursor / Linear / Notion / OpenCode / Pi shapes)

---

## References

### Crucial
- https://github.com/earendil-works/pi/tree/main/packages/agent/docs (AgentHarness, search, telemetry)
- https://github.com/anomalyco/opencode/tree/v2 (and OpenCode SDK v2 shape on docs / `packages/sdk/js/src/v2`)

### Important
- https://linear.app/now/how-we-built-linear-agent

### Other
- https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/
- https://www.dgzhuya.com/modules/ch01-overview
- https://books.antinomie.org/pi/
- https://flueframework.com/docs/ (full guide / SDK / React)
- https://opencode.ai/docs/sdk/ + https://opencode.ai/docs/server/

### Local
- Repo: https://github.com/Itsnotaka/june
- Folder: `/Users/workgyver/Developer/june`

---

## How the refs layer (important)

```
Pi          = agent engine / harness primitives (Flue is built ON Pi)
Flue        = framework to define agents + deploy (Node/CF) + web SDK/React
OpenCode v2 = local headless server + typed client SDK that TUI/desktop/IDE all talk to
Linear post = product boundaries (skills, tool design, mid-run approvals)
```

June sits closest to: **OpenCode's "server + UI clients" split**, with **Pi/Flue-grade durable conversation core**, and **Linear-grade progressive capability loading**, aimed first at **GUI**.

---

## Cursor: what actually goes to the server

(Correcting "if core is in the cloud you lose local access.")

There are two Cursor modes. Do not mix them.

### A) In-IDE Agent / Chat (local tools)

Documented / widely reverse-engineered flow:

1. Electron UI captures message + @mentions + rules + open file context
2. Request goes to **Cursor servers** (auth, prompt assembly, sometimes embedding search)
3. Codebase index: embeddings + obfuscated path/line metadata in Turbopuffer; **source stays local**
4. Server returns hit metadata; **IDE reads real files locally** and injects snippets into the prompt
5. Cursor proxies the composed prompt to the LLM provider; streams tokens back
6. Chat history persists in local SQLite (`state.vscdb`), not as the system of record on Cursor servers
7. **Tool execution (read/edit/terminal) runs client-side** in the IDE

So for in-IDE Cursor: the "brain call" is remote, but **local access is preserved because the tool loop and file reads stay on the machine**. Hosting the model/proxy in the cloud does not by itself remove local FS access.

Sources (community + Cursor materials; treat reverse-eng as approximate):
- https://dasarpai.github.io/dsblog/cursor-chat-architecture-data-flow-storage/
- https://dev.to/vikram_ray/i-reverse-engineered-cursors-ai-agent-heres-everything-it-does-behind-the-scenes-3d0a
- https://theaiengineer.substack.com/p/how-cursor-actually-works
- https://cursor.com/blog/cloud-agent-environment

### B) Cloud Agents (remote VM)

Different product surface. Agent runs on a Cursor-managed (or pool) VM with a checkout of the repo. It does **not** see your unsaved buffer / arbitrary local disk the way the IDE agent does. It sees the remote workspace. Local vs cloud is a **runtime placement** choice, not "LLM must be local."

### Implication for June

Daniel's instinct is half right:

- If the **entire agent runtime** (tools + FS + shell) lives only in the cloud, you lose the local machine.
- If the **core is a protocol + session brain** and **tools are bound to a local host** (OpenCode-style local server, or IDE host), you can put model calls / orchestration wherever and still know what exists locally.

June should probably make **host placement** explicit:

| Piece | Local placement | Cloud placement |
| --- | --- | --- |
| GUI client | Desktop / IDE client process | Web client in browser |
| Session / conversation store | On-disk next to host (or local DB) | Remote durable store / DO — same protocol |
| Model calls | Through host to provider (or local proxy) | Through host to provider (same path) |
| Tools / FS / shell | Bound to this machine as tool host | Bound to a VM/worker as tool host |

The interesting product is: same UI primitives against a local host **or** a cloud host.

---

## Feature comparison (draft — filling as research lands)

### OpenCode (SDK / server shape we like)

Architecture: `opencode` starts a **headless HTTP server** (OpenAPI 3.1). TUI, desktop app, and IDE plugins are **clients**. `opencode serve` for standalone. SDK: `@opencode-ai/sdk` with `createOpencode()` (spawns server+client) or `createOpencodeClient({ baseUrl })`. Events over SSE.

Surfaces: terminal TUI, desktop app (beta), IDE extension, web.

Agents: built-in `build` (full access), `plan` (read-only / permissioned), `general` subagent (`@general`).

#### Server / SDK API surface (from docs)

Global: health, global events
App: log, list agents
Project: list, current
Path / VCS: current path, vcs info
Config: get/patch, providers
Provider: list, oauth authorize/callback
Sessions: list/create/get/delete/update, children, init (AGENTS.md), fork, abort, share/unshare, diff, summarize, revert/unrevert, permissions respond, status, todos
Messages: list/get, prompt (sync), prompt_async, command, shell; parts-based messages; structured output via json_schema
Files: find text/files/symbols, read, status, list
Tools (experimental): tool ids, tool schemas per model
LSP / formatters / MCP: status; add MCP dynamically
TUI control: append prompt, open dialogs, submit/clear, execute command, toast, control next/response
Auth: set provider credentials
Events: SSE bus (`event.subscribe`)

Also: undo/redo in product UX, share conversations, themes, keybinds, custom commands, formatters, multi-provider (models.dev), Zen curated models, privacy claim (does not store your code/context).

WIP note: v2 branch exists; SDK v2 codegen under `packages/sdk/js/src/v2`; product still evolving; desktop is beta.

**UI lesson:** the core value for June is the **client/server cut**: GUI never embeds the loop; it speaks a typed protocol to a host that owns tools + sessions.

### Flue (Astro team's agent framework; built on Pi)

Hooks API (`'use agent'`, `useModel`, `useSandbox`, …). Targets: Node, Cloudflare, GitHub Actions / CI. Vite + Hono app router. `createAgentRouter` mounts conversation URLs.

Capabilities (docs map): agents, models/providers (via Pi), tools, skills, sandboxes (incl. Cloudflare Computer durable workspace, Cloudflare Containers sandbox), routing, deploy (Node/CF), CLI (`flue init`, `flue run`, `flue add`), Agent SDK (`@flue/sdk`), React (`@flue/react` / `useFlueAgent`), streaming protocol (SSE + Durable Streams), attachments, abort, history/observe/wait/read.

Client model: **one client = one conversation URL** (mount path + conversation id). No deployment-wide enumerate-conversations API — app concern. Sends are 202 admissions; settlement via streams.

React: parts-based messages (`text`, `reasoning`, `dynamic-tool`, `file`); optimistic user messages; not AI SDK types/transport.

**UI lesson:** excellent for **web** product UX on a **deployed** agent. Weaker as a story for a **local desktop Cursor-class** host (that's OpenCode's cut). Flue + Pi give durable cloud conversations; OpenCode gives local tool host + multi-client.

### Pi (earendil-works/pi)

Identities: coding agent tool, learning textbook, SDK.

Packages: `pi-ai` (multi-provider LLM), `pi-agent-core` (agent loop), `pi-coding-agent` (CLI product + SDK), `pi-tui` (orthogonal TUI), experimental `pi-orchestrator`.

Default tools: read/write/edit/bash (+ grep/find/ls). Modes: interactive, print/JSON, RPC, SDK. Extensions, skills, prompt templates, themes, Pi packages. Tree/DAG sessions, fork, YOLO-by-default, 30+ providers, tiny system prompt.

**AgentHarness** (packages/agent/docs/harness.md) — durable runtime:

- Session = entry tree + facts + lanes + usage ledger
- Storage = entries (write-once) + registers (mutable) + usage (append)
- Operations with total `op.state` program counter; crash resume
- Effect sandwich: intent commit → uncertain effect → settlement commit
- Lanes for parallel threads over shared history (e.g. Slack)
- Hooks, telemetry, search over session entries
- Build order + invariants documented

Explicit non-goals in product philosophy: baked-in MCP, subagents, permission modals, plan mode, background bash, built-in todos (prefer extensions / files / containers).

**UI lesson:** strongest **durable harness** thinking. Weakest **product UI kit**. pi-tui is terminal-only; no first-class GUI protocol like OpenCode's OpenAPI server.

### Linear Agent (product patterns, not a framework)

System prompt = style + hard boundaries + product taxonomy + default opinions.
Constraints preferably in **tool design**, not prompt prose.
Large number of shallow product tools vs coding agent's few deep tools.
**System skills** = progressive disclosure of prompt fragment + tools.
Custom harness needs: dynamic tool injection (cache-aware), conditional mid-run approval, async sub-agents that suspend parent.

**UI lesson:** GUI must represent permissions, skill-loaded capability changes, and multi-surface tone. The core should emit events a UI can render (approval cards, tool parts, status).

---

## Comparison matrix (coarse)

Cells answer **ownership / placement**, not whether we "want" the feature.

| Concern | Pi | Flue | OpenCode | June boundary |
| --- | --- | --- | --- | --- |
| Durable session / crash resume | Harness owns loop + session backend; strong formal model | Durable streams / Durable Objects own resume | Sessions + server; less formal than Pi harness | **Core/harness** owns durable loop + session store; steal Pi's model |
| Local tool host (FS/shell/LSP) | CLI/SDK process is the local host | Sandboxes often remote/CF; host is framework-placed | First-class local server process | **Tool host** is a swappable placement (machine/VM); same protocol |
| Cloud deploy | DIY composition on top of Pi | First-class deploy adapters | Secondary to local server | **Composition** — same protocol, different host adapter; not a second core |
| Typed client SDK for UI | Weak / RPC-shaped | `@flue/sdk` + React; client of Flue core | `@opencode-ai/sdk` + OpenAPI; client of server | `@june/protocol` + `@june/client`; **clients never own the loop** |
| Web chat UI | None first-class | React hooks excellent | Web exists; desktop/TUI primary | **UI/registry demos** — peer client of the protocol |
| Desktop / Cursor-like GUI | None | None | Desktop beta as another client | **UI/registry demos** — primary demo client; still not the loop |
| Progressive skills | Skills + extensions (see Pi docs) | Skills / activate_skill | Agents/commands/MCP + plugins | **Split skills vs plugins**: core owns load/inject/catalog events; packs own content — see [Progressive skills + plugins](#progressive-skills--plugins-follow-pi--opencode--amp) |
| Mid-run approvals | Extension territory | App-level composition | Permissions API in server | **Core** owns policy + pause; **UI** owns cards; **protocol** carries ask/reply |
| Parts-based messages | Messages/events | Flue parts | Message + Part types | `@june/schema` owns wire; **UIs render** |
| Multi-client same session | RPC/modes | `observe()` many clients | TUI + IDE + desktop on one server | **Server/protocol** owns fan-out; UIs are peer clients |


---

## Working design bets (challenge these)

1. June core = **host protocol** (session, messages/parts, tools, permissions, events) + **pluggable runtimes** (local machine host, cloud VM host, maybe Flue/CF later).
2. GUI is a **peer client**, never the loop.
3. Demos prove the cut: same core drives Cursor-like desktop UI and a cloud-agent UI.
4. Handwritten end to end. Cite refs for lessons only; no wrapping their harness.

---

## Open questions for Daniel

1. Is the v1 host **always local** (OpenCode-like), with cloud host as demo #2, or dual from day one?
2. Message/part schema: align with OpenCode Parts, Flue parts, or define June parts and adapt?
3. ~~embed/reuse Pi~~ **Decided: handwritten.** How thin is the first harness slice?
4. AuthN for GUI ↔ host: local default trust, then token for remote?
5. What does "mimic Cursor UI" mean minimally: chat + diff + file tree + to-dos + permissions, or pixel-level?

---

## Flue deep inventory (research pass)

Source: flueframework.com + github.com/withastro/flue (Apache-2.0). Flue is built on Pi. Flue 2.0 = hooks-based dynamic agents; Vite owns build; conversation-scoped `@flue/sdk` + `@flue/react`.

### Positioning
Programmable harness framework (sessions, tools, skills, instructions, sandbox). Headless by design. Write once → CLI or deploy Node / Cloudflare / CI.

### Agent model
- `'use agent'` function; return value = system instructions; re-renders before every model call
- Addressable instances by id
- Statics: agentName, initialData schema, durability (maxAttempts, timeoutMs)
- Dynamic caps from persistent state

### Hooks (16 built-in)
useModel, useSandbox, useTool, useMcpConnection, useSkill, useSubagent, useInstruction, usePersistentState, useInitialData, useDelivery, useDispatchMessage, useDataWriter, useAgentStart/Finish, useResponseStart/Finish

### Tools
defineTool/useTool (Valibot), sandbox builtins (read/write/edit/bash/grep/glob), framework tools (task, activate_skill, read_skill_resource), harness tools, durable tools via step.do

### Subagents
useSubagent / GeneralSubagent; fresh child context; parallel task; depth cap 4; durable child streams

### Sandboxes
None | Virtual (just-bash) | Local Node | Remote adapters (CF Computer, CF Sandbox, Daytona, E2B, Modal, Vercel, boxd, exe.dev, islo, Mirage, smolvm…)

### Durability
Admit → durable stream before model work; queue; resume; abort; recovery of partials/tool batches. Node: lease + db.ts. CF: DO SQLite.

### HTTP / streaming
POST /:id → 202; history; updates (SSE or long-poll); abort; attachments. Own protocol (not Vercel AI SDK). Parts: text, reasoning, dynamic-tool, file, data-*.

### UI
@flue/sdk = one conversation URL. @flue/react = useFlueAgent. No first-party desktop/IDE shell. No built-in session list/search/delete (app routes).

### Also
Channels (Slack, Discord, GitHub, Linear, …), many Node DB adapters, OTel/Braintrust/Sentry, blueprints via `flue add`, no workflow primitive.

### Gap vs June demos
Excellent cloud + web embed backend. Missing Cursor-class desktop shell, open-folder workspace UX, productized approvals UI, multi-pane IDE chrome. June owns that shell; Flue is the closest "foundation + deploy + stream" reference.


---

## OpenCode v2 deep inventory (research pass)

**Critical:** Stable docs at opencode.ai/docs/sdk describe **V1** `@opencode-ai/sdk`. Daniel's preferred shape is **V2** on branch `v2` / site https://v2.opencode.ai:

- `@opencode-ai/sdk-next` — in-process Effect host (same HTTP router, no listener)
- `@opencode-ai/client` — Promise + Effect clients codegen from Protocol
- `@opencode-ai/protocol` + `schema` + `server` + `core`
- Binary: `opencode2` / `@opencode-ai/cli@next`
- Law: Client → Schema/Protocol only; never Core/Server. sdk-next may compose all three.

### Architecture bet
All UIs are thin clients of one HttpApi. TUI, desktop, web, Promise client, Effect client, in-process embed share handlers/middleware/errors.

### Session semantics (the interesting cut)
Durable **admit** → **pending inbox** → promote at safe boundary → process-local **drain**. Delivery: `steer` / `queue`. Also: interrupt, compact, staged revert (stage/clear/commit), fork, switchAgent/Model, context projections, instructions as typed hashed values, SSE event log.

### Other V2 surfaces
Location (project-scoped service map) · Permissions (ordered rules + ask/allow/deny + saved + session reply) · Tools (unified + MCP + CodeMode) · Forms/Questions · PTY/Shell/VCS · Plugins · Subagents/jobs · Providers/models.dev

### Built-in tools
read, write, edit, patch, glob, grep, shell, question, skill, subagent, webfetch, websearch, file-diff (+ MCP)

### UI packages (why this matters for June)
- `@opencode-ai/ui` + `./v2/*` design system
- `@opencode-ai/session-ui` + `./v2/*` transcript/diff/prompt
- `@opencode-ai/app` SolidJS web/desktop shell
- `@opencode-ai/tui`, `@opencode-ai/desktop`

### WIP
sdk-next transitional; clustering/workspace placement reserved; no exactly-once hard-crash claim; sharing unimplemented; Desktop may still lag engine; dual clients in TUI; public stable docs still V1.

### June steal list from OpenCode v2
1. One protocol, many clients (incl. embedded = same router)
2. Admit/pending/steer/queue/interrupt vocabulary (not a boolean isRunning)
3. Permissions + questions as first-class session APIs a GUI can bind
4. session-ui / ui v2 as reference for Cursor-like chrome (or inspiration, not necessarily dependency)
5. Location is optional host context exposed through `sdk.workspace`, not an ambient cwd or a prerequisite for sessions

---

## Pi deep inventory (research pass)

Packages @earendil-works/* ~0.84.x. MIT. Mario Zechner / Earendil.

### Layers
pi-ai → pi-agent-core (Agent + AgentHarness) → pi-coding-agent (CLI/SDK) · pi-tui (orthogonal) · experimental pi-protocol/client/server (CBOR) · pi-telemetry · sqlite session backend · pi-evals

### Product features
Modes: interactive / print / JSON / RPC / SDK. Tools: read/write/edit/bash (+ grep/find/ls). Tree sessions, fork, compact, share gist, AGENTS.md, skills, extensions (hot-reload), themes, packages (`pi install`). YOLO default. 30+ providers. Mid-session model switch.

### AgentHarness (durable)
Session = entry tree + facts + lanes + usage. Three stores. Effect sandwich. Total op.state program counter. Lanes for parallel threads. Hooks + events. Search. Telemetry schemas. Crash resume without replaying settled effects.

### Explicit non-goals in core
MCP, subagents, permission popups, plan mode, built-in todos, background bash, FS permission product — all extension/container territory.

### Gaps for Cursor-like GUI
No first-party GUI/IDE, no LSP/index, no multi-file apply UX, no MCP marketplace, no permission product, no cloud sync. RPC + SDK production-ready; CBOR remote protocol experimental. Two session stacks coexist (coding-agent JSONL v3 vs harness format-4/SQLite).

### June steal list from Pi (ideas only — handwritten)
1. Durability model ideas (lanes, ops, effect sandwich)
2. Minimal core + extension levers
3. Clear GUI integration seams
4. Do not expect a TUI harness to be the Cursor shell
5. **One-way decoupling** (Pi book ch.1 — *Decoupling: core doesn't know harness*): harness may depend on the loop; the loop must never import harness. See Decision 2026-08-12 below.

### Porting basis (Decision 2026-08-14)
Primary reference is pi's `packages/agent` (`@earendil-works/pi-agent-core` — published on npm at 0.84.x, though the harness inside it is still being built out against `docs/harness.md`; the spec itself calls parts of the in-tree code unfinished). June's agent loop, harness, session model, SQLite backend, and the read/bash/edit/write tools track that package. `pi-coding-agent` is the fallback only where the agent package has no equivalent (grep/find/ls, shell utils). Direction: adopt an ExecutionEnv-style effects boundary (harness.md §4.2) instead of per-tool Operations seams — the old Read/Write/EditOperations seams are gone; bash's `BashOperations` stands in for `env.executeShell` until June grows a real execution-env abstraction. Every ported file carries a `Based on <link>` credit to its pi source.

---

## Cursor deep pass (official + community)

Confirmed hybrid:

| Mode | Brain | Tools | Sees dirty local disk? |
| --- | --- | --- | --- |
| In-IDE Agent | Cursor cloud | Your machine | Yes |
| Managed Cloud Agent | Cursor cloud | Cursor VM (git clone) | No |
| My Machines / pool | Cursor cloud | Your worker | On that worker |

Official: even BYOK still goes through Cursor backend for final prompt building. Indexing = Merkle sync + server embeddings + metadata; client reads bytes. Privacy Mode ≠ local LLM. Cloud Agents are the main feature that stores repo copies for a duration.

**June vocabulary:** cloud brain ≠ blind to local. Blindness comes from choosing a **remote tool host**. Prefer naming **tool host placement** explicitly (local | cloud VM | my machine).

---

## Daniel notes (2026-08-11 evening)

OpenCode having a real **core** + **desktop app** is good. That is why we looked at it and used it once.

Gaps we care about vs that core:

- Not durable / configurable enough in the Pi sense
- Customizing the system prompt is **easy in Pi**, **hard in OpenCode's new core**
- We want Pi-level steerability (SYSTEM.md / append / resources / hermetic config) without giving up OpenCode's client/server + GUI kit

### Cautionary: prior Core+Clients cutovers

A prior Core+Clients host attempt already lived the OpenCode ↔ Pi A/B:

| Pattern | What happened |
| --- | --- |
| Multi-harness Core | pi / Claude / Cursor behind one HTTP+SSE SDK + desktop host |
| OpenCode-only cutover | Replace owned core with OpenCode SDK / sidecar |
| Bounce back to Pi | Cut chat/composer/runtime off OpenCode onto a Pi `AgentHarness` host |

Working host thesis that survived those swings:

1. One host process, one writer lease
2. Every session owns one harness instance (do **not** copy the session model into a second parallel model)
3. Workspace trust is the **only** permission gate (YOLO after trust)
4. Clients reload session data and render messages themselves
5. Host keeps running across UI reloads

Construct the harness with `systemPrompt`, tools, resources, models, JSONL repo — do not depend on a coding-agent TUI package as the brain.

Useful ideas to steal from OpenCode (even after leaving it as the runtime):

- Message snapshots / per-turn git checkpoints
- Per-file restore grain for undo
- Websearch tool design notes
- Multi-harness experiments that later simplify toward one durable harness

Hermetic config lesson: run the harness under the product home, not the user’s global Pi home, so user extensions/settings cannot fight the product or execute unowned code in-process. Project AGENTS.md/skills still load from cwd.

### Lesson for June

The OpenCode **shape** (core host + desktop/web clients + typed protocol) is right.
The OpenCode **configurability / durability / prompt ownership** is why that prior attempt bounced back to Pi.

June should aim for:

- OpenCode-like: core process, desktop GUI, multi-client protocol
- Pi-like: harness durability, trivial system prompt / resources / skills ownership, hermetic but user-overridable config surfaces
- From the cautionary exhibit: do not maintain two session models; trust gate once; handwritten harness; steal OpenCode checkpoint *ideas*



---

## Independence + Core+Clients replaceability (Daniel, continued)

June is a **new, fully independent** project. Not a fork or rename of a prior host.

Success criterion for the core: **easily replace an existing Core+Clients host**. A product with that shape should be able to swap onto June Core without rewriting chrome from scratch.

Implications:

- Stable, boring client protocol (session CRUD, prompt/steer/queue/interrupt, reload/entries, events, permissions/trust, models)
- Pi-grade prompt/config ownership (system prompt, resources, skills) as first-class, not buried
- OpenCode-grade multi-client host (desktop/web/CLI attach to one core)
- No consumer product names in the core; products are consumers of June, not baked into it

### Demo section (non-negotiable + quick starts)

1. **Cursor-like UI** (main GUI demo)
2. **Cloud agent UI** demo
3. **Own GUI client**
4. **Quick start:** shadcn chat component wired to June Core (lowest-friction "see it work" path for web before the full Cursor shell)



---

## Distribution philosophy (Daniel): feel like shadcn

Everything is **copy-pastable and composable**.

Not "install `@june/sdk` and call a black box." More like:

- registry / CLI that drops source into *your* repo
- small primitives you own after paste (host bits, protocol client, chat chrome, tool parts)
- compose a Core, a web chat, a desktop shell, a cloud-agent UI from the same pieces
- defaults that work; every layer replaceable without forking the universe

Tension to manage (write it down, don't paper over it):

- Core+Clients replaceability wants a **stable protocol contract**
- shadcn-feel wants **owned source**, not a versioned binary API forever

Resolution bet: the **wire protocol + part schema** are the stable contract; the **React/desktop implementations** are registry code you copy. Core reference implementation can be a package *and* a template you can eject.

Demos should teach composition:

1. `june add chat` → shadcn chat pieces + thin client against a local Core
2. `june add desktop-shell` → Cursor-like chrome composed from session-ui primitives
3. `june add cloud-host` → same client, different tool host



---

## Harness inside the core (Daniel)

There **is** a harness inside the Core. It must stay **simple like Pi**.

Rules of thumb:

- Small tool set by default; extend, don't bloat
- System prompt / resources / skills are obvious and user-owned (Pi-easy, not OpenCode-hard)
- Durable session ops without a second competing session model
- Product features (plan mode, MCP marketplace, approval theater) are composed *around* the harness, not welded into it
- If a knobs list needs a glossary, it failed the Pi test

The Core wraps the harness (lease, trust, HTTP, clients). The harness itself stays a steerable shell.

**Handwritten:** this harness is June's code, not an imported Pi/OpenCode/Flue runtime.



---

## How to read this file (Daniel)

This blueprint is a **brain dump**. It can keep growing. Do not optimize for short.

Prior Core+Clients hosts are **not** customers June must satisfy. They are a cautionary exhibit of how a core develops flaws: OpenCode cutover, dual session models, prompt ownership pain, bounce back to Pi. Take the lessons, then move on.



---

## Hard rule: handwritten

**Everything is handwritten.** June does not reuse or wrap another project's harness (not Pi AgentHarness, not OpenCode core, not Flue runtime) as the implementation.

References are for **ideas and critique only**:

- steal vocabulary / lessons (admit/pending, effect sandwich, parts, client/server cut)
- do not `import` their harness as June's brain
- do not say "sit on Pi" or "embed OpenCode" as the product story

June Core + June harness are authored in this repo (and/or copy-pasted out via the registry), end to end.



---

## Recreate-all test (Daniel)

Demos teach what the core needs. A **good core can recreate**:

| Product | What it is (for this test) | What it forces the core to support |
| --- | --- | --- |
| **Pi** | Minimal coding agent / steerable shell | Tiny tools, obvious system prompt + resources/skills, tree/fork sessions, steer/follow-up, YOLO-or-container posture, multi-provider |
| **OpenCode** | Local core + many clients (TUI/desktop/IDE) | Headless host, typed multi-client protocol, parts/events, permissions/questions UI hooks, project Location, PTY/shell, MCP |
| **Cursor** | IDE agent + cloud agents | Local tool host + dirty workspace awareness; cloud tool host (VM) with same client protocol; diffs/checkpoints; retrieval/context assembly; subagents; rules/skills as files |
| **Linear Agent** | Product agent in Linear/Slack | Many shallow product tools; progressive skills; mid-run approvals; dynamic tool injection; surface-aware tone; durable runs that pause for humans |
| **Notion Agent** | Workspace agent + Custom Agents | Domain tools over pages/DBs (not just files); @-context / source selection; connector tools (Slack/Mail/Calendar/MCP); **identity & ACL** (agent sees what user/agent is allowed); **triggers/schedules** for autonomous runs; run logs / reversible actions; instructions + skills personalization |

### Core capability checklist (union of the above)

If June Core is "good," handwritten support for these exists (UI chrome can be demo/registry):

1. **Host process** clients attach to (local and optionally remote)
2. **Sessions** with prompt / steer / queue / interrupt / abort
3. **Parts + events** a GUI can render (text, reasoning, tools, questions, markers…)
4. **System prompt + instructions + skills** ownership that is trivial to customize
5. **Tool registry** deep (FS/shell) *and* shallow (product CRUD) tools
6. **Progressive skills** (load capability packs without stuffing every turn)
7. **Decision / trust signals** on the wire if needed (events the UI can bind) — **not** permission/disclosure UI (out of scope)
8. **Optional Workspace / Location** scope exposed through `sdk.workspace`; sessions do not require one
9. **Identity & ACL** for product agents (Notion/Linear-shaped)
10. **Triggers & schedules** for autonomous Custom-Agent-shaped runs
11. **Checkpoints / revert** for coding-agent-shaped undo
12. **Multi-client** same session (desktop + web + mobile observe)
13. **Pluggable tool host placement** (this machine vs cloud VM)
14. **Connectors / MCP** as tool sources without baking one product's ontology in
15. **Durable cross-agent runs** — an agent can admit an addressable child run, send it messages, suspend without holding a hot process, and settle its result exactly once into the parent conversation. Agent catalogs, delegation policy, and delegation UI remain composition/UI.

### Implication

Demos are not side quests. Each demo proves a slice of that checklist.

- shadcn chat → 1–4, 12
- bot / general assistant → 1–4, 12; no workspace required
- Cursor-like UI → 1–8, 11–13
- cloud agent UI → 13 (+ same protocol)
- Linear-shaped demo → 5–7, 9, progressive skills
- Notion-shaped demo → 5, 9–10, connectors
- Pi-shaped CLI/TUI → 2–5, simplicity litmus

The core is still the product. The recreate-all set is how we know the core is complete enough.

Refs to add:
- https://www.notion.com/product/agents
- https://www.notion.com/help/custom-agents
- https://www.notion.com/help/notion-agent



---

## Core vs UI scope (Daniel)

Not everything in the recreate-all products belongs in June Core.

**UI-side (out of core scope):**
- Permission / approval **chrome** (cards, modals, disclosure UX)
- Progressive disclosure **presentation** (how skills/tools are shown/hidden in the UI)
- Tone / surface styling (Slack vs app chat look)
- Whether the product asks for or attaches a workspace
- Most Cursor-like IDE chrome (file tree layout, pixel mimic)
- Chat hooks / scrollers / bubbles (shadcn, AI SDK UI territory)

**Core-side (in scope):**
- Harness + host + sessions + parts/events + tools + prompt/skills ownership + triggers + ACL **data**
- Approval **policy** and pause/resume (can a tool run yet?) — not the card
- Optional workspace context and the `sdk.workspace` protocol surface; never a required folder picker or ambient cwd
- Protocol surface so UI can bind decisions/catalogs/status
- Do **not** ship productized permission theater UI inside the core

Litmus: if it's pixels or copy for humans deciding, it's UI. If it's durable state / tool execution / wake conditions / what the model can call, it's core.



---

## AI SDK v7 as scope referee (2026-08-11)

Ref: https://vercel.com/changelog/ai-sdk-7 · https://ai-sdk.dev/v7/docs/getting-started/navigating-the-library · https://ai-sdk.dev/v7/docs/agents/tool-approvals

v7 library split:

| Layer | Owns |
| --- | --- |
| **AI SDK Core** (`ai`) | models, tools, `ToolLoopAgent`, `toolApproval` **policy**, `WorkflowAgent` durability, `runtimeContext` / `toolsContext`, `instructions`, sandboxes, harness adapters, telemetry |
| **AI SDK UI** (`@ai-sdk/react` …) | `useChat`, transports (`DirectChatTransport` / HTTP), rendering `UIMessage` parts, MCP App iframe renderer, approval **response** helpers in the chat hook |

Message split: `ModelMessage` = model context; `UIMessage` = parts for painting (text, reasoning, tools, files, data, approval states).

### Answer for June core vs UI

| Concern | June Core | June UI / registry demos |
| --- | --- | --- |
| Permission / disclosure **chrome** | Emits permission/skill events on the wire; does not own chrome | Owns approval cards, disclosure UI, and capability chrome |
| Approval **policy** + pause before tool runs | Owns policy evaluation + pause/resume (v7 `toolApproval`-shaped) | Renders ask cards and replies over the protocol; never decides policy |
| Progressive disclosure **presentation** | Owns catalogs + activate/inject; may expose skill catalogs on the wire | Owns how catalogs/skills/tools are shown, hidden, and announced in the shell |
| Parts / stream protocol | `@june/schema` + core/server own the wire and fan-out | Consumes parts and renders them; never defines the part model |
| Chat scroller / bubbles / Cursor shell | None — not a UI concern | Owns chat chrome, diffs, file tree, to-dos, Cursor-like shell |
| Instructions / skills ownership | Owns load/inject/catalog lifecycle; product packs own skill *content* | Configures/selects via protocol; may author UI-only presentation of packs |
| Triggers / ACL data / tool host placement | Owns trigger/ACL data model + which tool-host adapter is attached | Configures and displays; does not host FS/shell or own ACL enforcement |

Boolean yes/no is the wrong question — write the owner. Litmus aligned with v7: **pixels and human prompts = UI**; **loop, tools, policies, durable state, wire parts = core**.



---

## Why not "just AI SDK" (Daniel's experience)

Question: why doesn't OpenCode just use AI SDK? Why do `sdk.session` / project / path / file feel local in a way AI SDK never delivered?

### Different layers

| | **AI SDK (v7)** | **OpenCode SDK/server** |
| --- | --- | --- |
| Shape | Library in *your* process / request | Long-lived **local host** + typed client |
| Session | App-managed `UIMessage[]` (or opaque harness resume if wrapping) | First-class server objects: create/list/fork/abort/revert/share |
| Workspace | You define tools; no built-in dirty-disk host API | Project/path/file/find/symbols/VCS/shell bound to the machine |
| Clients | Typically one `useChat` ↔ one transport | Many clients ↔ one core (TUI/desktop/IDE/script) |
| Loop | `ToolLoopAgent` / `streamText` | Host runs the agent against that workspace |
| Honesty check | v7 adds `HarnessAgent` **adapters for OpenCode/Pi** | Proves AI SDK alone wasn't enough |

AI SDK docs (harnesses): a harness owns workspace, built-in tools, native session state, compaction, permissions — larger than a model call. Chat routes must **resume session**, not replay full UI history into the model.

### What Daniel felt

`sdk.session` and optional `sdk.workspace` APIs are **host control planes**. AI SDK gave streaming chat + tool loops; it did not give a durable, attachable, multi-client coding host over the files on disk.

### June takeaway

- Steal OpenCode's **host + session + optional workspace protocol** idea (handwritten).
- AI SDK may help **UI demos** or model plumbing later; it is not a substitute for June Core.
- Do not make workspace implicit. Products that need one use `sdk.workspace`; products such as `bot` ignore it.

Refs: https://opencode.ai/docs/sdk/ · https://opencode.ai/docs/server/ · https://ai-sdk.dev/docs/ai-sdk-harnesses/overview · https://vercel.com/changelog/ai-sdk-7



---

## Building-block / Lego core (Daniel)

Refs:
- https://github.com/lucia-auth/lucia — auth as small clean primitives + adapters
- https://github.com/pilcrowonpaper/arctic — OAuth clients as swappable provider blocks
- https://mitchellh.com/writing/building-block-economy — ship high-quality blocks; let others (and agents) glue quantity on top

### Posture

June Core is **blocks all the way** — no privileged framework kernel other pieces hang off. Session, parts, host, store, log, providers, tools: each is a block. You compose them.

- swap **runtime host** (local Node, Cloudflare, …)
- swap **logging / telemetry**
- swap **model providers**
- swap **storage** (memory, JSONL, SQLite, DO, …)
- swap **tool packs** (FS/shell vs product CRUD)
- session / parts / protocol are blocks too — not a hidden baseplate

Syntax inspiration (Lucia/Arctic): small functions, explicit adapters, no hidden global framework magic. User composes:

```ts
// sketch only — not an API promise
const core = createJune({
  store: sqliteStore(path),
  host: localHost(),
  // observability: compose a layer/context — NOT a pino logger()
  // Pi-shaped: telemetry: TelemetryContext (noop | otel adapter)
  // or OpenCode2-shaped: Effect Observability.layer (Logger + OTLP)
  // export: OTel/OTLP standard; Sentry = adapter, not a second API
  providers: [anthropic, openai],
  tools: [fsTools, gitTools],
});
```

Cloudflare is one block (`host` / `store`), not a fork of June. Remote clients still hit the same `@june/protocol` HTTP/SSE surface.


### Fit with shadcn distribution

- Blocks are copy-pastable **or** tiny packages — either way, user owns the composition site
- Registry demos show recommended assemblies (chat, desktop shell, cloud host)
- Agents glue blocks well when docs are sharp (Hashimoto's point)

### Fit with handwritten rule

We handwrite the blocks. We do not wrap Pi/OpenCode as the composition. Their *ideas* inform the shapes of the blocks.

---

## Package layout (OpenCode naming)

Daniel preference: follow **OpenCode v2 package names**, not invent (`parts` / `agent` / `host-local`). Scope `@june/*`. Handwritten blocks still; names match the shape we like.

OpenCode v2 packages we care about (from `anomalyco/opencode` `v2`):
`schema`, `protocol`, `core`, `server`, `client`, `sdk-next`, `ai`, `util`, `plugin`, then UI later (`ui`, `session-ui`, `app`, `desktop`, `cli`, `tui`).

Law to keep (OpenCode): clients talk **schema/protocol** only — never import `core` / `server` internals.

### v0 packages (first cut)

| Package | Role |
|---|---|
| `@june/schema` | Parts, messages, events, shared types |
| `@june/protocol` | Host API surface (session, optional workspace, permissions, events) |
| `@june/core` | Session + loop + composition (`createJune`-style wiring lives here as blocks, not a sealed kernel) |
| `@june/server` | Local HTTP host binding |
| `@june/client` | Typed client for UIs |
| `@june/ai` | Model provider adapters |
| `@june/util` | Tiny shared helpers |

### Later (same names as OpenCode when we need them)

`sdk` / `sdk-next`, `plugin`, `ui`, `session-ui`, `app`, `desktop`, `cli` — Cloudflare/host variants stay composition inside `server`/`core` (or a thin adapter package), not a rename away from this map.

### Explicit non-names for June packages

Do not ship `@june/parts`, `@june/agent`, `@june/store`, `@june/host-local` as top-level packages unless we later decide OpenCode's map is wrong. Store/log/host swaps are **adapters composed into** `core`/`server`, Lucia-style.

### Decision (2026-08-12)

Lock package names to OpenCode map. `@june/core` is the name (not `agent-core`). Inside `core`: Pi-simple harness — obvious system prompt / resources / skills, pluggable session backend. **Dependency law inside `core`:** loop/primitives sit below; harness-ish session/skills/compaction compose *up* via `runAgentLoop` (or June's equivalent). Harness → loop only; loop ↛ harness. Light Agent and harness-heavy are sibling compositions over the same loop, not inheritance. Steal Pi's session-backend idea as composition into `core`/`server`, keep OpenCode's `schema` / `protocol` / `server` / `client` / `ai` / `util` names.

---

## Multi-client protocol (Daniel, 2026-08-12)

OpenCode2's server shape is efficient because **clients do not force a rewrite of the API per language**. One host speaks a stable protocol; TUI / desktop / IDE / web all attach as clients.

June takes that further as a hard goal: the same protocol must be implementable from **any** client language/runtime — including a **Swift iOS/macOS app** — not only TypeScript. Typed TS client is first-party; Swift (and others) are first-class citizens of the wire, not afterthoughts.

Implications:
- **Protocol + schema are the product surface** clients bind to (OpenCode law: clients talk schema/protocol, not core internals)
- Prefer language-neutral wire (OpenAPI / HTTP+SSE or equivalent) over TS-only RPC tricks that do not codegen cleanly
- `@june/client` is the TS SDK; mobile/native apps use generated or hand-written clients against the same protocol
- Do not bake React/TS UI assumptions into the host API

### Client SDK surface: workspace is optional

The SDK exposes `sdk.workspace`, but the core never requires a workspace to create or run a session. The product UI decides whether workspace context belongs in its experience.

| Namespace | Contract |
| --- | --- |
| `sdk.session` | Create, resume, prompt, steer, and observe sessions with no workspace requirement |
| `sdk.workspace` | Resolve and manage workspace context for products that need files, shell, version control, or project-scoped resources |

Rules:

- `bot` and other general-assistant products can ignore `sdk.workspace`
- A coding UI chooses when to ask for a workspace and when to attach it
- Workspace-scoped tools receive explicit workspace context; they never inherit the host process cwd
- A workspace-free session can use any tool pack that does not require workspace context
- The protocol will define the exact `sdk.workspace` verbs and identifiers; the loop must not invent them


---


## Observability / telemetry (Daniel, 2026-08-12)

Do **not** ship a `logger()` / pino-style injectable as the composition face.

**How the refs do it**
- **Pi:** session **event stream** is the product log (JSON mode / harness events). Separately `@earendil-works/pi-telemetry` = vendor-neutral `TelemetryContext.startSpan(cb)` passed explicitly; `NOOP_TELEMETRY_CONTEXT` by default; adapters for OTel/etc. No ambient ALS required in the contract. Optional community `pi-otel` for OTLP.
- **OpenCode2:** Effect `Observability.layer` — Effect `Logger` + OTLP tracing composed into `AppRuntime`, not a constructor `log:` field. Spans via `Effect.fn("Service.method")`.

**June bet**
1. Protocol event log (parts/events clients already see) is the first-class audit/stream.
2. Process diagnostics = **TelemetryContext** (Pi-shaped) and/or **Effect Observability layer** (OpenCode2-shaped).
3. **OpenTelemetry is the standard export** — OTLP traces/metrics/logs. Adapters plug backends (Jaeger, Grafana, Honeycomb, Cloudflare analytics, …).
4. **Sentry is a backend adapter**, not a parallel instrumentation API. Prefer Sentry's OTel integration / OTLP ingest, or a thin Sentry adapter that implements the same TelemetryContext. App code never imports `@sentry/*` inside core.
5. Never require apps to pass `pino()` into `createJune`.
6. Hosting on Cloudflare does not change the story: same protocol; OTLP (or CF-native exporter) behind the same context/layer interface.

## Local box workspace notes (2026-08-12)

Daniel's sidekick (June) keeps a working copy of this repo on the shared computer at `~/Developer/june`.

Tooling installed there for on-the-fly work:
- **Ghostty** as the terminal
- **VSCodium** (`codium`) as the editor (pure OSS VS Code)
- **mise**: Node 26 + pnpm 11 (see `mise.toml`)
- CLIs on PATH: `claude` (Claude Code), `codex` (OpenAI), `pi` (earendil-works), `agent` / `cursor-agent` (Cursor CLI)
- Codex CLI signed in on that machine

GitHub CLI device login was rate-limited on the box; prefer authenticating `gh` with a token or committing from Daniel's Mac when the desktop app is connected.

Package cut remains OpenCode-named (`@june/schema|protocol|core|server|client|ai|util`) with Pi-simple harness inside `core`, multi-client wire including Swift.

---

## Progressive skills + plugins (follow Pi · OpenCode · Amp)

"Progressive skills: yes" is not a design. Steal the split from Pi extensions, OpenCode plugins, and Amp plugins/skills: **skills are content packs** (prompt fragment + optional tools/resources); **plugins/extensions are code** that register tools/commands/hooks. Core owns discovery, trust, mid-run load/inject, and events; packs and plugins own what gets loaded.

Refs:
- Pi extensions: https://pi.dev/docs/latest/extensions
- Pi extensions source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- OpenCode plugins: https://opencode.ai/docs/plugins/
- OpenCode v2 plugins: https://opencode.ai/v2/docs/build/plugins
- Amp manual: https://ampcode.com/manual
- Amp plugin API: https://ampcode.com/manual/plugin-api
- Amp agent skills: https://ampcode.com/manual/agent-skills.md

### Skill vs plugin/extension

| | Skill | Plugin / extension |
| --- | --- | --- |
| **What** | Metadata + prompt fragment (+ optional tools/resources); progressive disclosure content | In-process TypeScript module: `registerTool` / `registerCommand` / `on` lifecycle hooks |
| **When it loads** | Catalog (name+description) early; full body + tools on activate / mid-run need | At host startup (or reload); then hooks fire for the session lifetime |
| **Who authors** | Product packs, project/team, or user — usually markdown/`SKILL.md`, not a runtime SDK | Extension authors using `@june/plugin` (Pi/OpenCode/Amp-shaped) |

Pattern across Pi + OpenCode + Amp: keep **guidance packs** (skills) separate from **code that mutates the harness** (plugins/extensions). Do not collapse both into one "capability blob."

### Discovery + trust

| Source | Role | Trust |
| --- | --- | --- |
| Hermetic product home | Built-in / product-shipped skills + plugins under the product home | **Default win** — user global must not fight the product |
| Project (if trusted) | Project `.agents/skills`, project plugin dirs | Load only after explicit project trust (Pi-shaped) |
| User config | User-wide skills/plugins | Allowed as override after product hermetic base; never silently replace product packs |
| Package installs | Published plugins or skill packs | Explicit install/config; treat as code from a publisher you trust |

Hermetic product home wins over user-global fighting the product (Pi lesson already noted elsewhere in this doc).

### Mid-run progressive load

Prefix-cache-aware sequence (Linear pressure + Pi/Amp skill disclosure):

1. **Catalog** — expose name + description only (cheap; always in context or queryable)
2. **Activate** — agent or harness chooses a skill when the task needs it
3. **Inject** — append prompt fragment + register tools without restuffing the entire system prompt (preserve provider prefix cache)
4. **Emit events** — `skill.available` / `skill.activated` / `tools.changed` so every peer UI can update capability chrome

Core owns steps 1-4. Product packs own the catalog entries and injected content. UI owns rendering the capability change — not deciding load policy.

### What `@june/plugin` is for

SDK surface for in-process extensions (follow Pi `ExtensionAPI` / Amp `PluginAPI` / OpenCode plugin hooks):

- `registerTool` / `registerCommand` / `on(...)` lifecycle hooks
- Optional session helpers; not a second agent loop
- **UI chrome stays client-side** — plugins may emit events or request UI prompts over the protocol; they do not own Cursor-shell pixels inside core

Skills are not authored through `@june/plugin`; they are content discovered and injected by core.

### Boundary checklist

| Concern | Owner |
| --- | --- |
| Catalog (name + description) | **Core** exposes; packs author entries |
| Skill content (prompt fragment, resources) | **Product pack / project / user** |
| Mid-run inject + prefix-cache policy | **Core / harness** |
| Plugin hooks (`registerTool` / `on`) | **`@june/plugin` authors**; core hosts the runner |
| Capability / approval chrome | **UI / registry demos** |
| Hermetic product home vs user global | **Core** enforces precedence; product home wins |

Closing: writing "Progressive skills: yes" in a matrix is not a design — name the owners (core load/inject/events vs pack content vs plugin SDK vs UI chrome) or the cell is empty.

---

## Linear Agent as complexity stress-test (2026-08-12)

Refs:
- https://linear.app/now/how-we-built-linear-agent
- https://linear.app/docs/linear-agent

Linear Agent is a useful **complexity stress-test** for June: many UIs, one agent, product ontology, progressive skills, durable mid-run orchestration, ACL-scoped action. **Do not build Linear in v0.** Ensure core blocks can recreate this shape later.

### Product surfaces (many UIs, one agent)

One agent behind many entry points:
- dedicated chat (multi-tab, history)
- `@mention` in comments / descriptions
- Slack, Teams, mobile
- coding sessions (delegate implementation)

Tone and guidance can differ per surface — e.g. Slack issue-creation guidance is separate from in-app workspace guidance; personal guidance can apply across both.

### Capability shape (opposite of coding agents)

Coding agents: few deep primitives (`read` / `write` / `shell`) + strong model priors for code/FS.

Linear Agent: **many shallow product tools** + **product ontology** + **best-practice fragments**. Each capability needs tools, an explanation of what the data means, and principles for using the feature well — not a thin wrapper over GraphQL/SDK (they deliberately avoided low-level primitives that invite speculative mistakes).

Composition unit: **progressive system skills** — each bundles metadata + prompt fragment + tools. Preload by invocation context (prompt + surface); load more mid-run as the task reveals needs. User skills (personal/team) and **Loops** (scheduled / event triggers) sit on top of that system layer.

### Harness pressures Linear called out

Off-the-shelf harnesses assume prompt+tools upfront → `run` → done. Linear needed mid-run control:
1. **Dynamic tool injection** via skills without blowing the provider **prefix cache**
2. **Contextual mid-run approval** — not only tool-name rules (e.g. delete something just created vs delete an existing issue; post to most threads vs a public-synced thread)
3. **Async sub-agent that looks sync to parent** — parent sees a tool call; underneath, suspend the durable workflow so idle wait does not hold server resources, then resume

Custom stack: provider-agnostic client, durable workflow agent loop, streaming/storage that understands product-rich elements before the UI.

### Permissions + guidance layers

- Act **within the caller's ACL** — only see/change what the invoking user can
- Guidance scoped **workspace / team / personal / surface** (layered instruction resources, not one global system prompt blob)

### June implication (design, not implementation yet)

v0 stays coding-agent shaped. Core blocks must still be able to grow into Linear-shaped product agents without a rewrite:

1. **Progressive skills** — catalog → activate → inject (tools + prompt fragments) mid-run; see [Progressive skills + plugins](#progressive-skills--plugins-follow-pi--opencode--amp)
2. **Durable pause/resume** + contextual `toolApproval` policy
3. **Multi-client protocol** — same wire, many UIs (already a June goal)
4. **Identity/ACL on every tool host call**
5. **Guidance as layered instruction resources** (workspace / team / personal / surface)
6. **Triggers / wakes** (Loops-shaped: schedule + event)
7. **Tool packs as shallow domain adapters + ontology**, not only FS/shell

Fit with existing June posture: skills/resources already in the Pi-simple harness story; multi-client protocol already locked; tool packs as swappable blocks already named. The stress-test is whether those blocks stay open enough for progressive disclosure, durable mid-run approval, and ACL-scoped product tools — not whether we ship a Linear clone.

## Harness vs product pipeline (Linear Aug 10 deep cut, 2026-08-12)

Frame: from https://linear.app/now/how-we-built-linear-agent — what belongs in June **harness/core** vs what stays **product / user / composition** (skills, Loops, tool packs, UIs). Coding-sessions post (https://linear.app/now/coding-sessions-for-linear-agent) shows fix→PR is a configurable product loop, not harness law.

### Harness / core (must support)
- Durable agent loop + pause/resume (workflow-shaped)
- Provider-agnostic thread/parts storage + stream parsing hooks for rich parts (mentions/widgets later)
- Progressive skill load: inject tools + prompt fragments mid-run; design for provider prefix-cache friendliness
- Contextual mid-run toolApproval (policy can see conversation history / who created the target — not only tool name)
- Sub-agent as suspendable tool call (parent idle without burning a hot loop)
- Session scope + ACL identity passed into tool host
- Multi-client protocol so many UIs attach

### Not harness — product / user / packs handle
- Concrete domain tools (create issue, triage, customer requests)
- Product ontology + best-practice prompt fragments (system skills *content*)
- User/team skills and Guidance layers (workspace/team/personal/surface)
- Surface chrome (Slack tone, comment composer, chat tabs, Diffs UI)
- The **pipeline** triage → investigate → coding session → PR → review → merge: composed via triggers/Loops + a coding tool pack / external harness (Claude Code/Codex), not baked into June core as a fixed workflow
- How far autonomy goes (draft only vs auto-PR) — user/org policy, not core

### June rule of thumb
If removing Linear tomorrow would still leave the mechanism useful for Cursor-like / Notion-like / OpenCode-like demos, it is harness. If it only makes sense as “the Linear product loop,” it is composition.

---

## Provider login funnel + cheap test model (Daniel, 2026-08-12)

### Baseline state (corrected framing)

The box intentionally has no `OPENAI_API_KEY` — new repo, nothing configured, and Daniel does not want to mint API keys. The chosen path is ChatGPT OAuth (the box's codex sign-in shows the credential shape: `~/.codex/auth.json` with `tokens.{id_token,access_token,refresh_token,account_id}`, `OPENAI_API_KEY: null`). The v0 single-file agent only spoke env API key, so the login funnel is the first real feature, not a recovery from a mistake: **provider auth is a core block, not env-var plumbing** — the exact gap the Lucia/Arctic refs were pointing at.

### Test model decision

Default `JUNE_MODEL` = **`gpt-5.6-luna`**, `JUNE_EFFORT` = **`medium`** (Responses API `reasoning.effort`). $0.20/M input, $1.20/M output, ~1M context — cheap enough to leave test loops running. `gpt-5.1-codex`-class models stay an env override, not the default.

### Login funnel bet

Core owns a **client-agnostic login funnel**; GUI and CLI are just drivers of the same steps. OpenCode v2 (`sdk.provider.login({ mode })`, `opencode auth login --provider --method`, `auth.json` store) and Pi (`pi auth check/print-*`, refresh-expired-OAuth-on-read) both shape it this way.

1. **Shape**: `provider.login({ mode })` returns a **step/state machine** — e.g. `{ type: "open-url", url, verifier }` → `{ type: "await-callback" | "poll" }` → `{ type: "stored", credential }`. Core never opens a browser or prints; the client renders each step (CLI prints URL / device code, GUI opens a window, remote GUI proxies the callback over the protocol).
2. **Modes** (per provider, advertised not hardcoded): `api-key`, `oauth` (OpenAI ChatGPT sign-in — PKCE + localhost loopback callback, codex-style), `device`, plus env passthrough as an implicit source.
3. **Credential decides transport**: OpenAI OAuth tokens are ChatGPT-plan tokens that route to the ChatGPT backend Codex endpoint (with account-id header), *not* `api.openai.com` — so base URL + wire quirks live inside the provider block next to its credential type (Arctic-style: provider = swappable OAuth block).
4. **Storage**: auth store is an adapter composed into core/server (file `auth.json` first, keychain/DO later). Refresh-on-read like Pi. Priority: stored credential → env → config, matching OpenCode.
5. **Protocol surface**: provider list / authorize / callback already sketched in the OpenCode surface notes — expose them on `@june/protocol` so any client language can drive the funnel.

### Package cut trigger

The funnel is the first block two clients genuinely share, so it triggers the monorepo cut: **turborepo, copying the `opencode2` (anomalyco/opencode v2) layout**, names per the locked package map. No `@june/auth` top-level (not in the OpenCode map): login modes live in **`@june/ai`** provider blocks, the store adapter composes into `core`/`server`, the wire surface is `@june/protocol`. Cut only what this needs first (`schema`, `ai`, `core`, `cli`-thin) — do not scaffold all seven empty.

---

## Decision 2026-08-12 — Core ↛ harness (Pi ch.1 decoupling)

Source: https://books.antinomie.org/pi/chapter/01#decoupling-core-doesnt-know-harness

### What Pi actually says

Not mutual blindness. **One-way** dependence:

- **Core does not know harness.** Delete `harness/` and the loop / light `Agent` layer need zero import changes (except barrel exports).
- **Harness does know core** — and that is correct. `AgentHarness` imports exactly one core *value*: `runAgentLoop`. Everything else from core is `import type` (erased at compile time).
- **`Agent` and `AgentHarness` do not know each other.** They are two compositions over the same loop primitive, not parent/child. Inheritance would weld the light in-memory lifecycle to the heavy session/compaction/mutex lifecycle; composition keeps the loop small.

Evidence pattern: grep harness for imports of the light Agent module → zero hits; grep the loop for harness imports → zero hits.

### June rule (locked)

Inside `@june/core`:

| Layer | May import | Must not import |
| --- | --- | --- |
| Loop / primitives (`runAgentLoop` equivalent, types, streamFn shape) | nothing harness-ish | session, compaction, skills loader, Node env, product tools |
| Light in-memory agent composition (optional embed path) | loop only | harness modules |
| Harness composition (durable session, skills, compaction, coding tools) | loop (+ `import type` from core public surface) | the light Agent class; lateral harness subdirs only via a harness types hub |

Package `@june/core` may still *export* both compositions. Clients never see the split — they speak `@june/schema` / `@june/protocol` only.

### Why this matters for the demo bar

If the demo forces the loop to import session/skills/UI concerns, we have already lost the Pi-simple harness. Compose those in; do not grow the loop.

---

## Decision 2026-08-13 — Desktop app, showcase site, and shared UI

The demo boundary is now concrete:

- `packages/demo/grok-bot` is an Electron app. Electron main hosts `AgentHarness`, provider auth, and the local SQLite session repo; the sandboxed renderer sees only a typed preload API.
- Bot sessions do not require a folder. A future coding product may ask for one and provide it through `sdk.workspace`; June Core never invents an ambient workspace.
- The desktop loop is intentionally small: ChatGPT login, local history, streaming text, stop, new chat, and four editable agent profiles. Every profile owns real Core-backed conversations; there are no preview-only bots. Profile edits persist in the session database and become the harness instructions for subsequent turns.
- Those profiles are currently separate conversations behind one active harness, not communicating participants. Cross-agent delegation remains the durable Core gap recorded below; the renderer must not simulate it.
- `packages/demo/website` is a TanStack Start marketing site about June. It shows the desktop product; it does not duplicate or simulate the harness.
- `packages/ui` is the shared `@june/ui` source package, initialized from shadcn's Base UI `base-nova` template. Product shells compose its generated Button/Input/Input Group/Textarea primitives instead of growing one-off control wrappers.
- Desktop transcript data uses Core's exported `MessageEntry` shape across the preload boundary. View-only prop types live in one shared view-model module; components do not redeclare local message types.

This is a demo composition, not a new architecture mandate: a production multi-client host can still expose the same Core through `protocol`/`server`. The Electron app keeps the loop out of the renderer without requiring a localhost HTTP server for one local window.

---

## Decision 2026-08-12 — Monorepo cut landed; auth copies Pi syntax; @june/demo; no Effect

### What landed (in-repo, verified live)

Turborepo + pnpm workspace cut, opencode2-style layout, no build step (Node 24 type stripping; package `exports` point at `./src/index.ts`):

| Package | Contents |
|---|---|
| `@june/schema` | Responses wire item types (June parts adapt from these later) |
| `@june/ai` | Auth blocks + provider blocks + streamed Responses client |
| `@june/core` | `openSession` (JSONL), `runAgent` loop, `bashTool` — loop cluster remains independent of providers and sessions; session composed in by the caller (core ↛ harness rule holds) |
| `@june/demo` | `june login/logout/status/run` CLI — the funnel's first client |

Verified live over the codex backend: `gpt-5.6-luna` medium, full loop (`user → function_call → function_call_output → message`), streamed deltas, bash round trip.

### Auth: copy Pi's syntax, not OpenCode's

Pi wins the steal (`pi-ai` `dist/auth/*`): the interfaces are small functions with explicit adapters — exactly the Lucia/Arctic posture. Copied shapes, near-verbatim:

- `ModelAuth { apiKey?, headers?, baseUrl? }` — "if it can't be expressed as these three, it's provider config, not auth". The credential decides the transport.
- `Credential = ApiKeyCredential | OAuthCredential` — one type-tagged credential per provider; the auth.json shape.
- `CredentialStore { read, list, modify, delete }` — **`modify` is the only write path** (serialized read-modify-write); refresh runs inside `modify` so concurrent requests cannot double-refresh a rotated token.
- `AuthInteraction { signal, prompt(AuthPrompt), notify(AuthEvent) }` — **this is the whole GUI/CLI login funnel contract.** Flows call `prompt`/`notify`; the CLI prints and reads lines, a GUI opens windows — same flow code. `AuthPrompt.signal` lets a `manual_code` prompt race the localhost callback server and lose gracefully.
- `ApiKeyAuth { name, login?, resolve }` / `OAuthAuth { name, isSubscription?, login, refresh, toAuth }` / `ProviderAuth { apiKey?, oauth? }` — the refresh/toAuth split keeps the locked-refresh pattern in resolution, not in each provider.
- `resolveProviderAuth`: stored credential owns the provider; env consulted only when nothing stored; 5-min min validity.

June deviations from pi (recorded): `toAuth` returns the `chatgpt-account-id` header directly (pi re-derives it in the API layer from the JWT); `AuthContext` trimmed to an `env` function.

### openai-codex provider facts (hard-won wire notes)

- OAuth: `auth.openai.com`, PKCE S256, loopback `localhost:1455/auth/callback` racing manual paste; device-code flow (`/api/accounts/deviceauth/*`) for headless boxes like this one.
- Requests: `https://chatgpt.com/backend-api/codex/responses`, `OpenAI-Beta: responses=experimental`, `chatgpt-account-id` header, `store:false, stream:true`, `include:["reasoning.encrypted_content"]`, own `instructions` string passes through fine (pi does the same).
- **Quirk:** the codex backend sends `output: []` on `response.completed` — output items must be collected from `response.output_item.done` events (platform API emits those too, so collect uniformly).
- Backend-served models on this box today: `gpt-5.6-{sol,terra,luna}`, `gpt-5.5`, `gpt-5.4(-mini)`, `gpt-5.3-codex-spark`. Default: **`gpt-5.6-luna` @ medium** (cheap test loops; matches the backend's own default effort for luna).

### `@june/demo` (new package, deliberate non-OpenCode name)

Demo grows in lockstep with core — every core block lands with the demo composition that proves it feels good (shadcn "registry demos teach composition" bet, now enforced by the repo layout). Today it is the funnel's CLI client + the coding-agent run; it becomes the composition site each new block must not make ugly. `cli` stays reserved for the real product CLI later.

### Decision: no Effect v4 in June (June stays pure TypeScript, pi-style)

The A/B was live: pi = pure TS, opencode2 = Effect v4. June follows pi. Reasons:

1. **Distribution kills it.** June's bet is shadcn-style copy-paste blocks + "agents glue blocks well when docs are sharp". An Effect block is not copy-pastable into a non-Effect app: `Effect<A, E, R>` infects every signature and forces the consumer's whole call graph into the runtime. Owned-source distribution and a framework runtime are structurally at odds.
2. **The contract is the wire, not the runtime.** Multi-client (incl. Swift) means the stable surface is `schema`/`protocol` HTTP+SSE. Effect's benefits (typed errors, Layers, structured concurrency) never reach that surface; its costs reach every contributor and every pasted block.
3. **Pi proves plain TS carries the hard parts.** The credential store's serialized `modify`, refresh-under-lock, and signal-racing prompts are exactly the patterns people cite Effect for — pi expresses them in small interfaces we copied in an afternoon.
4. **Blueprint priors already point here:** Lucia/Arctic small functions, "no hidden global framework magic", "if a knobs list needs a glossary, it failed the Pi test". Effect is a glossary.

Costs accepted (eyes open): no typed error channel (mitigate: pi-style tagged error codes at the protocol boundary), no Layer DI (mitigate: explicit adapter params — already the posture), no structured concurrency (mitigate: `AbortSignal` everywhere, as the auth flows already do), and losing 1:1 crib-ability of opencode2's Effect-shaped server internals (their *shapes* still transfer; their code never did — handwritten rule).

Escape hatch, narrow: if `@june/server` internals someday genuinely want Effect for runtime composition, that stays an implementation detail behind the protocol — it must never appear in `schema`, `protocol`, `ai`, or `core` public types. Default remains no.

### Box ops note

mise re-provisioned pnpm on 2026-08-12 and left binaries without exec bits (`pnpm`, tsgolint, the tsc native binary) — `chmod +x` + `mise reshim` fixes it if it recurs.

---

## Decision 2026-08-12 — New pi harness adopted directly; no old session model

Daniel: adopt pi's **new** AgentHarness idea today — pi carries a back-port for its old stack; June has no users and keeps no compatibility layer. The old JSONL-transcript session and the light `Agent` wrapper are **removed**, not wrapped.

### What `@june/core` is now

- `agent-loop.ts` — standalone Pi-structured loop; public contracts, Responses-wire substitutions, `EventStream`, and result helpers live in dedicated leaf files. The provider adapter remains `stream-fn.ts`, outside that cluster, and every composition passes its `StreamFn` explicitly—June does not copy Pi's process-global default registry. The loop remains independent of providers and sessions (steering/follow-up drain modes, sequential/parallel batches, before/after hooks, fail-all on `length`, prepareNextTurn).
- `harness/` — the only composition over the loop, on pi's new durability model:
  - **Storage contract** (`harness/session/types.ts`, from pi `harness/session/types.d.ts`): write-once **entry tree** (parentId linkage; lane pointers name leaves) + append-only **records ledger** (operation_started/finished, step_attempt, tool_started, queue_enqueued/cancelled, abort_requested, usage) + facts, all ordered by one total `seq`. SQLite is the shipped backend, with one writer lease per session; JSONL and Durable Object adapters remain future implementations of the same contract.
  - **Effect sandwich**: `tool_started` intent (with a provisioned settlement-entry id and a `replay: "never" | "safe"` policy per tool) commits before the tool runs; the settlement is the `function_call_output` entry at that id. `step_attempt` brackets assistant streaming; `operation_started/finished` bracket runs.
  - **Crash resume**: `findOpenOperations` on open → `resume()` settles unsettled intents (safe → re-execute; never → error entry telling the model to re-issue), then continues the loop from the durable branch. Queues are records, so steer/followUp survive crashes too.
  - Result-typed rejections (`LaneBusy`, `NoActiveRun`, `NothingToResume`, `Closed`) via pi's `Result`/`TaggedError`.
- Scope held to the smallest end-to-end slice: one lane ("main"), run operations only. Deferred (compose onto the same log later, no schema change): multiple lanes, compaction, branch navigation/fork, skills/templates, deferred-suspend, manual action stepping (`peekAction`/`executeAction`), labels/stats.
- The harness drives `runAgentLoop` through the loop's hook surface (per the locked ch.1 rule) — note pi's current dist reducer no longer imports the loop; June keeps the one-way rule anyway because it holds the loop standalone.

### Known gap — durable cross-agent communication

Arbitrary `AgentTool` composition is not durable sub-agent support. A host can create a second `AgentHarness` inside a tool and await it, but the current one-lane, inline-tool harness has no persisted parent/child causality, directed mailbox, deliberate suspension/wake, or externally settled tool result. It keeps the parent process hot and leaves crash recovery to product-specific code.

The smallest Core additions are:

1. **Addressable durable run + mailbox** — a language-neutral `RunRef { sessionId, lane, runId }`, a persisted parent-tool-call → child-run link, and idempotent directed message admission. Model-visible `delegate`, `send`, and `wait` remain ordinary tools over this primitive.
2. **Deferred tool settlement + wake** — a tool resolves as completed or suspended on a `RunRef`. Core persists the suspension, releases the hot parent loop, then settles the already-provisioned result entry exactly once when the child completes and resumes the parent. The same mechanism serves approvals and external wakes.

Grok Bot's installed host is a useful interaction reference, not a sufficient durability model. Its `SendToAgent` tool acknowledges immediately, writes sender/receiver transcript mirrors tagged with the peer, records a conversation-partner edge, and schedules a hidden `[agent]` wake turn on a serialized agent lane. Priority delivery may interrupt agent work but not a user turn. Its pending inbound mailbox is an in-memory map, however, so a crash can lose an admitted message before the receiver transcript entry exists. June should retain the asynchronous messaging and hidden-wake semantics while putting admission in the durable session log.

Cross-agent invariants:

- Persist the parent link before child admission; derive the admission idempotency key from the parent session, run, and tool call.
- Restarting at any boundary creates at most one child and at most one parent settlement.
- Store child completion before waking the parent; never wake on uncommitted output.
- Directed messages survive restart and are admitted once at a safe child boundary.
- Linked-run lifecycle and messages use stable IDs/cursors in the session log and protocol so reconnecting clients reconstruct them without renderer state.
- Prove crashes after link/before admission, during child work, after child completion/before parent settlement, and after settlement/before parent continuation.

### Verified live on the box

Print run over the codex backend produced the exact pi-shaped ledger (1 operation_started, 3 step_attempts, 2 tool intents, usage per step, 1 operation_finished). Crash drill: SIGKILL mid-`bash` left an open operation with an unsettled `replay: never` intent; `--resume` settled it with an interruption error, the model saw it, chose to re-run the command itself, and both the resumed run and a follow-up prompt completed. TUI (OpenTUI/Bun) boots and streams on the same harness.

### Ops note

Round-2 working-tree files (tool ports, loop, TUI) were discarded by a reset/pull before commit; they were recovered mechanically from session transcripts (Write/Edit tool-call extraction). Shell-applied fixes are not in transcripts — after any such recovery, re-run `pnpm check` and expect to re-fix small lint items.

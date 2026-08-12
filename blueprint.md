# June blueprint

Living brainstorm notes. Not a finished plan. Goal: shape an engineer prompt.

Updated: 2026-08-12

> Brain dump. Grow freely. Honk = flaw exhibit, not a product requirement.

---

## Thesis (Daniel)

June is a **new, independent core for building cross-platform agentic UI**, distributed like shadcn: copy-pastable, composable source primitives. It should be able to **replace Honk Core** (`@honk/core`) as a drop-in host for Core+Clients products. It is not a Honk fork.

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

| Piece | Can be local | Can be cloud |
| --- | --- | --- |
| GUI client | yes | (web) |
| Session / conversation store | yes | yes |
| Model calls | via proxy | via proxy |
| Tools / FS / shell | bound to a host | bound to a VM |

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

| Concern | Pi | Flue | OpenCode | June target? |
| --- | --- | --- | --- | --- |
| Durable session / crash resume | Harness spec strong | Durable streams / DO | Sessions + server; less formal than Pi harness | Steal Pi model |
| Local tool host (FS/shell/LSP) | CLI/SDK local | Sandboxes (often remote/CF) | First-class local server | Must |
| Cloud deploy | DIY | First-class | Secondary | Optional same protocol |
| Typed client SDK for UI | Weak / RPC | `@flue/sdk` + React | `@opencode-ai/sdk` + OpenAPI | Must (OpenCode-shaped) |
| Web chat UI | No | React hooks excellent | Web exists; desktop/TUI primary | Demo |
| Desktop / Cursor-like GUI | No | No | Desktop beta | **Primary demo** |
| Progressive skills | Skills/extensions | Skills | Agents/commands/MCP | Yes (Linear-style events) |
| Mid-run approvals | Extension territory | App-level | Permissions API in server | First-class UI events |
| Parts-based messages | Messages/events | Flue parts | Message + Part types | Shared part model |
| Multi-client same session | RPC/modes | observe() many clients | TUI + IDE + desktop on one server | Must |

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

## Draft engineer prompt

(still empty — fill after we talk through the bets and demos)


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

### Skills
Agent Skills SKILL.md; progressive disclosure; workspace `.agents/skills/`

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
5. Location = workspace service scope, not ambient cwd

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

## Synthesis for engineer prompt (still drafting)

June delivers:

1. **Host protocol** inspired by OpenCode v2 (HttpApi-shaped, admit/pending/events/permissions/parts)
2. **Durable session/ops** inspired by Pi's *ideas* (handwritten; not their package)
3. **Deploy/embed story** inspired by Flue (conversation streams, optional cloud target) without requiring Flue
4. **GUI demos:** Cursor-like desktop client + cloud-agent UI, both speaking the same protocol to different tool hosts



---

## Daniel notes (2026-08-11 evening)

OpenCode having a real **core** + **desktop app** is good. That is why we looked at it and used it once.

Gaps we care about vs that core:

- Not durable / configurable enough in the Pi sense
- Customizing the system prompt is **easy in Pi**, **hard in OpenCode's new core**
- We want Pi-level steerability (SYSTEM.md / append / resources / hermetic config) without giving up OpenCode's client/server + GUI kit

### Honk as lived experiment (`~/Developer/honk`)

Honk already ran this A/B in production code:

| When | Move |
| --- | --- |
| Mid-2026 | Core rewrite cutover (ADR 0011): multi-harness Core (pi / Claude / Cursor), HTTP+SSE SDK, desktop host |
| ~Jul 29 | OpenCode-only cutover (`replace Core v1 with OpenCode SDK`, `OpenCode-only cutover`) — sidecar / packages/opencode era |
| **Aug 11, 2026** | **`cut over chat, composer, and runtime off OpenCode`** → owned chat stack on **Pi AgentHarness** host (`@honk/core`) |

Current `spec/core.md` thesis (working draft):

1. One host process, one writer lease
2. Every session contains a real Pi `AgentHarness` (do not copy session model into a second Honk model)
3. Workspace trust is the **only** permission gate (YOLO after trust)
4. Clients reload Pi session data and render messages themselves
5. Host keeps running across UI reloads

Honk Core does **not** depend on `pi-coding-agent` / `pi-tui`. It constructs `AgentHarness` with `systemPrompt`, tools, resources, models, JSONL repo.

What Honk still steals from OpenCode (even after leaving it):

- Message snapshots / per-turn git checkpoints (refs/honk/checkpoints/…)
- Per-file restore grain for undo
- Websearch tool design notes
- Earlier: "part opencode, part t3code" multi-harness idea (ADR 0006) — later simplified toward Pi-native

Why Pi hermetic config mattered (ADR 0017, historical): Honk runs Pi under `HONK_HOME/harness/pi`, not `~/.pi/agent`, so user Pi extensions/settings cannot fight Honk or execute unowned code in-process. Project AGENTS.md/skills still load from cwd.

### Lesson for June

The OpenCode **shape** (core host + desktop/web clients + typed protocol) is right.
The OpenCode **configurability / durability / prompt ownership** is why Honk bounced back to Pi.

June should aim for:

- OpenCode-like: core process, desktop GUI, multi-client protocol
- Pi-like: AgentHarness durability, trivial system prompt / resources / skills ownership, hermetic but user-overridable config surfaces
- From the Honk flaw exhibit: do not maintain two session models; trust gate once; handwritten harness; steal OpenCode checkpoint *ideas*



---

## Independence + Honk replaceability (Daniel, continued)

June is a **new, fully independent** project. Not a Honk fork. Not a rename.

Success criterion for the core: **easily replace `@honk/core`**. Honk (or anything with that Core+Clients shape) should be able to swap its host for June Core without rewriting the product chrome from scratch.

Implications:

- Stable, boring client protocol (session CRUD, prompt/steer/queue/interrupt, reload/entries, events, permissions/trust, models)
- Pi-grade prompt/config ownership (system prompt, resources, skills) as first-class, not buried
- OpenCode-grade multi-client host (desktop/web/CLI attach to one core)
- No Honk-specific product names required in the core; Honk becomes one consumer

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

- Honk-replaceability wants a **stable protocol contract**
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

Honk is **not** a customer June must satisfy. It is a demonstration of how a core (ours / prior attempts) develops flaws: OpenCode cutover, dual models, prompt ownership pain, bounce back to Pi. Use it as a cautionary exhibit, then move on.



---

## Hard rule: handwritten

**Everything is handwritten.** June does not reuse or wrap another project's harness (not Pi AgentHarness, not OpenCode core, not Flue runtime) as the implementation.

References are for **ideas and critique only**:

- steal vocabulary / lessons (admit/pending, effect sandwich, parts, client/server cut)
- do not `import` their harness as June's brain
- do not say "sit on Pi" or "embed OpenCode" in the engineer prompt

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
8. **Workspace / Location** scope (cwd or workspace id, not ambient global)
9. **Identity & ACL** for product agents (Notion/Linear-shaped)
10. **Triggers & schedules** for autonomous Custom-Agent-shaped runs
11. **Checkpoints / revert** for coding-agent-shaped undo
12. **Multi-client** same session (desktop + web + mobile observe)
13. **Pluggable tool host placement** (this machine vs cloud VM)
14. **Connectors / MCP** as tool sources without baking one product's ontology in

### Implication

Demos are not side quests. Each demo proves a slice of that checklist.

- shadcn chat → 1–4, 12
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
- Most Cursor-like IDE chrome (file tree layout, pixel mimic)
- Chat hooks / scrollers / bubbles (shadcn, AI SDK UI territory)

**Core-side (in scope):**
- Harness + host + sessions + parts/events + tools + prompt/skills ownership + triggers + ACL **data**
- Approval **policy** and pause/resume (can a tool run yet?) — not the card
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
| Permission / disclosure **chrome** | no | yes |
| Approval **policy** + pause before tool runs | yes (v7 `toolApproval`-shaped) | no |
| Progressive disclosure **presentation** | no (may expose catalogs) | yes |
| Parts / stream protocol | yes | consumes |
| Chat scroller / bubbles / Cursor shell | no | yes |
| Instructions / skills ownership | yes | configures via protocol |
| Triggers / ACL data / tool host placement | yes | configures / displays |

Litmus aligned with v7: **pixels and human prompts = UI**; **loop, tools, policies, durable state, wire parts = core**.



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

`sdk.session` / workspace-shaped APIs are **local host control planes**. AI SDK gave streaming chat + tool loops; it did not give a durable, attachable, multi-client coding host over the files on disk.

### June takeaway

- Steal OpenCode's **host + session + workspace protocol** idea (handwritten).
- AI SDK may help **UI demos** or model plumbing later; it is not a substitute for June Core.
- Do not design June as "useChat + tools" and hope workspace falls out.

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
  host: localHost({ cwd }),
  log: pinoLogger(),
  providers: [anthropic, openai],
  tools: [fsTools, gitTools],
});
```

Cloudflare is one block (`host` / `store`), not a fork of June.

### Fit with shadcn distribution

- Blocks are copy-pastable **or** tiny packages — either way, user owns the composition site
- Registry demos show recommended assemblies (chat, desktop shell, cloud host)
- Agents glue blocks well when docs are sharp (Hashimoto's point)

### Fit with handwritten rule

We handwrite the blocks. We do not wrap Pi/OpenCode as the composition. Their *ideas* inform the shapes of the blocks.

---

## Package layout (OpenCode naming) — LOCKED

Daniel's preference is to follow the OpenCode v2 package names under the `@june/*` scope.

The v0 packages are:

- `@june/schema` — parts, messages, events
- `@june/protocol` — host API surface
- `@june/core` — session, loop, and composition. The Pi-simple harness lives here, not in an `agent-core` package.
- `@june/server` — local HTTP host
- `@june/client` — typed TypeScript client
- `@june/ai` — providers
- `@june/util` — helpers

Law: clients talk to schema and protocol only. They never depend on core or server internals.

Store, log, and host swaps are adapters composed into core and server. Do not invent packages such as `@june/host-local` for them.

Decision 2026-08-12: the `@june/core` name is locked. It contains the Pi-simple harness and a pluggable session backend.

---

## Multi-client protocol (Daniel, 2026-08-12)

OpenCode v2's server is efficient because adding clients in another language does not require rewriting the API. June has the same hard goal. Any client, including native Swift apps for iOS and macOS, must be able to implement the protocol.

Prefer a language-neutral wire protocol: OpenAPI over HTTP, with SSE for events. `@june/client` is the TypeScript SDK, not the protocol itself. Native apps bind the same protocol directly.

The host API must not assume a React or TypeScript UI.

---

## Local box workspace notes (2026-08-12)

The working copy lives on the sidekick computer at `~/Developer/june`.

Tooling on that box:

- Ghostty terminal
- VSCodium editor
- Node 24 through mise
- pnpm 11
- `claude`, `codex`, `pi`, and `agent` CLIs. `agent` is Cursor.

Codex CLI is signed in there. GitHub CLI device login rate-limits on that box.


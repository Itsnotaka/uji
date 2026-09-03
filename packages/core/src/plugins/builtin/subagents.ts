/**
 * The subagents builtin: it turns the `agents` registry into the one thing a
 * calling agent needs to delegate, the `task` tool. There is no separate
 * subagent type; a subagent is any declared agent a parent is allowed to
 * invoke. The tool's description enumerates exactly those, so a model learns it
 * can delegate the same way it learns of any tool. Argued in design.mdx,
 * "Agents".
 *
 * This plugin owns awareness and invocation shape. Running the child is the
 * host's job (it holds the store and composes runners), so the host injects
 * `SubagentHost`. Foreground is background plus a wait (design.mdx,
 * "Subagents are child sessions"): `execute` admits the child and either
 * settles immediately (`background`) or throws `ToolWait`; `wake`
 * settles the reserved result from the child's durable outcome on whichever
 * host observes the completion.
 */
import { createHash } from "node:crypto";
import { Unsafe } from "typebox";
import { ToolWait } from "../../types.ts";
import type { AgentTool, AgentToolResult, ToolWake } from "../../types.ts";
import { toolResultContent } from "../../utils/tool-result.ts";
import { definePlugin, type Agent } from "../types.ts";

const SUBAGENTS_PLUGIN_ID = "subagents";
export const TASK_ACTION = "task";

/** What `task` settles into `details`, so any client renders the delegation without the plugin. */
export interface TaskDetails {
  readonly agent: string;
  readonly childSessionId: string;
  readonly state: "running" | "completed" | "aborted" | "failed";
}

/**
 * A deterministic id from the delegation triple, so a retried spawn converges
 * on the same child, the same declaration, the same prompt (design.mdx,
 * "Agents": "both directions derive ids from one triple").
 */
export function deriveTaskId(prefix: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${prefix}_task_${hash.slice(0, 16)}`;
}

/** One delegation to admit. The parent link and idempotency are the host's to derive. */
export interface SubagentSpawnRequest {
  readonly agent: string;
  readonly prompt: string;
  readonly toolCallId: string;
}

export interface SubagentSpawnResult {
  readonly details: TaskDetails;
  /** Present when the spawn was refused (depth); what the model reads. */
  readonly text?: string;
}

/** A waiting `task` call, identified by what the wake can derive ids from. */
export interface SubagentCall {
  readonly runId: string;
  readonly toolCallId: string;
}

export interface SubagentPollResult {
  readonly details: TaskDetails;
  /** The child's final assistant text once terminal. */
  readonly text?: string;
}

/**
 * The completion nudge a host admits into the parent when a child reaches its
 * terminal record while the parent's call is still waiting. Model-invisible
 * (custom entries never enter context) and content-free on purpose: the wake
 * reads the child's log, so the nudge only has to be admission.
 */
export const TASK_SETTLED_CUSTOM_TYPE = "task_settled";

/**
 * What the host wires under the `task` tool. Every verb derives the child
 * from the (parent session, run, call) triple, so nothing carries state
 * between execute and wake but durable ids.
 */
export interface SubagentHost {
  /** Ensure the child session, its declaration, its prompt, and its runner exist. */
  spawn(request: SubagentSpawnRequest): Promise<SubagentSpawnResult>;
  /** The child's current outcome, `running` while it still runs. */
  poll(call: SubagentCall): Promise<SubagentPollResult>;
  /** Propagate a parent abort as the child's own durable abort. */
  abort(call: SubagentCall): Promise<void>;
}

export interface SubagentsOptions {
  /**
   * Injected by the host because the plugin holds no store. Omitted, the
   * `task` tool reports that this host cannot delegate, which is the honest
   * answer, not an error (design.mdx invariant 21).
   */
  readonly host?: SubagentHost;
}

/**
 * The agents a parent may hand a prompt: not withheld by `mode: "primary"`,
 * not `hidden`, and not `disabled`. Pure, so a test asserts the menu directly.
 */
export function invokableAgents(agents: readonly Agent[]): readonly Agent[] {
  return agents.filter(
    (agent) => agent.disabled !== true && agent.hidden !== true && agent.mode !== "primary",
  );
}

/** The `task` tool's description: a header plus one line per invokable agent. Pure. */
export function buildTaskDescription(agents: readonly Agent[]): string {
  const lines = agents.map((agent) => `- ${agent.id}: ${agent.description ?? "(no description)"}`);
  return [
    "Delegate a task to a specialized agent that runs in its own session and",
    "returns a final result. Pick the agent whose description best fits the task.",
    "",
    "Available agents:",
    ...lines,
  ].join("\n");
}

function taskTool(
  agents: readonly Agent[],
  host: SubagentHost | undefined,
): AgentTool<ReturnType<typeof taskParameters>, TaskDetails> {
  const ids = agents.map((agent) => agent.id);
  const wake: ToolWake = async (wait, context) => {
    // Degraded host (invariant 21): without the injection nothing can settle
    // here; another host may hold it, and abort remains the exit.
    if (host === undefined) return { kind: "wait" };
    const call: SubagentCall = {
      runId: wait.runId,
      toolCallId: wait.toolCallId,
    };
    if (context.aborted) {
      await host.abort(call);
      const polled = await host.poll(call);
      return {
        kind: "settle",
        isError: true,
        result: {
          content: toolResultContent("Task aborted."),
          details: { ...polled.details, state: "aborted" },
          title: polled.details.agent,
        },
      };
    }
    const polled = await host.poll(call);
    if (polled.details.state === "running") return { kind: "wait" };
    return {
      kind: "settle",
      isError: polled.details.state !== "completed",
      result: {
        content: toolResultContent(
          polled.text ?? `Subagent run ${polled.details.state} without a result.`,
        ),
        details: polled.details,
        title: polled.details.agent,
      },
    };
  };
  return {
    name: TASK_ACTION,
    description: buildTaskDescription(agents),
    parameters: taskParameters(ids),
    prepareArguments: (args) => parseTaskInput(args, ids),
    replay: "never",
    wake,
    async execute(toolCallId, params): Promise<AgentToolResult<TaskDetails>> {
      if (host === undefined) {
        throw new Error("This host cannot run subagents.");
      }
      const spawned = await host.spawn({
        agent: params.agent,
        prompt: params.prompt,
        toolCallId,
      });
      if (spawned.details.state === "failed") {
        return {
          content: toolResultContent(spawned.text ?? "Delegation was refused."),
          details: spawned.details,
          title: params.agent,
        };
      }
      if (params.background === true) {
        return {
          content: toolResultContent(
            `Task started in session ${spawned.details.childSessionId}. ` +
              "Its completion will arrive as a message.",
          ),
          details: spawned.details,
          title: params.agent,
        };
      }
      // Foreground is background plus a wait: the child is durable, the
      // parent parks, and `wake` settles from the child's terminal record.
      throw new ToolWait();
    },
  };
}

interface TaskInput {
  agent: string;
  prompt: string;
  background?: boolean;
}

function taskParameters(ids: readonly string[]) {
  return Unsafe<TaskInput>({
    type: "object",
    properties: {
      agent: { type: "string", enum: [...ids], description: "The agent to delegate to." },
      prompt: {
        type: "string",
        description: "The task, with all context the agent needs; it sees no prior conversation.",
      },
      background: {
        type: "boolean",
        description:
          "Do not wait: settle immediately with the child session id and continue. " +
          "The task's completion arrives later as a message.",
      },
    },
    required: ["agent", "prompt"],
  });
}

function parseTaskInput(args: unknown, ids: readonly string[]): TaskInput {
  if (typeof args !== "object" || args === null) {
    throw new Error("Invalid arguments: expected an object with agent and prompt");
  }
  const agent = "agent" in args ? args.agent : undefined;
  const prompt = "prompt" in args ? args.prompt : undefined;
  const background = "background" in args ? args.background : undefined;
  if (typeof agent !== "string" || !ids.includes(agent)) {
    throw new Error(`Invalid arguments: agent must be one of ${ids.join(", ")}`);
  }
  if (typeof prompt !== "string") {
    throw new Error("Invalid arguments: prompt must be a string");
  }
  if (background !== undefined && typeof background !== "boolean") {
    throw new Error("Invalid arguments: background must be a boolean");
  }
  return background === undefined ? { agent, prompt } : { agent, prompt, background };
}

/**
 * Contributes the `task` tool, projected from the `agents` registry every
 * rebuild. `agents` rebuilds before `tools`, so this reads the current set. If
 * nothing is invokable, no tool is contributed: a caller never sees a
 * capability it does not have.
 */
export function subagentsPlugin(options: SubagentsOptions = {}) {
  return definePlugin({
    id: SUBAGENTS_PLUGIN_ID,
    session(api) {
      api.tools.add((draft) => {
        const invokable = invokableAgents(api.agents.list());
        if (invokable.length === 0) return;
        draft.set(TASK_ACTION, taskTool(invokable, options.host));
      });
    },
  });
}

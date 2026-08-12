import { streamResponses } from "@june/ai";
import type { ModelAuth, Provider, ReasoningEffort } from "@june/ai";
import type { ToolDefinition } from "@june/schema";
import type { Session } from "./session.ts";

export interface AgentTool {
  definition: ToolDefinition;
  run(args: string): Promise<string> | string;
}

export interface RunAgentOptions {
  provider: Provider;
  auth: ModelAuth;
  model?: string;
  effort?: ReasoningEffort;
  systemPrompt: string;
  tools: AgentTool[];
  session: Session;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onToolCall?: (name: string, args: string) => void;
}

/**
 * Minimal agent loop: stream a turn, append output items to the session, run
 * any tool calls, repeat until the model stops calling tools.
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { provider, session } = options;
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  for (;;) {
    const output = await streamResponses({
      auth: options.auth,
      api: provider.api,
      baseUrl: provider.baseUrl,
      model: options.model ?? provider.defaultModel,
      effort: options.effort ?? provider.defaultEffort,
      instructions: options.systemPrompt,
      input: session.items,
      tools: options.tools.map((tool) => tool.definition),
      sessionId: session.id,
      signal: options.signal,
      onTextDelta: options.onTextDelta,
    });
    let done = true;
    for (const item of output) {
      session.push(item);
      if (item.type === "function_call" && item.call_id !== undefined) {
        done = false;
        const name = item.name ?? "";
        const args = item.arguments ?? "{}";
        options.onToolCall?.(name, args);
        const tool = tools.get(name);
        const result = tool === undefined ? `Unknown tool: ${name}` : await tool.run(args);
        session.push({ type: "function_call_output", call_id: item.call_id, output: result });
      }
    }
    if (done) return;
  }
}

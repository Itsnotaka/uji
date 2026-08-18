/** Responses-wire adaptations used at the agent-loop boundary. */

import type { ToolDefinition } from "@june/schema";
import type { AgentMessage, AgentToolCall, AnyAgentTool, AssistantTurn } from "./types.ts";

export function isAssistantMessage(item: AgentMessage | undefined): boolean {
  if (!item) return false;
  if (item.role === "assistant") return true;
  return item.type === "message" || item.type === "reasoning" || item.type === "function_call";
}

export function toToolDefinition(tool: AnyAgentTool): ToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function getToolCalls(turn: AssistantTurn): AgentToolCall[] {
  return turn.items.flatMap((item) => {
    if (item.type !== "function_call" || item.call_id === undefined) return [];
    return [
      {
        id: item.call_id,
        name: item.name ?? "",
        arguments: item.arguments ?? "{}",
      },
    ];
  });
}

export function decodeToolArguments(toolCall: AgentToolCall): unknown {
  return JSON.parse(toolCall.arguments || "{}") as unknown;
}

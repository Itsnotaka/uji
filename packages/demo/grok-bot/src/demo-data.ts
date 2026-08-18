// Transitional re-export while renderer components migrate to agents.ts; delete with
// view-model.ts once every import points at the domain module.
export { agentById, type Agent, type AgentId } from "./agents.ts";

import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isAgentTone, type Agent, type AgentId } from "../agents.ts";

export class AgentProfileRepo {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS demo_agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        instructions TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID
    `);
    const columns = new Set(
      this.database
        .prepare("SELECT name FROM pragma_table_info('demo_agent_profiles')")
        .all()
        .map((row) => row["name"]),
    );
    if (!columns.has("avatar")) {
      this.database.exec(
        "ALTER TABLE demo_agent_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT 'neutral'",
      );
    }
    if (!columns.has("created_at")) {
      this.database.exec(
        "ALTER TABLE demo_agent_profiles ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  list(): Agent[] {
    return this.database
      .prepare(
        "SELECT id, name, role, instructions, avatar FROM demo_agent_profiles ORDER BY created_at, id",
      )
      .all()
      .map(agentFromRow)
      .filter((agent): agent is Agent => agent !== null);
  }

  insert(agent: Agent): void {
    const now = Date.now();
    this.database
      .prepare(`
        INSERT INTO demo_agent_profiles (id, name, role, instructions, avatar, updated_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(agent.id, agent.name, agent.role, agent.instructions, agent.avatar, now, now);
  }

  update(agent: Agent): void {
    this.database
      .prepare(`
        UPDATE demo_agent_profiles
        SET name = ?, role = ?, instructions = ?, avatar = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(agent.name, agent.role, agent.instructions, agent.avatar, Date.now(), agent.id);
  }

  delete(id: AgentId): void {
    this.database.prepare("DELETE FROM demo_agent_profiles WHERE id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }
}

function agentFromRow(row: Record<string, SQLOutputValue>): Agent | null {
  const { id, name, role, instructions, avatar } = row;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof role !== "string" || typeof instructions !== "string") return null;
  return { id, name, role, instructions, avatar: isAgentTone(avatar) ? avatar : "neutral" };
}

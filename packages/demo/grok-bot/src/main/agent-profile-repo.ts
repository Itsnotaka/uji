import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent } from "../demo-data.ts";

interface ProfileRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
}

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
  }

  list(defaults: readonly Agent[]): Agent[] {
    const rows = this.database
      .prepare("SELECT id, name, role, instructions FROM demo_agent_profiles")
      .all() as unknown as ProfileRow[];
    const stored = new Map(rows.map((row) => [row.id, row]));
    return defaults.map((fallback) => {
      const profile = stored.get(fallback.id);
      if (profile === undefined) return { ...fallback };
      return {
        ...fallback,
        name: profile.name,
        role: profile.role,
        instructions: profile.instructions,
      };
    });
  }

  save(agent: Agent): void {
    this.database
      .prepare(`
        INSERT INTO demo_agent_profiles (id, name, role, instructions, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          role = excluded.role,
          instructions = excluded.instructions,
          updated_at = excluded.updated_at
      `)
      .run(agent.id, agent.name, agent.role, agent.instructions, Date.now());
  }

  close(): void {
    this.database.close();
  }
}

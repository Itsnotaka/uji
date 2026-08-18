import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isAgentTone, type Agent, type AgentId } from "../agents.ts";

interface ProfileRow {
  id: string;
  name: string;
  role: string;
  instructions: string;
  avatar: string;
}

const SEEDED_KEY = "agents_seeded";

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
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS demo_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    const columns = this.database
      .prepare("SELECT name FROM pragma_table_info('demo_agent_profiles')")
      .all() as unknown as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("avatar")) {
      this.database.exec(
        "ALTER TABLE demo_agent_profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT 'neutral'",
      );
    }
    if (!names.has("created_at")) {
      this.database.exec(
        "ALTER TABLE demo_agent_profiles ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  seedOnce(createSeed: () => Agent): void {
    const seeded = this.database
      .prepare("SELECT value FROM demo_meta WHERE key = ?")
      .get(SEEDED_KEY);
    if (seeded !== undefined) return;
    // Databases from before user-created agents may already hold edited profiles; keep them.
    const count = this.database
      .prepare("SELECT COUNT(*) AS count FROM demo_agent_profiles")
      .get() as unknown as { count: number };
    if (count.count === 0) this.insert(createSeed());
    this.database
      .prepare("INSERT INTO demo_meta (key, value) VALUES (?, '1')")
      .run(SEEDED_KEY);
  }

  list(): Agent[] {
    const rows = this.database
      .prepare(
        "SELECT id, name, role, instructions, avatar FROM demo_agent_profiles ORDER BY created_at, id",
      )
      .all() as unknown as ProfileRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      instructions: row.instructions,
      avatar: isAgentTone(row.avatar) ? row.avatar : "neutral",
    }));
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

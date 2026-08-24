import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class DesktopSettingsRepo {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec("PRAGMA busy_timeout=5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS demo_desktop_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID
    `);
  }

  get(key: string): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM demo_desktop_settings WHERE key = ?")
      .get(key);
    const value = row?.["value"];
    return typeof value === "string" ? value : undefined;
  }

  set(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO demo_desktop_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, Date.now());
  }

  close(): void {
    this.database.close();
  }
}

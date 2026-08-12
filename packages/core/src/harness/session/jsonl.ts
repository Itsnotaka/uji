/**
 * JSONL session backend (pi's jsonl store idea): one LogItem per line, replayed
 * into an in-memory index on open. Append-only; a single total `seq` orders
 * entries, records, lane moves, and facts.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionError,
  type Entry,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionRepo,
  type SessionStorage,
} from "./types.ts";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

interface MetaLine {
  kind: "meta";
  metadata: SessionMetadata;
}

export class JsonlSessionStorage implements SessionStorage {
  readonly file: string;
  private readonly metadata: SessionMetadata;
  private seq = 0;
  private readonly entriesById = new Map<string, Entry>();
  private readonly records: LaneRecord[] = [];
  private readonly lanes = new Map<string, string | null>();
  private readonly log: LogItem[] = [];
  private name: string | undefined;

  private constructor(file: string, metadata: SessionMetadata) {
    this.file = file;
    this.metadata = metadata;
  }

  static create(file: string, metadata: SessionMetadata): JsonlSessionStorage {
    const storage = new JsonlSessionStorage(file, metadata);
    const meta: MetaLine = { kind: "meta", metadata };
    writeFileSync(file, `${JSON.stringify(meta)}\n`);
    return storage;
  }

  static open(file: string): JsonlSessionStorage {
    let lines: string[];
    try {
      lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch (error) {
      throw new SessionError("not_found", `Cannot open session file: ${file}`, error as Error);
    }
    const head = lines[0] === undefined ? undefined : (JSON.parse(lines[0]) as MetaLine);
    if (head?.kind !== "meta") {
      throw new SessionError("storage", `Session file has no metadata header: ${file}`);
    }
    const storage = new JsonlSessionStorage(file, head.metadata);
    for (const line of lines.slice(1)) {
      storage.applyLogItem(JSON.parse(line) as LogItem);
    }
    return storage;
  }

  private applyLogItem(item: LogItem): void {
    this.seq = Math.max(this.seq, item.seq);
    this.log.push(item);
    if (item.kind === "entry") {
      this.entriesById.set(item.entry.id, item.entry);
    } else if (item.kind === "record") {
      this.records.push(item.record);
    } else if (item.kind === "lane") {
      this.lanes.set(item.lane, item.leafId);
    } else {
      this.name = item.name;
    }
  }

  private write(item: LogItem): void {
    this.applyLogItem(item);
    appendFileSync(this.file, `${JSON.stringify(item)}\n`);
  }

  getMetadata(): Promise<SessionMetadata> {
    return Promise.resolve(this.metadata);
  }

  appendEntry(entry: ProvisionedEntry, lane: string): Promise<Entry> {
    if (this.entriesById.has(entry.id)) {
      throw new SessionError("invalid_entry", `Entry id already exists: ${entry.id}`);
    }
    const full = {
      ...entry,
      parentId: this.lanes.get(lane) ?? null,
      seq: ++this.seq,
      timestamp: Date.now(),
    } as Entry;
    this.write({ kind: "entry", seq: full.seq, lane, entry: full });
    this.write({ kind: "lane", seq: ++this.seq, lane, leafId: full.id });
    return Promise.resolve(full);
  }

  appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
    const full = { ...record, seq: ++this.seq, timestamp: Date.now() } as unknown as TRecord;
    this.write({ kind: "record", seq: full.seq, record: full });
    return Promise.resolve(full);
  }

  getEntry(id: string): Promise<Entry | undefined> {
    return Promise.resolve(this.entriesById.get(id));
  }

  getLeafId(lane: string): Promise<string | null> {
    return Promise.resolve(this.lanes.get(lane) ?? null);
  }

  getBranch(lane: string): Promise<Entry[]> {
    const branch: Entry[] = [];
    let cursor = this.lanes.get(lane) ?? null;
    while (cursor !== null) {
      const entry = this.entriesById.get(cursor);
      if (entry === undefined) break;
      branch.push(entry);
      cursor = entry.parentId;
    }
    branch.reverse();
    return Promise.resolve(branch);
  }

  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]> {
    return Promise.resolve(
      this.records.filter(
        (record) =>
          record.type === query.type &&
          (query.runId === undefined ||
            ("runId" in record && record.runId === query.runId) ||
            record.id === query.runId) &&
          (query.afterSeq === undefined || record.seq > query.afterSeq),
      ) as Extract<LaneRecord, { type: K }>[],
    );
  }

  async findOpenOperations(lane: string): Promise<OperationStartedRecord[]> {
    const started = this.records.filter(
      (record): record is OperationStartedRecord =>
        record.type === "operation_started" && record.lane === lane,
    );
    const finished = new Set(
      this.records
        .filter((record) => record.type === "operation_finished")
        .map((record) => (record as { runId: string }).runId),
    );
    return started.filter((record) => !finished.has(record.id)).reverse();
  }

  getLog(options?: { afterSeq?: number }): Promise<LogItem[]> {
    const after = options?.afterSeq ?? -1;
    return Promise.resolve(this.log.filter((item) => item.seq > after));
  }

  getName(): Promise<string | undefined> {
    return Promise.resolve(this.name);
  }

  setName(name: string): Promise<void> {
    this.write({ kind: "fact", seq: ++this.seq, fact: "name", name });
    return Promise.resolve();
  }
}

/** Directory of session files: .june/sessions/<id>.jsonl */
export class JsonlSessionRepo implements SessionRepo {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  create(options?: { id?: string }): Promise<SessionStorage> {
    const id = options?.id ?? `${new Date().toISOString().replaceAll(":", "-")}-${newId("s")}`;
    return Promise.resolve(
      JsonlSessionStorage.create(join(this.dir, `${id}.jsonl`), { id, createdAt: Date.now() }),
    );
  }

  open(id: string): Promise<SessionStorage> {
    return Promise.resolve(JsonlSessionStorage.open(join(this.dir, `${id}.jsonl`)));
  }

  list(): Promise<SessionMetadata[]> {
    const ids = readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .sort();
    return Promise.resolve(ids.map((id) => ({ id, createdAt: 0 })));
  }
}

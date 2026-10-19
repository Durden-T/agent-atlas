import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { unknownUsage } from '../shared/contracts.ts';
import type {
  RepositoryRecord,
  RunRecord,
  EvidenceSnapshot,
  JudgmentResult,
} from '../shared/contracts.ts';

export type Database = DatabaseSync;
export const defaultDatabasePath = () =>
  join(homedir(), 'Library', 'Application Support', 'Agent Atlas', 'atlas.sqlite');
export function transaction<T>(db: Database, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = body();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function openDatabase(path = defaultDatabasePath()): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    // Recovery must hold sole database ownership for this connection's lifetime.
    db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    transaction(db, () => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS repositories(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(repository_id INTEGER REFERENCES repositories(id), key TEXT, data TEXT NOT NULL, PRIMARY KEY(repository_id,key));
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, repository_id INTEGER REFERENCES repositories(id), hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS judgments(id TEXT PRIMARY KEY, repository_id INTEGER REFERENCES repositories(id), run_id TEXT NOT NULL, cache_key TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, result TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS judgment_cache ON judgments(cache_key,state);
      CREATE TABLE IF NOT EXISTS overrides(repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS repository_folders(repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE, folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE, PRIMARY KEY(repository_id,folder_id));
      CREATE INDEX IF NOT EXISTS folder_members ON repository_folders(folder_id,repository_id);
      CREATE TABLE IF NOT EXISTS personal_state(repository_id INTEGER PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE, viewed INTEGER NOT NULL CHECK(viewed IN (0,1)));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_items(run_id TEXT REFERENCES runs(id),repository_id INTEGER REFERENCES repositories(id),state TEXT NOT NULL,candidate TEXT,PRIMARY KEY(run_id,repository_id));
      CREATE UNIQUE INDEX IF NOT EXISTS repository_inflight ON work_items(repository_id) WHERE state IN ('reading','prepared','calling');
      CREATE INDEX IF NOT EXISTS pending_work_by_repository ON work_items(repository_id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS pending_work ON work_items(state,repository_id);
      CREATE INDEX IF NOT EXISTS repository_state ON repositories(json_extract(data,'$.state'));
      CREATE INDEX IF NOT EXISTS repository_judgments ON judgments(repository_id);
      CREATE TABLE IF NOT EXISTS discovery_work(key TEXT PRIMARY KEY,data TEXT NOT NULL,visited INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS discovery_visit ON discovery_work(visited);
      `);
      const folderSchema = String(
        db.prepare("SELECT sql FROM sqlite_master WHERE name='folders'").get()?.sql,
      );
      if (!folderSchema.includes('AUTOINCREMENT'))
        db.exec(`
        CREATE TEMP TABLE folder_members_backup AS SELECT * FROM repository_folders;
        CREATE TABLE folders_next(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        INSERT INTO folders_next SELECT * FROM folders;
        DROP TABLE folders;
        ALTER TABLE folders_next RENAME TO folders;
        INSERT INTO repository_folders SELECT * FROM folder_members_backup;
        DROP TABLE folder_members_backup;
      `);
      if (
        !db
          .prepare('PRAGMA table_info(judgments)')
          .all()
          .some((row) => row.name === 'trace')
      )
        db.exec('ALTER TABLE judgments ADD COLUMN trace TEXT');
      db.exec('PRAGMA user_version=4');
      for (const row of db
        .prepare(
          "SELECT data FROM runs WHERE json_extract(data,'$.status') IN ('running','queued')",
        )
        .all()) {
        const run = JSON.parse(String(row.data)) as RunRecord;
        run.status = 'interrupted';
        run.endedAt = new Date().toISOString();
        run.stats.unknownRequests = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM judgments WHERE run_id=? AND state IN ('submitted','unknown')",
            )
            .get(run.id)?.n,
        );
        if (run.stats.unknownRequests > 0) Object.assign(run.stats, unknownUsage);
        db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
      }
      for (const row of db
        .prepare("SELECT DISTINCT repository_id FROM judgments WHERE state='submitted'")
        .all()) {
        const repo = getRepository(db, Number(row.repository_id));
        if (repo) {
          repo.state = 'unknown';
          repo.error = '上次请求结果未知，请明确重新判断后再发起付费请求';
          saveRepository(db, repo);
        }
      }
      db.exec(
        "UPDATE judgments SET state='unknown' WHERE state='submitted'; UPDATE judgments SET state='not_sent' WHERE state='prepared'; UPDATE work_items SET state='unknown' WHERE state='calling'; UPDATE work_items SET state='pending' WHERE state IN ('reading','prepared');",
      );
    });
    if (path !== ':memory:')
      for (const suffix of ['', '-wal', '-shm'])
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    return db;
  } catch (error) {
    db.close();
    if (error instanceof Error && 'errcode' in error && (Number(error.errcode) & 0xff) === 5)
      throw new Error('数据库正在被其他进程使用，请关闭重复启动的应用', { cause: error });
    throw error;
  }
}
export function getRepository(db: Database, id: number): RepositoryRecord | null {
  const row = db.prepare('SELECT data FROM repositories WHERE id=?').get(id);
  return row ? (JSON.parse(String(row.data)) as RepositoryRecord) : null;
}
export function saveRepository(db: Database, repo: RepositoryRecord): void {
  db.prepare(
    'INSERT INTO repositories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  ).run(repo.id, JSON.stringify(repo));
}
export function getEvidence(db: Database, id: string | null): EvidenceSnapshot | null {
  if (!id) return null;
  const row = db.prepare('SELECT data FROM evidence WHERE id=?').get(id);
  return row ? (JSON.parse(String(row.data)) as EvidenceSnapshot) : null;
}
export function getJudgment(
  db: Database,
  id: string | null,
): { result: JudgmentResult; key: string } | null {
  if (!id) return null;
  const row = db
    .prepare("SELECT result,cache_key FROM judgments WHERE id=? AND state='complete'")
    .get(id);
  return row?.result
    ? { result: JSON.parse(String(row.result)) as JudgmentResult, key: String(row.cache_key) }
    : null;
}

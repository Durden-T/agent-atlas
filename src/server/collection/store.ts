import type { Database } from '../database.ts';
import { getRepository, saveRepository } from '../database.ts';
import type { RepositoryMetadata, RunRecord, RepositoryRecord } from '../../shared/contracts.ts';

const unresolvedPaid = `(SELECT j.state FROM judgments j WHERE j.repository_id=r.id
  AND j.state NOT IN ('not_sent','prepared') ORDER BY j.rowid DESC LIMIT 1) IN ('submitted','error','unknown')`;
export function hasPaidFailure(db: Database, id: number): boolean {
  return Boolean(
    db.prepare(`SELECT ${unresolvedPaid} AS failed FROM repositories r WHERE r.id=?`).get(id)
      ?.failed,
  );
}

export function saveRun(db: Database, run: RunRecord): void {
  // simplify: recount at persisted checkpoints; use incremental counts if catalog size makes this costly.
  run.stats.pending = pendingCount(db);
  db.prepare(
    'INSERT INTO runs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
  ).run(run.id, JSON.stringify(run));
}
export function candidate(
  db: Database,
  run: RunRecord,
  meta: RepositoryMetadata,
  source: { key: string; label: string; parentId: number | null },
  at: string,
): void {
  if (!getRepository(db, meta.id)) {
    saveRepository(db, {
      id: meta.id,
      metadata: meta,
      state: 'new',
      checkedAt: null,
      contentAt: at,
      evidenceId: null,
      judgmentId: null,
      filterReason: null,
      error: null,
    });
    run.stats.discovered++;
  }
  db.prepare(
    'INSERT INTO sources(repository_id,key,data) VALUES(?,?,?) ON CONFLICT(repository_id,key) DO NOTHING',
  ).run(meta.id, source.key, JSON.stringify({ ...source, discoveredAt: at }));
  db.prepare(
    "INSERT INTO work_items(run_id,repository_id,state,candidate) VALUES(?,?,'pending',?) ON CONFLICT(run_id,repository_id) DO UPDATE SET candidate=excluded.candidate",
  ).run(run.id, meta.id, JSON.stringify(meta));
}
export function workState(db: Database, runId: string, repoId: number, state: string): void {
  db.prepare('UPDATE work_items SET state=? WHERE run_id=? AND repository_id=?').run(
    state,
    runId,
    repoId,
  );
}
export function pendingCandidates(
  db: Database,
  run: RunRecord,
  limit: number,
): { record: RepositoryRecord; candidate: RepositoryMetadata }[] {
  const retry = run.command.kind === 'continue' && run.command.retryErrors;
  if (!retry) {
    const blocked = Number(
      db.prepare(`SELECT count(*) AS n FROM repositories r WHERE ${unresolvedPaid}`).get()?.n,
    );
    if (blocked) run.gaps.push(`${blocked} 个仓库的付费请求需明确重试`);
  }
  const rows = db
    .prepare(
      `SELECT r.data,w.candidate FROM repositories r LEFT JOIN work_items w ON w.rowid=(SELECT wi.rowid FROM work_items wi WHERE wi.repository_id=r.id AND wi.state='pending' ORDER BY (wi.run_id=?) DESC,wi.rowid DESC LIMIT 1)
    WHERE (w.state='pending' OR json_extract(r.data,'$.state') IN ('new','pending','error','unknown'))
      AND (? OR NOT COALESCE(${unresolvedPaid},0))
    ORDER BY COALESCE(json_extract(w.candidate,'$.stars'),json_extract(r.data,'$.metadata.stars')) DESC,r.id ASC LIMIT ?`,
    )
    .all(run.id, retry ? 1 : 0, limit);
  return rows.map((row) => {
    const record = JSON.parse(String(row.data)) as RepositoryRecord;
    return {
      record,
      candidate: row.candidate
        ? (JSON.parse(String(row.candidate)) as RepositoryMetadata)
        : record.metadata,
    };
  });
}
export function pendingCount(db: Database): number {
  return Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM (SELECT id FROM repositories WHERE json_extract(data,'$.state') IN ('new','pending') UNION SELECT repository_id FROM work_items WHERE state='pending')",
      )
      .get()?.n,
  );
}

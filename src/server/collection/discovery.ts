import { keywords, queryFor, splitSearch, type SearchWork } from './search.ts';
import { createHash } from 'node:crypto';
import type { Database } from '../database.ts';
import { transaction } from '../database.ts';
import type { CollectionSettings, RunRecord, RepositoryMetadata } from '../../shared/contracts.ts';
import { pushedSince, remainingRequests } from '../../shared/repository-rules.ts';
import { RELEVANT_MIN } from '../../shared/taxonomy.ts';
import type { Github } from '../github.ts';
import { AppError } from '../errors.ts';
import { candidate, saveRun } from './store.ts';

interface OwnerWork {
  kind: 'owner';
  bucket: string;
  owner: string;
  ownerType: 'User' | 'Organization';
  page: number;
  parentId: number;
  done: boolean;
}
type DiscoveryWork = SearchWork | OwnerWork;
function workKey(work: DiscoveryWork): string {
  const { done: _, ...identity } = work.kind === 'owner' ? { ...work, parentId: undefined } : work;
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, sort: 'stars', ...identity }))
    .digest('hex');
}
function put(db: Database, work: DiscoveryWork, attempted: ReadonlySet<string>): void {
  const key = workKey(work),
    visited = Number(
      db.prepare('SELECT COALESCE(max(visited),0)+1 AS n FROM discovery_work').get()?.n,
    );
  // A parent may run after its old child; do not reopen work already serviced in this run.
  if (attempted.has(key)) return;
  db.prepare(
    `INSERT INTO discovery_work(key,data,visited) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET data=excluded.data,visited=excluded.visited
     WHERE json_extract(discovery_work.data,'$.done')=1`,
  ).run(key, JSON.stringify(work), visited);
}
export async function discover(input: {
  db: Database;
  run: RunRecord;
  settings: CollectionSettings;
  github: Github;
  signal: AbortSignal;
  now: () => number;
}) {
  const { db, run, settings, github, signal, now } = input;
  const bucket = JSON.stringify(['intervals-v2', settings.minStars, settings.updatedWithinDays]);
  const cutoff = pushedSince(settings.updatedWithinDays, Date.parse(run.startedAt));
  const rootKeys: string[] = [];
  const attempted = new Set<string>();
  for (const keyword of keywords) {
    const root: SearchWork = {
      kind: 'search',
      bucket,
      keyword,
      page: 1,
      pushedDate: cutoff === null ? null : new Date(cutoff).toISOString().slice(0, 10),
      start: null,
      end: null,
      grain: 'root',
      starMin: settings.minStars,
      starMax: null,
      done: false,
    };
    rootKeys.push(workKey(root));
    put(db, root, attempted);
  }
  const owners = db
    .prepare(
      `SELECT id,data FROM (SELECT r.id,r.data,
      row_number() OVER (PARTITION BY lower(json_extract(r.data,'$.metadata.owner')) ORDER BY json_extract(r.data,'$.metadata.stars') DESC,r.id ASC) AS owner_rank
      FROM repositories r JOIN judgments j ON j.id=json_extract(r.data,'$.judgmentId')
    WHERE j.state='complete' AND (
      (json_extract(j.result,'$.decisions.relevance.type')='noul' AND json_extract(j.result,'$.decisions.relevance.noul')>=?)
      OR json_extract(j.result,'$.decisions.relevance.choice') IN ('direct','supporting'))
      AND json_extract(j.result,'$.decisions.relevance.needsReview')=0
      AND EXISTS(SELECT 1 FROM sources s WHERE s.repository_id=r.id AND json_extract(s.data,'$.parentId') IS NULL))
      WHERE owner_rank=1 ORDER BY json_extract(data,'$.metadata.stars') DESC,id ASC LIMIT 1000`,
    )
    .all(RELEVANT_MIN);
  for (const row of owners) {
    const meta = JSON.parse(String(row.data)).metadata as RepositoryMetadata;
    const work: OwnerWork = {
      kind: 'owner',
      bucket,
      owner: meta.owner,
      ownerType: meta.ownerType,
      page: 1,
      parentId: Number(row.id),
      done: false,
    };
    put(db, work, attempted);
  }
  let used = 0;
  const requestLimit = remainingRequests(settings.discoveryRequestLimit, 0);
  const allocation = settings.discoveryRequestLimit === -1 ? 10 : requestLimit;
  const budgets = {
    search: allocation - Math.floor(allocation * 0.1),
    owner: Math.floor(allocation * 0.1),
  };
  const rotationKey = 'rotation:' + bucket,
    rotation = db.prepare('SELECT data FROM discovery_work WHERE key=?').get(rotationKey);
  let freshNext = rotation ? Boolean(JSON.parse(String(rotation.data)).freshNext) : true;
  async function channel(kind: 'search' | 'owner', allowance: number) {
    const begin = used;
    const consume = () => {
      if (
        used >= requestLimit ||
        (settings.discoveryRequestLimit !== -1 && used - begin >= allowance)
      )
        throw new AppError('发现请求预算已用尽', 'discovery_budget');
      used++;
      run.stage = `发现仓库（已发起 ${used} 次 GitHub 请求）`;
      saveRun(db, run);
    };
    try {
      while (used < requestLimit && used - begin < allowance) {
        signal.throwIfAborted();
        const rows = db
          .prepare(
            "SELECT key,data FROM discovery_work WHERE json_extract(data,'$.bucket')=? AND json_extract(data,'$.kind')=? AND json_extract(data,'$.done')=0 ORDER BY visited,key LIMIT 1000",
          )
          .all(bucket, kind)
          .filter((r) => !attempted.has(String(r.key)));
        const fresh =
          kind === 'search'
            ? db
                .prepare(
                  "SELECT key,data FROM discovery_work WHERE key IN (?,?,?,?,?) AND json_extract(data,'$.done')=0 ORDER BY visited,key",
                )
                .all(...rootKeys)
                .find((r) => !attempted.has(String(r.key)))
            : undefined;
        const backlog = rows.find((r) => !rootKeys.includes(String(r.key)));
        let row: (typeof rows)[number] | undefined = rows[0];
        if (kind === 'search') row = freshNext ? (fresh ?? backlog) : (backlog ?? fresh);
        if (!row) break;
        const key = String(row.key),
          work = JSON.parse(String(row.data)) as DiscoveryWork;
        attempted.add(key);
        db.prepare(
          'UPDATE discovery_work SET visited=(SELECT COALESCE(max(visited),0)+1 FROM discovery_work) WHERE key=?',
        ).run(key);
        if (kind === 'search') {
          freshNext = !rootKeys.includes(key);
          db.prepare(
            'INSERT INTO discovery_work(key,data,visited) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
          ).run(rotationKey, JSON.stringify({ kind: 'rotation', bucket, done: true, freshNext }));
        }
        const before = used;
        if (work.kind === 'owner') {
          const result = await github.owner(work.owner, work.ownerType, work.page, signal, consume);
          transaction(db, () => {
            for (const meta of result.items)
              candidate(
                db,
                run,
                meta,
                {
                  key: `owner:${work.owner}`,
                  label: `作者扩展：${work.owner}`,
                  parentId: work.parentId,
                },
                new Date(now()).toISOString(),
              );
            work.done = true;
            db.prepare('UPDATE discovery_work SET data=? WHERE key=?').run(
              JSON.stringify(work),
              key,
            );
            if (result.hasNext) put(db, { ...work, page: work.page + 1, done: false }, attempted);
            saveRun(db, run);
          });
          continue;
        }
        const result = await github.search(queryFor(work), work.page, signal, consume);
        transaction(db, () => {
          for (const meta of result.items)
            candidate(
              db,
              run,
              meta,
              {
                key: `search:${key}`,
                label: queryFor(work) + `（第 ${work.page} 页）`,
                parentId: null,
              },
              new Date(now()).toISOString(),
            );
          if (result.incomplete) {
            run.gaps.push('GitHub 返回不完整结果：' + queryFor(work));
            saveRun(db, run);
            return;
          }
          const expected = Math.min(100, result.total - (work.page - 1) * 100);
          if (result.total <= 1000 && result.items.length < expected) {
            run.gaps.push(
              '分页提前结束：' +
                queryFor(work) +
                `（第 ${work.page} 页，预期 ${expected} 条，返回 ${result.items.length} 条）`,
            );
            saveRun(db, run);
            return;
          }
          work.done = true;
          db.prepare('UPDATE discovery_work SET data=? WHERE key=?').run(JSON.stringify(work), key);
          if (result.total > 1000) {
            const children = splitSearch(
              work,
              result.items[0]?.stars ?? work.starMin,
              new Date(now()).getUTCFullYear(),
            );
            if (children.length) children.forEach((child) => put(db, child, attempted));
            else {
              work.done = false;
              db.prepare('UPDATE discovery_work SET data=? WHERE key=?').run(
                JSON.stringify(work),
                key,
              );
              run.gaps.push('无法继续细分的超限查询：' + queryFor(work));
            }
          } else if (work.page * 100 < result.total && work.page < 10 && result.items.length)
            put(db, { ...work, page: work.page + 1, done: false }, attempted);
          else if (work.page * 100 < result.total) run.gaps.push('分页提前结束：' + queryFor(work));
          saveRun(db, run);
        });
        if (used === before) throw new AppError('发现请求未消耗预算', 'invariant', 500);
      }
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'discovery_budget')) throw error;
    }
  }
  try {
    let before: number;
    do {
      before = used;
      await channel('search', budgets.search);
      await channel('owner', budgets.owner);
    } while (settings.discoveryRequestLimit === -1 && used > before);
    if (settings.discoveryRequestLimit !== -1 && used < requestLimit) {
      await channel('search', requestLimit - used);
      await channel('owner', requestLimit - used);
    }
  } finally {
    const remaining = Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM discovery_work WHERE json_extract(data,'$.bucket')=? AND json_extract(data,'$.done')=0",
        )
        .get(bucket)?.n,
    );
    if (remaining)
      run.gaps.push(`${remaining} 个发现分页或分段待下次继续（已使用 ${used} 个请求）`);
    for (const row of db
      .prepare(
        "SELECT data FROM discovery_work WHERE json_extract(data,'$.bucket')=? AND json_extract(data,'$.done')=0 ORDER BY visited,key LIMIT 20",
      )
      .all(bucket)) {
      const work = JSON.parse(String(row.data)) as DiscoveryWork;
      run.gaps.push(
        '未覆盖：' +
          (work.kind === 'search' ? queryFor(work) : '作者 ' + work.owner) +
          `（第 ${work.page} 页）`,
      );
    }
    if (remaining > 20) run.gaps.push(`另有 ${remaining - 20} 个发现步骤已保存，后续手动收集续跑`);
    saveRun(db, run);
  }
}

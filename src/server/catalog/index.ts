import type { Database } from '../database.ts';
import { getRepository, getEvidence, transaction } from '../database.ts';
import {
  defaults,
  defaultFilter,
  filterSchema,
  overrideSchema,
  collectionSettingsSchema,
} from '../../shared/contracts.ts';
import type {
  CatalogResource,
  ResourceDetail,
  ResourceFilter,
  Override,
  Page,
  Settings,
  RepositoryRecord,
  JudgmentResult,
} from '../../shared/contracts.ts';
import { pushedSince } from '../../shared/repository-rules.ts';
import { taxonomy, labelFacetStates } from '../../shared/taxonomy.ts';
import { createPersonal } from './personal.ts';
import { AppError } from '../errors.ts';

const effectiveState =
  "CASE json_extract(o.data,'$.decision') WHEN 'ignore' THEN 'ignored' WHEN 'keep' THEN 'collected' ELSE json_extract(r.data,'$.state') END";
const effectiveLabels =
  "COALESCE(json_extract(o.data,'$.labels'),json_extract(j.result,'$.labels'),'[]')";
const folderData =
  "(SELECT json_group_array(json_object('id',f.id,'name',f.name) ORDER BY f.name COLLATE NOCASE,f.id) FROM repository_folders rf JOIN folders f ON f.id=rf.folder_id WHERE rf.repository_id=r.id)";
const joins =
  "FROM repositories r LEFT JOIN overrides o ON o.repository_id=r.id LEFT JOIN judgments j ON j.id=json_extract(r.data,'$.judgmentId') LEFT JOIN personal_state p ON p.repository_id=r.id";
export function pageBounds(page = 1, pageSize = 50) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new AppError('分页参数非法');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function resource(row: Record<string, unknown>): CatalogResource {
  const record = JSON.parse(String(row.data)) as RepositoryRecord;
  const override = row.override ? (JSON.parse(String(row.override)) as Override) : null,
    result = row.result ? (JSON.parse(String(row.result)) as JudgmentResult) : null,
    labels = JSON.parse(String(row.labels));
  return {
    ...record,
    folders: JSON.parse(String(row.folders)),
    viewed: Boolean(row.viewed),
    override,
    facetStates: labelFacetStates(
      result?.decisions ?? null,
      labels,
      override !== null && override.labels !== null,
      result?.ruleVersion,
    ),
    labels,
    effectiveState: String(row.effective_state),
  };
}
export function createCatalog(db: Database, now = Date.now) {
  const personal = createPersonal(db);
  function list(input: ResourceFilter, page = 1, pageSize = 50): Page<CatalogResource> {
    const filter = filterSchema.parse(input),
      bounds = pageBounds(page, pageSize);
    const where = ["json_extract(r.data,'$.metadata.stars')>=?"],
      params: (string | number)[] = [filter.minStars];
    const cutoff = pushedSince(filter.updatedWithinDays, now());
    if (cutoff !== null) {
      where.push("julianday(json_extract(r.data,'$.metadata.pushed_at'))>=julianday(?)");
      params.push(new Date(cutoff).toISOString());
    }
    if (filter.folderId !== null) {
      where.push(
        'EXISTS(SELECT 1 FROM repository_folders rf WHERE rf.repository_id=r.id AND rf.folder_id=?)',
      );
      params.push(filter.folderId);
    }
    if (filter.viewed !== 'all') {
      where.push('COALESCE(p.viewed,0)=?');
      params.push(filter.viewed === 'viewed' ? 1 : 0);
    }
    if (filter.query) {
      where.push(
        "instr(lower(json_extract(r.data,'$.metadata.full_name')||' '||COALESCE(json_extract(r.data,'$.metadata.description'),'')),lower(?))>0",
      );
      params.push(filter.query);
    }
    if (filter.state !== 'all') {
      where.push(effectiveState + '=?');
      params.push(filter.state);
    }
    if (filter.archived !== 'all') {
      where.push("json_extract(r.data,'$.metadata.archived')=?");
      params.push(filter.archived === 'archived' ? 1 : 0);
    }
    for (const facet of taxonomy.facets) {
      const chosen = filter.labels.filter((id) => id.startsWith(facet.id + '.'));
      if (!chosen.length) continue;
      where.push(
        `EXISTS(SELECT 1 FROM json_each(${effectiveLabels}) WHERE value IN (${chosen.map(() => '?').join(',')}))`,
      );
      params.push(...chosen);
    }
    const clause = ' WHERE ' + where.join(' AND '),
      sort = filter.sort === 'stars' ? 'stars' : 'pushed_at';
    const total = Number(db.prepare('SELECT count(*) AS n ' + joins + clause).get(...params)?.n);
    const rows = db
      .prepare(
        `SELECT r.data,o.data AS override,j.result,${folderData} AS folders,COALESCE(p.viewed,0) AS viewed,${effectiveLabels} AS labels,${effectiveState} AS effective_state ${joins}${clause} ORDER BY json_extract(r.data,'$.metadata.${sort}') DESC,r.id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, bounds.pageSize, bounds.offset);
    return { items: rows.map(resource), total, page: bounds.page, pageSize: bounds.pageSize };
  }
  function get(id: number, sourcePage = 1): ResourceDetail {
    const bounds = pageBounds(sourcePage);
    const row = db
      .prepare(
        `SELECT r.data,o.data AS override,j.result,${folderData} AS folders,COALESCE(p.viewed,0) AS viewed,${effectiveLabels} AS labels,${effectiveState} AS effective_state ${joins} WHERE r.id=?`,
      )
      .get(id);
    if (!row) throw new AppError('仓库记录不存在', 'not_found', 404);
    const repo = resource(row);
    const judgments = db
      .prepare(
        'SELECT id,state,at,result,error,trace FROM judgments WHERE repository_id=? ORDER BY rowid DESC LIMIT 100',
      )
      .all(id)
      .map((j) => ({
        id: String(j.id),
        state: String(j.state),
        at: String(j.at),
        result: j.result ? (JSON.parse(String(j.result)) as JudgmentResult) : null,
        error: j.error ? String(j.error) : null,
        trace: j.trace ? JSON.parse(String(j.trace)) : null,
      }));
    return {
      ...repo,
      evidence: getEvidence(db, repo.evidenceId),
      judgments,
      sources: {
        items: db
          .prepare(
            'SELECT data FROM sources WHERE repository_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?',
          )
          .all(id, bounds.pageSize, bounds.offset)
          .map((s) => JSON.parse(String(s.data))),
        total: Number(
          db.prepare('SELECT count(*) AS n FROM sources WHERE repository_id=?').get(id)?.n,
        ),
        page: sourcePage,
        pageSize: bounds.pageSize,
      },
    };
  }
  function setOverride(id: number, input: Override): ResourceDetail {
    const value = overrideSchema.parse(input);
    if (!getRepository(db, id)) throw new AppError('仓库记录不存在', 'not_found', 404);
    if (value.decision === null && value.labels === null) {
      db.prepare('DELETE FROM overrides WHERE repository_id=?').run(id);
      return get(id);
    }
    db.prepare(
      'INSERT INTO overrides(repository_id,data) VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET data=excluded.data',
    ).run(id, JSON.stringify(value));
    return get(id);
  }
  function getSettings(): Settings {
    const read = (key: string) => {
      const row = db.prepare('SELECT data FROM settings WHERE key=?').get(key);
      return row ? JSON.parse(String(row.data)) : undefined;
    };
    return {
      collection: collectionSettingsSchema.parse(read('collection') ?? defaults),
      view: filterSchema.parse(read('view') ?? defaultFilter),
    };
  }
  function saveSettings(input: Settings): Settings {
    const collection = collectionSettingsSchema.parse(input.collection),
      view = filterSchema.parse(input.view);
    transaction(db, () => {
      const statement = db.prepare(
        'INSERT INTO settings(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      );
      statement.run('collection', JSON.stringify(collection));
      statement.run('view', JSON.stringify(view));
    });
    return { collection, view };
  }
  return { list, get, setOverride, getSettings, saveSettings, ...personal };
}
export type Catalog = ReturnType<typeof createCatalog>;

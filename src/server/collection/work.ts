import { randomUUID } from 'node:crypto';
import { unknownUsage } from '../../shared/contracts.ts';
import type { Database } from '../database.ts';
import {
  transaction,
  getRepository,
  getEvidence,
  getJudgment,
  saveRepository,
} from '../database.ts';
import type {
  CollectionSettings,
  RepositoryRecord,
  RepositoryMetadata,
  RunRecord,
  JudgmentResult,
} from '../../shared/contracts.ts';
import {
  skipRefresh,
  thresholdFailure,
  emptyEvidence,
  remainingRequests,
} from '../../shared/repository-rules.ts';
import type { Github } from '../github.ts';
import type { Judgment } from '../judgment/index.ts';
import { cacheKey, JudgmentFailure } from '../judgment/index.ts';
import { AppError, safeError } from '../errors.ts';
import { workState, saveRun, hasPaidFailure } from './store.ts';

export interface WorkContext {
  db: Database;
  run: RunRecord;
  settings: CollectionSettings;
  github: Github;
  judgment: Judgment;
  signal: AbortSignal;
  now: () => number;
  usage: JudgmentResult['usage'];
  dispatchStopped: boolean;
}
function applyResult(record: RepositoryRecord, result: JudgmentResult, id: string, at: string) {
  record.state = result.status;
  record.judgmentId = id;
  record.checkedAt = at;
  record.error = null;
  record.filterReason = null;
}
function release(ctx: WorkContext, record: RepositoryRecord, state: string, persist = false) {
  transaction(ctx.db, () => {
    if (persist) saveRepository(ctx.db, record);
    workState(ctx.db, ctx.run.id, record.id, state);
    saveRun(ctx.db, ctx.run);
  });
}
// Keep this pipeline together so every dispatch/result exit uses the same claim and usage cleanup.
export async function processRepository(
  ctx: WorkContext,
  record: RepositoryRecord,
  candidate: RepositoryMetadata,
  order?: { turn: Promise<void>; release: () => void },
): Promise<void> {
  const { db, run, settings, signal, now } = ctx,
    force = run.command.kind === 'rejudge';
  signal.throwIfAborted();
  const current = getRepository(db, record.id);
  if (!current) throw new AppError('仓库记录不存在', 'not_found', 404);
  record = current;
  db.prepare(
    "INSERT INTO work_items(run_id,repository_id,state,candidate) VALUES(?,?,'pending',?) ON CONFLICT(run_id,repository_id) DO NOTHING",
  ).run(run.id, record.id, JSON.stringify(candidate));
  if (!force)
    db.prepare(
      "UPDATE work_items SET state='superseded' WHERE repository_id=? AND run_id<>? AND state='pending'",
    ).run(record.id, run.id);
  const retry = hasPaidFailure(db, record.id);
  if (retry && !force && !(run.command.kind === 'continue' && run.command.retryErrors)) {
    run.gaps.push(`${record.metadata.full_name} 的付费请求需明确重试`);
    release(ctx, record, 'blocked');
    return;
  }
  const filter = thresholdFailure(candidate, settings, Date.parse(run.startedAt));
  if (filter) {
    run.stats.thresholdFiltered++;
    if (!record.checkedAt) {
      record.state = 'filtered';
      record.filterReason = filter;
    }
    release(ctx, record, 'filtered', !record.checkedAt);
    return;
  }
  if (!force && skipRefresh(record, settings.refreshIntervalDays, now())) {
    run.stats.skipped++;
    release(ctx, record, 'skipped');
    return;
  }
  const claimed = transaction(db, () => {
    const holder = db
      .prepare(
        "SELECT run_id FROM work_items WHERE repository_id=? AND state IN ('reading','prepared','calling')",
      )
      .get(record.id);
    if (holder) return false;
    workState(db, run.id, record.id, 'reading');
    return true;
  });
  if (!claimed) {
    run.gaps.push(record.metadata.full_name + ' 正在其他任务中处理');
    release(ctx, record, 'pending');
    return;
  }
  let judgmentId: string | null = null,
    dispatched = false;
  try {
    const previous = getEvidence(db, record.evidenceId),
      oldResult = getJudgment(db, record.judgmentId);
    const read = force
      ? { metadata: record.metadata, snapshot: previous }
      : await ctx.github.read(candidate, record, previous, signal);
    signal.throwIfAborted();
    const at = new Date(now()).toISOString();
    const freshFilter = thresholdFailure(read.metadata, settings, Date.parse(run.startedAt));
    if (freshFilter) {
      run.stats.thresholdFiltered++;
      record.metadata = read.metadata;
      if (!record.checkedAt) {
        record.state = 'filtered';
        record.filterReason = freshFilter;
      }
      release(ctx, record, 'filtered', true);
      return;
    }
    const metadataChanged = JSON.stringify(record.metadata) !== JSON.stringify(read.metadata);
    record.metadata = read.metadata;
    if (!read.snapshot) {
      if (force) throw new AppError('没有可重新判断的 README 证据');
      record.state = 'filtered';
      record.filterReason = '无 README';
      record.error = null;
      record.checkedAt = at;
      record.evidenceId = null;
      record.judgmentId = null;
      if (previous || metadataChanged) record.contentAt = at;
      run.stats.noReadme++;
      transaction(db, () => {
        saveRepository(db, record);
        workState(db, run.id, record.id, 'filtered');
        saveRun(db, run);
      });
      return;
    }
    const snapshot = read.snapshot,
      evidenceChanged = snapshot.hash !== previous?.hash;
    if (evidenceChanged) record.judgmentId = null;
    if (evidenceChanged || snapshot.sha !== previous?.sha) {
      db.prepare('INSERT INTO evidence(id,repository_id,hash,data) VALUES(?,?,?,?)').run(
        snapshot.id,
        record.id,
        snapshot.hash,
        JSON.stringify(snapshot),
      );
      record.evidenceId = snapshot.id;
      record.contentAt = at;
    } else if (previous)
      db.prepare('UPDATE evidence SET data=? WHERE id=?').run(
        JSON.stringify({ ...snapshot, id: previous.id }),
        previous.id,
      );
    if (metadataChanged || (previous && evidenceChanged)) run.stats.updated++;
    if (emptyEvidence(snapshot.evidence)) {
      record.state = 'filtered';
      record.filterReason = '无有效分类证据';
      record.error = null;
      record.checkedAt = at;
      record.judgmentId = null;
      run.stats.emptyEvidenceFiltered++;
      release(ctx, record, 'filtered', true);
      return;
    }
    record.filterReason = null;
    if (
      !force &&
      !retry &&
      !evidenceChanged &&
      oldResult?.key.startsWith(`${record.id}:${snapshot.hash}:`)
    ) {
      applyResult(record, oldResult.result, record.judgmentId!, at);
      run.stats.cached++;
      release(ctx, record, 'done', true);
      return;
    }
    const key = cacheKey(record.id, snapshot.hash),
      cached =
        !force && !retry
          ? db
              .prepare(
                "SELECT id,result FROM judgments WHERE cache_key=? AND state='complete' ORDER BY rowid DESC LIMIT 1",
              )
              .get(key)
          : undefined;
    if (cached?.result) {
      applyResult(record, JSON.parse(String(cached.result)), String(cached.id), at);
      run.stats.cached++;
      release(ctx, record, 'done', true);
      return;
    }
    if (remainingRequests(settings.judgmentLimit, run.stats.requests) === 0) {
      record.state = 'pending';
      release(ctx, record, 'pending', true);
      return;
    }
    judgmentId = randomUUID();
    record.state = 'pending';
    record.error = null;
    transaction(db, () => {
      saveRepository(db, record);
      workState(db, run.id, record.id, 'prepared');
      db.prepare(
        "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES(?,?,?,?,'prepared',?)",
      ).run(judgmentId!, record.id, run.id, key, at);
      saveRun(db, run);
    });
    await order?.turn;
    const result = await ctx.judgment.judge(
      snapshot.evidence,
      signal,
      (request) => {
        signal.throwIfAborted();
        if (ctx.dispatchStopped) throw new AppError('本轮 Jev 已停止派发', 'dispatch_stopped');
        if (remainingRequests(settings.judgmentLimit, run.stats.requests) === 0)
          throw new AppError('本轮 Jev 处理上限已达到', 'judgment_budget');
        transaction(db, () => {
          db.prepare("UPDATE judgments SET state='submitted',trace=? WHERE id=?").run(
            JSON.stringify({ request, response: null, httpStatus: null, providerRequestId: null }),
            judgmentId!,
          );
          workState(db, run.id, record.id, 'calling');
          run.stats.requests++;
          Object.assign(run.stats, unknownUsage);
          saveRun(db, run);
        });
        dispatched = true;
        order?.release();
      },
      () => {
        ctx.dispatchStopped = true;
      },
    );
    transaction(db, () => {
      db.prepare("UPDATE judgments SET state='complete',result=?,trace=NULL WHERE id=?").run(
        JSON.stringify(result),
        judgmentId!,
      );
      applyResult(record, result, judgmentId!, new Date(now()).toISOString());
      saveRepository(db, record);
      workState(db, run.id, record.id, 'done');
      const pendingRequest = db
        .prepare("SELECT 1 FROM judgments WHERE run_id=? AND state='submitted' LIMIT 1")
        .get(run.id);
      for (const field of ['inputTokens', 'outputTokens', 'cost'] as const)
        ctx.usage[field] =
          ctx.usage[field] === null || result.usage[field] === null
            ? null
            : ctx.usage[field]! + result.usage[field]!;
      Object.assign(run.stats, pendingRequest ? unknownUsage : ctx.usage);
      run.stats.judged++;
      if (result.status === 'review') run.stats.review++;
      if (result.status === 'unrelated') run.stats.unrelated++;
      saveRun(db, run);
    });
  } catch (error) {
    if (error instanceof AppError && ['judgment_budget', 'dispatch_stopped'].includes(error.code)) {
      transaction(db, () => {
        if (judgmentId)
          db.prepare("UPDATE judgments SET state='not_sent' WHERE id=?").run(judgmentId);
        record.state = 'pending';
        saveRepository(db, record);
        workState(db, run.id, record.id, 'pending');
        saveRun(db, run);
      });
      return;
    }
    const message = safeError(error),
      unknown = dispatched && error instanceof AppError && error.code === 'jev_unknown';
    transaction(db, () => {
      if (judgmentId)
        db.prepare('UPDATE judgments SET state=?,error=? WHERE id=?').run(
          unknown ? 'unknown' : dispatched ? 'error' : 'not_sent',
          message,
          judgmentId,
        );
      if (judgmentId && error instanceof JudgmentFailure)
        db.prepare('UPDATE judgments SET trace=? WHERE id=?').run(
          JSON.stringify(error.trace),
          judgmentId,
        );
      record.state = unknown ? 'unknown' : 'error';
      record.error = message;
      saveRepository(db, record);
      workState(db, run.id, record.id, unknown ? 'unknown' : 'error');
      if (dispatched) {
        Object.assign(run.stats, unknownUsage);
        Object.assign(ctx.usage, unknownUsage);
      }
      if (unknown) run.stats.unknownRequests++;
      run.stats.failed++;
      run.errors.push(record.metadata.full_name + '：' + message);
      saveRun(db, run);
    });
    if (
      signal.aborted ||
      (error instanceof AppError &&
        [
          'network',
          'github_auth',
          'rate_limit',
          'github_unavailable',
          'jev_auth',
          'jev_payment',
        ].includes(error.code))
    )
      throw error;
  }
}

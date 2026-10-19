import { randomUUID } from 'node:crypto';
import { getRepository, getEvidence, type Database } from '../database.ts';
import { commandSchema, emptyStats } from '../../shared/contracts.ts';
import type { StartCommand, RunRecord, CollectionSettings, Page } from '../../shared/contracts.ts';
import type { Github } from '../github.ts';
import type { Judgment } from '../judgment/index.ts';
import { AppError, safeError } from '../errors.ts';
import { pageBounds } from '../catalog/index.ts';
import { discover } from './discovery.ts';
import { saveRun, pendingCandidates, pendingCount } from './store.ts';
import { processRepository } from './work.ts';
import { remainingRequests } from '../../shared/repository-rules.ts';

export interface CollectionOptions {
  db: Database;
  github: Github;
  judgment: Judgment;
  settings: () => CollectionSettings;
  canJudge: () => boolean;
  now?: () => number;
  maxDurationMs?: number;
}
export function createCollection(options: CollectionOptions) {
  const { db, github, judgment } = options,
    now = options.now ?? Date.now;
  const active = new Map<
    string,
    { command: StartCommand; controller: AbortController; promise: Promise<void> }
  >();
  function getRun(id: string): RunRecord {
    const row = db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new AppError('收集任务不存在', 'not_found', 404);
    return JSON.parse(String(row.data)) as RunRecord;
  }
  function listRuns(page = 1, pageSize = 20): Page<RunRecord> {
    const bounds = pageBounds(page, pageSize),
      total = Number(db.prepare('SELECT count(*) AS n FROM runs').get()?.n);
    return {
      items: db
        .prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT ? OFFSET ?')
        .all(pageSize, bounds.offset)
        .map((r) => JSON.parse(String(r.data))),
      total,
      page,
      pageSize,
    };
  }
  async function execute(run: RunRecord, controller: AbortController) {
    const durationMs = options.maxDurationMs ?? 15 * 60 * 1000;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(durationMs)]);
    const settings = run.command.settings;
    const ctx = {
      db,
      run,
      settings,
      github,
      judgment,
      signal,
      now,
      dispatchStopped: false,
      usage: {
        inputTokens: 0 as number | null,
        outputTokens: 0 as number | null,
        cost: 0 as number | null,
      },
    };
    try {
      run.status = 'running';
      saveRun(db, run);
      if (run.command.kind === 'collect') {
        run.stage = '发现仓库';
        saveRun(db, run);
        // Reserve half the task for reading and classification, even with unlimited discovery.
        const discoveryTimeout = AbortSignal.timeout(Math.max(1, Math.floor(durationMs / 2)));
        try {
          await discover({
            ...ctx,
            signal: AbortSignal.any([signal, discoveryTimeout]),
          });
        } catch (error) {
          const timedOut =
            discoveryTimeout.aborted &&
            (error === discoveryTimeout.reason ||
              (error instanceof DOMException && error.name === 'AbortError'));
          if (signal.aborted || !timedOut) throw error;
          run.gaps.push('发现阶段达到时间预算，已保留分页，继续读取与判断');
        }
      }
      run.stage = '读取与判断';
      saveRun(db, run);
      if (run.command.kind === 'rejudge') {
        const repo = getRepository(db, run.command.repositoryId)!;
        await processRepository(ctx, repo, repo.metadata);
      } else {
        const readLimit = Math.min(5000, remainingRequests(settings.judgmentLimit, 0) * 4 + 40),
          rows = pendingCandidates(db, run, readLimit + 1);
        let i = 0;
        for (; i < Math.min(rows.length, readLimit);) {
          signal.throwIfAborted();
          const slots = Math.min(2, remainingRequests(settings.judgmentLimit, run.stats.requests)),
            chunk = rows.slice(i, Math.min(i + slots, readLimit));
          let turn = Promise.resolve();
          const results = await Promise.allSettled(
            chunk.map(({ record, candidate }) => {
              const previous = turn;
              let release!: () => void;
              turn = new Promise<void>((resolve) => {
                release = resolve;
              });
              return processRepository(ctx, record, candidate, { turn: previous, release })
                .catch((error) => {
                  ctx.dispatchStopped = true;
                  throw error;
                })
                .finally(release);
            }),
          );
          const failure = results.find((r) => r.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          i += chunk.length;
          if (remainingRequests(settings.judgmentLimit, run.stats.requests) === 0) {
            if (i < rows.length) run.gaps.push('本轮 Jev 上限已达到，剩余仓库保留待判断');
            break;
          }
        }
        if (i >= readLimit && rows.length > readLimit)
          run.gaps.push('本轮仓库读取上限已达到，剩余候选保留待处理');
      }
      run.stats.pending = pendingCount(db);
      run.status =
        run.errors.length || run.gaps.length || run.stats.pending ? 'partial' : 'completed';
    } catch (error) {
      if (controller.signal.aborted)
        run.status =
          controller.signal.reason instanceof AppError &&
          controller.signal.reason.code === 'interrupted'
            ? 'interrupted'
            : 'cancelled';
      else if (signal.aborted) {
        run.status = 'partial';
        run.gaps.push('达到任务时间上限，保留未完成工作');
      } else {
        run.status =
          error instanceof AppError &&
          ['discovery_budget', 'rate_limit', 'network', 'github_unavailable'].includes(error.code)
            ? 'partial'
            : 'failed';
        run.errors.push(safeError(error));
      }
      run.stats.pending = pendingCount(db);
    } finally {
      run.stage = '已结束';
      run.endedAt = new Date(now()).toISOString();
      saveRun(db, run);
      active.delete(run.id);
    }
  }
  function start(input: StartCommand): { run: RunRecord; reused: boolean } {
    const command = commandSchema.parse(input);
    if (!options.canJudge())
      throw new AppError('未配置 JEV_OPENROUTER_KEY，请设置服务端环境并重启', 'jev_key');
    if (command.kind !== 'rejudge') {
      const existing = [...active.entries()].find(([, task]) => task.command.kind !== 'rejudge');
      if (existing) return { run: getRun(existing[0]), reused: true };
    } else {
      const current = [...active.entries()].find(
        ([, task]) =>
          task.command.kind === 'rejudge' && task.command.repositoryId === command.repositoryId,
      );
      if (current) return { run: getRun(current[0]), reused: true };
      const holder = db
        .prepare(
          "SELECT run_id FROM work_items WHERE repository_id=? AND state IN ('reading','prepared','calling')",
        )
        .get(command.repositoryId);
      if (holder) return { run: getRun(String(holder.run_id)), reused: true };
      const repo = getRepository(db, command.repositoryId);
      if (!repo) throw new AppError('仓库记录不存在', 'not_found', 404);
      if (!getEvidence(db, repo.evidenceId)) throw new AppError('没有可重新判断的 README 证据');
    }
    if (active.size >= 32)
      throw new AppError('活动任务数量已达到上限，请等待现有任务结束', 'task_limit', 429);
    const run: RunRecord = {
      id: randomUUID(),
      command: {
        ...command,
        settings:
          command.kind === 'rejudge'
            ? { ...options.settings(), judgmentLimit: 1 }
            : command.settings,
      },
      status: 'queued',
      stage: '排队',
      startedAt: new Date(now()).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    saveRun(db, run);
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => execute(run, controller));
    active.set(run.id, { command, controller, promise });
    return { run, reused: false };
  }
  function cancel(id: string) {
    const task = active.get(id);
    task?.controller.abort(new AppError('用户取消了任务', 'cancelled'));
    return getRun(id);
  }
  async function shutdown() {
    for (const task of active.values())
      task.controller.abort(new AppError('应用正在退出', 'interrupted'));
    await Promise.allSettled([...active.values()].map((t) => t.promise));
  }
  return {
    start,
    cancel,
    getRun,
    listRuns,
    shutdown,
    activeRun: () => {
      const runs = [...active.keys()].map(getRun);
      return runs.find((r) => r.command.kind !== 'rejudge') ?? runs[0] ?? null;
    },
  };
}
export type Collection = ReturnType<typeof createCollection>;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, getRepository, saveRepository } from '../src/server/database.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { defaults, defaultFilter } from '../src/shared/contracts.ts';
import { pendingCount } from '../src/server/collection/store.ts';
import {
  evidence,
  metadata,
  now,
  githubMetadata,
  providerResponse,
  repository,
} from './fixtures.ts';

test('local name/description/archive filters combine and push-time sorting is independent of Stars', () => {
  const db = openDatabase(':memory:');
  try {
    const catalog = createCatalog(db, () => now);
    for (const [offset, name, description, archived, stars, pushed] of [
      [0, 'org/Needle', null, false, 1000, '2026-10-10T00:00:00Z'],
      [1, 'org/second', 'The NEEDLE utility', true, 500, '2026-10-13T00:00:00Z'],
      [2, 'org/third', 'A different utility', false, 100, '2026-10-12T00:00:00Z'],
    ] as const) {
      saveRepository(
        db,
        repository({
          id: metadata.id + offset,
          metadata: {
            ...metadata,
            id: metadata.id + offset,
            full_name: name,
            description,
            archived,
            stars,
            pushed_at: pushed,
          },
        }),
      );
    }
    const filter = {
      ...defaultFilter,
      state: 'all' as const,
      minStars: 0,
      updatedWithinDays: null,
    };
    const ids = (changes: Partial<typeof filter>) =>
      catalog.list({ ...filter, ...changes }).items.map((r) => r.id - metadata.id);
    assert.deepEqual(ids({ query: 'needle' }), [0, 1]);
    assert.deepEqual(ids({ query: 'NEEDLE', archived: 'active' }), [0]);
    assert.deepEqual(ids({ query: 'needle', archived: 'archived' }), [1]);
    assert.deepEqual(ids({ query: 'absent' }), []);
    assert.deepEqual(ids({ sort: 'stars' }), [0, 1, 2]);
    assert.deepEqual(ids({ sort: 'updated' }), [1, 2, 0]);
  } finally {
    db.close();
  }
});

function setup(
  options: {
    missing?: boolean;
    negative?: boolean;
    broken?: boolean;
    jevStatus?: number;
    jevBody?: 'delayed' | 'broken' | 'aborted';
    slow?: boolean;
    count?: number;
    readFailure?: boolean;
    rename?: boolean;
    discoveryBudget?: number;
    pauseAfter?: number;
    freshStars?: number;
    slowHighest?: boolean;
    slowSecond?: boolean;
    discoveryTimeoutAfter?: number;
    discoveryPauseAfter?: number;
    maxDurationMs?: number;
    blankEvidence?: boolean;
    beforeRead?: (path: string) => Promise<void>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-test-')),
    db = openDatabase(join(dir, 'atlas.sqlite'));
  let time = now,
    calls = 0,
    reads = 0,
    searches = 0,
    text = evidence.readme.text,
    stars = metadata.stars;
  const sent: string[] = [];
  const metas = () =>
    Array.from({ length: options.count ?? 1 }, (_, i) => ({
      ...metadata,
      id: metadata.id + i,
      full_name: metadata.owner + (options.rename ? '/renamed' : '/repo') + i,
      stars: stars - i,
      ...(options.blankEvidence ? { description: '  ', topics: [] } : {}),
    }));
  const github = createGithub({
    token: () => 'test-key',
    now: () => time,
    sleep: async () => {},
    fetch: async (url, init) => {
      const path = new URL(String(url));
      if (options.slow)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          }),
        );
      if (path.pathname === '/search/repositories') {
        if (searches++ >= (options.discoveryTimeoutAfter ?? Infinity))
          throw new DOMException('Timed out', 'TimeoutError');
        if (searches > (options.discoveryPauseAfter ?? Infinity))
          await new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            }),
          );
        return Response.json({
          total_count: metas().length,
          incomplete_results: false,
          items: metas().map(githubMetadata),
        });
      }
      if (path.pathname.startsWith('/orgs/')) return Response.json(metas().map(githubMetadata));
      if (options.beforeRead) await options.beforeRead(path.pathname);
      reads++;
      if (options.slowHighest && path.pathname === '/repos/' + metas()[0].full_name)
        await new Promise((resolve) => setTimeout(resolve, 30));
      if (options.slowSecond && path.pathname === '/repos/' + metas()[1].full_name)
        await new Promise((resolve) => setTimeout(resolve, 80));
      if (options.readFailure) return new Response(null, { status: 503 });
      if (path.pathname.endsWith('/readme'))
        return options.missing
          ? new Response(null, { status: 404 })
          : Response.json(
              {
                path: 'README.md',
                sha: createHash('sha1').update(text).digest('hex'),
                encoding: 'base64',
                content: Buffer.from(text).toString('base64'),
              },
              { headers: { etag: 'readme' } },
            );
      return Response.json(
        githubMetadata({
          ...(metas().find((m) => path.pathname === '/repos/' + m.full_name) ?? metadata),
          ...(options.freshStars === undefined ? {} : { stars: options.freshStars }),
        }),
      );
    },
  });
  const judgment = createJudgment({
    key: () => 'test-key',
    fetch: async (_url, init) => {
      calls++;
      sent.push(JSON.parse(String(init?.body)).state.repository.full_name);
      if (options.pauseAfter !== undefined && calls > options.pauseAfter)
        await new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          }),
        );
      if (options.broken) throw new Error('network');
      if (options.jevStatus && options.jevBody)
        return new Response(
          new ReadableStream({
            start(controller) {
              if (options.jevBody === 'aborted') {
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(init.signal!.reason),
                  {
                    once: true,
                  },
                );
                return;
              }
              setTimeout(() => {
                if (options.jevBody === 'broken') controller.error(new TypeError('stream failed'));
                else {
                  controller.enqueue(new TextEncoder().encode('{"error":"rejected"}'));
                  controller.close();
                }
              }, 200);
            },
          }),
          { status: options.jevStatus },
        );
      if (options.jevStatus)
        return Response.json(
          { error: { message: 'Request rejected' } },
          { status: options.jevStatus },
        );
      return Response.json(providerResponse(undefined, !options.negative));
    },
  });
  const catalog = createCatalog(db, () => time),
    collection = createCollection({
      db,
      github,
      judgment,
      settings: () => catalog.getSettings().collection,
      canJudge: () => true,
      now: () => time,
      maxDurationMs: options.maxDurationMs,
    });
  async function run(
    kind: 'collect' | 'continue' = 'collect',
    refresh = -1,
    limit = 100,
    retryErrors = false,
  ) {
    const settings = {
      ...defaults,
      refreshIntervalDays: refresh,
      judgmentLimit: limit,
      discoveryRequestLimit: options.discoveryBudget ?? 5,
    };
    const started = collection.start(
      kind === 'continue' ? { kind, settings, retryErrors } : { kind, settings },
    );
    for (let i = 0; i < 500; i++) {
      const result = collection.getRun(started.run.id);
      if (result.endedAt) return result;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error('Test task did not finish');
  }
  return {
    dir,
    db,
    catalog,
    collection,
    run,
    calls: () => calls,
    reads: () => reads,
    sent,
    advance: () => (time += 86400000),
    setText: (v: string) => (text = v),
    setStars: (v: number) => (stars = v),
    close: async () => {
      await collection.shutdown();
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}
test('queries deduplicate stable IDs and successful scans obey interval, metadata and evidence refresh', async () => {
  const f = setup();
  try {
    let run = await f.run();
    assert.equal(run.stats.discovered, 1);
    assert.equal(f.calls(), 1);
    assert.equal(f.reads(), 2);
    const before = getRepository(f.db, metadata.id)!;
    f.catalog.setOverride(metadata.id, { decision: 'keep', labels: ['form.skills'] });
    f.advance();
    f.setStars(10);
    run = await f.run();
    assert.equal(run.stats.thresholdFiltered, 1);
    assert.equal(run.stats.skipped, 0);
    assert.equal(f.reads(), 2);
    assert.deepEqual(getRepository(f.db, metadata.id), before);
    f.setStars(metadata.stars + 1);
    run = await f.run('collect', 0);
    assert.equal(f.calls(), 1);
    assert.equal(run.stats.cached, 1);
    f.setText(evidence.readme.text + ' updated');
    run = await f.run('collect', 0);
    assert.equal(f.calls(), 2);
    assert.equal(run.stats.updated, 1);
    assert.deepEqual(f.catalog.get(metadata.id).labels, ['form.skills']);
    assert.equal(f.catalog.get(metadata.id).sources.items.length, 10);
    assert.equal(
      f.catalog.list({ ...defaultFilter, state: 'all', labels: ['form.skills'] }).total,
      1,
    );
    f.catalog.setOverride(metadata.id, { decision: 'ignore', labels: null });
    assert.equal(f.catalog.list({ ...defaultFilter, state: 'ignored' }).total, 1);
    f.catalog.saveSettings({
      collection: { ...defaults, judgmentLimit: 3 },
      view: { ...defaultFilter, minStars: 0, updatedWithinDays: null },
    });
    assert.equal(f.catalog.getSettings().collection.judgmentLimit, 3);
  } finally {
    await f.close();
  }
});
for (const kind of ['negative', 'missing'] as const)
  test(kind + ' scans are retained and never rechecked at -1', async () => {
    const f = setup({ [kind]: true });
    try {
      await f.run();
      const reads = f.reads();
      const next = await f.run();
      assert.equal(next.stats.skipped, 1);
      assert.equal(f.reads(), reads);
      assert.equal(f.calls(), kind === 'missing' ? 0 : 1);
      assert.equal(
        getRepository(f.db, metadata.id)?.state,
        kind === 'missing' ? 'filtered' : 'unrelated',
      );
    } finally {
      await f.close();
    }
  });
test('unlimited budgets persist and process all eligible repositories without a negative slot or read limit', async () => {
  const f = setup({ count: 45, discoveryBudget: -1 });
  try {
    f.catalog.saveSettings({
      collection: { ...defaults, judgmentLimit: -1, discoveryRequestLimit: -1 },
      view: defaultFilter,
    });
    assert.equal(createCatalog(f.db).getSettings().collection.judgmentLimit, -1);
    assert.equal(createCatalog(f.db).getSettings().collection.discoveryRequestLimit, -1);
    const run = await f.run('collect', 0, -1);
    assert.equal(run.command.settings.judgmentLimit, -1);
    assert.equal(run.stats.requests, 45);
    assert.equal(run.stats.judged, 45);
    assert.equal(run.stats.pending, 0);
    assert.equal(run.status, 'completed');
    assert.equal(f.calls(), 45);
  } finally {
    await f.close();
  }
});
for (const missing of [false, true])
  test(`read-limit gaps only describe a reached candidate limit (missing=${missing})`, async () => {
    const f = setup({ count: 60, missing });
    try {
      const run = await f.run('collect', 0, 1);
      assert.equal(run.stats.requests, missing ? 0 : 1);
      assert.equal(
        run.gaps.some((gap) => gap.includes('读取上限已达到')),
        missing,
      );
      if (missing) assert.equal(run.stats.noReadme, 44);
    } finally {
      await f.close();
    }
  });

test('unlimited continuation drains the queue left by a finite judgment budget', async () => {
  const f = setup({ count: 4 });
  try {
    const first = await f.run('collect', 0, 1);
    assert.equal(first.stats.requests, 1);
    const next = await f.run('continue', 0, -1);
    assert.equal(next.stats.requests, 3);
    assert.equal(next.stats.pending, 0);
    assert.equal(f.calls(), 4);
  } finally {
    await f.close();
  }
});
test('dispatch quota counts failed requests and explicit continue retries only when requested', async () => {
  const f = setup({ count: 4, broken: true });
  try {
    const first = await f.run('collect', 0, 1);
    assert.equal(first.stats.requests, 1);
    assert.equal(f.calls(), 1);
    assert.equal(first.stats.pending, 3);
    assert.equal(first.stats.cost, null);
    const next = await f.run('continue', 0, 1);
    assert.equal(next.stats.requests, 1);
    assert.equal(f.calls(), 2);
    assert.ok(next.gaps.some((g) => g.includes('明确重试')));
    const retry = await f.run('continue', 0, 1, true);
    assert.equal(retry.stats.requests, 1);
    assert.equal(f.calls(), 3);
  } finally {
    await f.close();
  }
});
for (const status of [401, 402, 429])
  test(`known Jev HTTP ${status} remains an error when cancelling its unread body`, async () => {
    const f = setup({ count: 2, jevStatus: status, jevBody: 'aborted', slowSecond: true });
    try {
      const started = f.collection.start({
        kind: 'collect',
        settings: { ...defaults, discoveryRequestLimit: 5 },
      });
      for (let i = 0; i < 200 && !f.calls(); i++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(f.calls(), 1);
      f.collection.cancel(started.run.id);
      await f.collection.shutdown();
      const run = f.collection.getRun(started.run.id);
      assert.equal(run.status, 'cancelled');
      assert.equal(run.stats.unknownRequests, 0);
      const history = f.catalog.get(metadata.id).judgments[0];
      assert.equal(history.state, 'error');
      assert.equal(history.trace?.httpStatus, status);
      assert.equal(f.catalog.get(metadata.id).state, 'error');
    } finally {
      await f.close();
    }
  });
for (const jevStatus of [undefined, 200])
  test(`cancelling dispatched ${jevStatus ?? 'no response'} before a complete success preserves unknown paid state`, async () => {
    const f = setup(
      jevStatus === undefined ? { pauseAfter: 0 } : { jevStatus, jevBody: 'aborted' },
    );
    try {
      const started = f.collection.start({
        kind: 'collect',
        settings: { ...defaults, discoveryRequestLimit: 5 },
      });
      for (let i = 0; i < 200 && !f.calls(); i++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(f.calls(), 1);
      f.collection.cancel(started.run.id);
      await f.collection.shutdown();
      const run = f.collection.getRun(started.run.id);
      assert.equal(run.status, 'cancelled');
      assert.equal(run.stats.unknownRequests, 1);
      const history = f.catalog.get(metadata.id).judgments[0];
      assert.equal(history.state, 'unknown');
      assert.equal(history.trace?.httpStatus, jevStatus ?? null);
      assert.equal(f.catalog.get(metadata.id).state, 'unknown');
    } finally {
      await f.close();
    }
  });
for (const status of [401, 402, 429])
  for (const jevBody of [undefined, 'delayed', 'broken'] as const)
    test(`Jev HTTP ${status} prevents late dispatch with ${jevBody ?? 'immediate'} error body`, async () => {
      const options = { count: 5, jevStatus: status, slowSecond: true, jevBody };
      const f = setup(options);
      try {
        const first = await f.run();
        assert.equal(f.calls(), 1);
        assert.equal(first.stats.requests, 1);
        assert.equal(first.stats.failed, 1);
        assert.equal(first.stats.pending, 4);
        assert.equal(first.status, status === 429 ? 'partial' : 'failed');
        assert.equal(getRepository(f.db, metadata.id + 1)?.state, 'pending');
        assert.equal(first.stats.cost, null);
        assert.equal(first.stats.unknownRequests, 0);
        const history = f.catalog.get(metadata.id).judgments[0];
        assert.equal(history.state, 'error');
        assert.equal(history.trace?.httpStatus, status);
        if (jevBody === 'broken')
          assert.deepEqual(history.trace?.failure, { name: 'TypeError', causeCode: null });
        options.jevStatus = 0;
        const next = await f.run('continue');
        assert.equal(next.stats.requests, 4);
        assert.equal(next.stats.pending, 0);
        assert.equal(f.calls(), 5);
        assert.deepEqual(
          f.sent,
          [0, 1, 2, 3, 4].map((i) => metadata.owner + '/repo' + i),
        );
        assert.equal(
          f.db.prepare("SELECT count(*) AS n FROM judgments WHERE state='error'").get()?.n,
          1,
        );
      } finally {
        await f.close();
      }
    });
for (const status of [401, 402, 429])
  test(`Jev HTTP ${status} stops new dispatches and retains pending work without paid replay`, async () => {
    const f = setup({ count: 5, jevStatus: status });
    try {
      const first = await f.run();
      assert.equal(f.calls(), 2);
      assert.equal(first.status, status === 429 ? 'partial' : 'failed');
      assert.equal(first.stats.requests, 2);
      assert.equal(first.stats.failed, 2);
      assert.equal(first.stats.pending, 3);
      assert.equal(first.stats.cost, null);
      const histories = f.db.prepare('SELECT state,trace FROM judgments').all();
      assert.equal(histories.length, 2);
      assert.ok(
        histories.every(
          (row) => row.state === 'error' && JSON.parse(String(row.trace)).httpStatus === status,
        ),
      );
      const next = await f.run('continue');
      assert.equal(f.calls(), 4);
      assert.equal(next.stats.pending, 1);
      assert.ok(next.gaps.some((gap) => gap.includes('明确重试')));
      assert.deepEqual(
        f.sent,
        [0, 1, 2, 3].map((i) => metadata.owner + '/repo' + i),
      );
    } finally {
      await f.close();
    }
  });
test('explicit rejudge uses saved README and keeps human decisions', async () => {
  const f = setup();
  try {
    await f.run();
    f.catalog.setOverride(metadata.id, { decision: 'ignore', labels: ['form.skills'] });
    const reads = f.reads();
    const r = f.collection.start({ kind: 'rejudge', repositoryId: metadata.id });
    for (let i = 0; i < 100 && !f.collection.getRun(r.run.id).endedAt; i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(f.calls(), 2);
    assert.equal(f.reads(), reads);
    assert.equal(f.catalog.get(metadata.id).effectiveState, 'ignored');
  } finally {
    await f.close();
  }
});
test('duplicate starts reuse active task; cancellation differs from application shutdown', async () => {
  const f = setup({ slow: true });
  try {
    const command = { kind: 'collect' as const, settings: defaults };
    const first = f.collection.start(command);
    assert.equal(f.collection.start(command).run.id, first.run.id);
    await new Promise((r) => setTimeout(r, 5));
    f.collection.cancel(first.run.id);
    await f.collection.shutdown();
    assert.equal(f.collection.getRun(first.run.id).status, 'cancelled');
    const second = f.collection.start(command);
    await new Promise((r) => setTimeout(r, 5));
    await f.collection.shutdown();
    assert.equal(f.collection.getRun(second.run.id).status, 'interrupted');
  } finally {
    await f.close();
  }
});

test('complete cached judgments survive losing the latest pointer without another paid request', async () => {
  const f = setup();
  try {
    await f.run();
    const record = getRepository(f.db, metadata.id)!;
    record.judgmentId = null;
    record.state = 'pending';
    saveRepository(f.db, record);
    const next = await f.run('continue', 0);
    assert.equal(f.calls(), 1);
    assert.equal(next.stats.cached, 1);
    assert.equal(getRepository(f.db, metadata.id)?.state, 'collected');
  } finally {
    await f.close();
  }
});
test('collection thresholds filter new candidates without marking them successful scans', async () => {
  const f = setup();
  try {
    f.setStars(50);
    const first = await f.run();
    assert.equal(first.stats.thresholdFiltered, 1);
    assert.equal(f.reads(), 0);
    assert.equal(f.calls(), 0);
    assert.equal(getRepository(f.db, metadata.id)?.checkedAt, null);
    f.setStars(100);
    await f.run();
    assert.equal(f.calls(), 1);
    assert.equal(getRepository(f.db, metadata.id)?.state, 'collected');
  } finally {
    await f.close();
  }
});

for (const mode of ['skip', 'cache', 'missing'] as const)
  test(`zero-dispatch ${mode} runs report zero usage rather than unknown`, async () => {
    const f = setup({ missing: mode === 'missing' });
    try {
      if (mode !== 'missing') await f.run();
      const before = f.calls();
      const run = await f.run('collect', mode === 'cache' ? 0 : -1);
      assert.equal(f.calls(), before);
      assert.equal(run.stats.requests, 0);
      assert.equal(run.stats.inputTokens, 0);
      assert.equal(run.stats.outputTokens, 0);
      assert.equal(run.stats.cost, 0);
    } finally {
      await f.close();
    }
  });

test('regression: concurrent known usage sums instead of remaining unknown', async () => {
  const f = setup({ count: 2 });
  try {
    const r = await f.run();
    assert.equal(r.stats.requests, 2);
    assert.equal(r.stats.inputTokens, 200);
    assert.equal(r.stats.outputTokens, 40);
    assert.equal(r.stats.cost, 0.0000084);
  } finally {
    await f.close();
  }
});
for (const retryErrors of [false, true])
  test(`unchanged read recovery reuses a successful judgment (retryErrors=${retryErrors})`, async () => {
    const options = { readFailure: false };
    const f = setup(options);
    try {
      await f.run();
      options.readFailure = true;
      await f.run('collect', 0);
      assert.equal(getRepository(f.db, metadata.id)?.state, 'error');
      options.readFailure = false;
      const next = await f.run('continue', 0, 100, retryErrors);
      assert.equal(next.stats.requests, 0);
      assert.equal(next.stats.cached, 1);
      assert.equal(f.calls(), 1);
      assert.equal(getRepository(f.db, metadata.id)?.state, 'collected');
    } finally {
      await f.close();
    }
  });
test('queued retry reloads a successful manual rejudge instead of dispatching it again', async () => {
  const options: {
    count: number;
    broken: boolean;
    beforeRead?: (path: string) => Promise<void>;
  } = { count: 3, broken: true };
  const f = setup(options);
  let resumeRead = () => {};
  const gate = new Promise<void>((resolve) => (resumeRead = resolve));
  try {
    await f.run();
    assert.equal(f.calls(), 3);
    options.broken = false;
    let reading = false;
    options.beforeRead = async (path) => {
      if (path !== '/repos/' + metadata.owner + '/repo0') return;
      reading = true;
      await gate;
    };
    const queued = f.collection.start({ kind: 'continue', settings: defaults, retryErrors: true });
    for (let i = 0; i < 200 && !reading; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(reading);
    const target = metadata.id + 2;
    const manual = f.collection.start({ kind: 'rejudge', repositoryId: target });
    for (let i = 0; i < 200 && !f.collection.getRun(manual.run.id).endedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(f.collection.getRun(manual.run.id).stats.judged, 1);
    const judgmentId = getRepository(f.db, target)!.judgmentId;
    resumeRead();
    for (let i = 0; i < 200 && !f.collection.getRun(queued.run.id).endedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    const finished = f.collection.getRun(queued.run.id);
    assert.ok(finished.endedAt);
    assert.equal(finished.stats.requests, 2);
    assert.equal(finished.stats.skipped, 1);
    assert.equal(f.calls(), 6);
    assert.equal(getRepository(f.db, target)!.judgmentId, judgmentId);
  } finally {
    resumeRead();
    await f.close();
  }
});
test('explicit retry of a failed paid rejudge still dispatches despite an older successful cache', async () => {
  const options = { broken: false };
  const f = setup(options);
  try {
    await f.run();
    options.broken = true;
    const failed = f.collection.start({ kind: 'rejudge', repositoryId: metadata.id });
    for (let i = 0; i < 200 && !f.collection.getRun(failed.run.id).endedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(f.collection.getRun(failed.run.id).stats.unknownRequests, 1);
    options.broken = false;
    const next = await f.run('continue', 0, 100, true);
    assert.equal(next.stats.requests, 1);
    assert.equal(next.stats.cached, 0);
    assert.equal(f.calls(), 3);
  } finally {
    await f.close();
  }
});
test('regression: updated evidence is judged on explicit retry instead of reusing an older snapshot result', async () => {
  const options = { broken: false };
  const f = setup(options);
  try {
    await f.run();
    f.setText(evidence.readme.text + ' new evidence');
    options.broken = true;
    await f.run('collect', 0);
    options.broken = false;
    await f.run('continue', 0, 100, true);
    assert.equal(f.calls(), 3);
    assert.equal(getRepository(f.db, metadata.id)?.state, 'collected');
  } finally {
    await f.close();
  }
});
test('regression: all unprocessed refresh candidates survive a quota boundary', async () => {
  const f = setup({ count: 4 });
  try {
    await f.run();
    f.setText(evidence.readme.text + ' new evidence');
    const first = await f.run('collect', 0, 1);
    assert.equal(first.stats.pending, 3);
    await f.run('continue', 0);
    assert.equal(f.calls(), 8);
    assert.equal(f.catalog.list({ ...defaultFilter, state: 'pending' }).total, 0);
  } finally {
    await f.close();
  }
});
test('rejudge fixes its effective settings at command creation, before later defaults change', async () => {
  const f = setup();
  try {
    await f.run();
    const started = f.collection.start({ kind: 'rejudge', repositoryId: metadata.id });
    f.catalog.saveSettings({
      collection: { ...defaults, minStars: Number.MAX_SAFE_INTEGER },
      view: defaultFilter,
    });
    for (let i = 0; i < 100 && !f.collection.getRun(started.run.id).endedAt; i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(f.collection.getRun(started.run.id).stats.requests, 1);
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('failed paid request provenance persists without exposing credentials', async () => {
  const f = setup({ broken: true });
  try {
    await f.run();
    const trace = f.catalog.get(metadata.id).judgments[0].trace;
    assert.ok(trace);
    assert.equal(
      Object.keys((trace.request as { questions: Record<string, unknown> }).questions).length,
      16,
    );
    assert.equal(trace.response, null);
    assert.deepEqual(trace.failure, { name: 'Error', causeCode: null });
    assert.ok(!JSON.stringify(trace).includes('test-key'));
  } finally {
    await f.close();
  }
});

test('search and owner duplicates, rename and cached refresh preserve one repository and its manual labels', async () => {
  const options = { discoveryBudget: 10, rename: false };
  const f = setup(options);
  try {
    await f.run();
    f.catalog.setOverride(metadata.id, { decision: 'ignore', labels: ['form.skills'] });
    await f.run('collect', 0);
    assert.equal(f.calls(), 1);
    assert.equal(
      f.catalog.get(metadata.id).sources.items.filter((s) => s.parentId === metadata.id).length,
      1,
    );
    options.rename = true;
    await f.run('collect', 0);
    await f.run('collect', 0);
    const detail = f.catalog.get(metadata.id);
    assert.equal(f.calls(), 2);
    assert.equal(detail.metadata.full_name, metadata.owner + '/renamed0');
    assert.deepEqual(detail.labels, ['form.skills']);
    assert.equal(detail.effectiveState, 'ignored');
    assert.equal(f.catalog.list({ ...defaultFilter, state: 'all' }).total, 1);
  } finally {
    await f.close();
  }
});
for (const judgmentLimit of [100, -1])
  test(`cancelling after a completed judgment keeps success and untouched candidates (limit ${judgmentLimit})`, async () => {
    const f = setup({ count: 4, pauseAfter: 1 });
    try {
      const started = f.collection.start({
        kind: 'collect',
        settings: { ...defaults, judgmentLimit, discoveryRequestLimit: 5 },
      });
      for (let i = 0; i < 200 && f.collection.getRun(started.run.id).stats.judged < 1; i++)
        await new Promise((r) => setTimeout(r, 2));
      assert.equal(f.collection.getRun(started.run.id).stats.judged, 1);
      assert.equal(f.collection.getRun(started.run.id).stats.cost, null);
      assert.equal(f.collection.getRun(started.run.id).stats.inputTokens, null);
      f.collection.cancel(started.run.id);
      await f.collection.shutdown();
      const run = f.collection.getRun(started.run.id);
      assert.equal(run.status, 'cancelled');
      assert.equal(run.stats.requests, 2);
      assert.equal(f.catalog.list(defaultFilter).total, 1);
      assert.equal(run.stats.pending, 2);
      assert.equal(run.stats.cost, null);
    } finally {
      await f.close();
    }
  });
test('fresh metadata and explicit rejudge both enforce current thresholds before dispatch', async () => {
  const f = setup({ freshStars: 50 });
  try {
    const run = await f.run();
    assert.equal(run.stats.thresholdFiltered, 1);
    assert.equal(f.calls(), 0);
    assert.equal(getRepository(f.db, metadata.id)?.checkedAt, null);
  } finally {
    await f.close();
  }
  const g = setup();
  try {
    await g.run();
    const reads = g.reads();
    g.catalog.saveSettings({
      collection: { ...defaults, minStars: Number.MAX_SAFE_INTEGER },
      view: defaultFilter,
    });
    const started = g.collection.start({ kind: 'rejudge', repositoryId: metadata.id });
    for (let i = 0; i < 100 && !g.collection.getRun(started.run.id).endedAt; i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(g.collection.getRun(started.run.id).stats.requests, 0);
    assert.equal(g.reads(), reads);
  } finally {
    await g.close();
  }
});
test('same-timestamp failed attempts stay blocked regardless of UUID lexical order', async () => {
  const options = { broken: false };
  const f = setup(options);
  try {
    await f.run();
    const record = getRepository(f.db, metadata.id)!;
    f.db
      .prepare('UPDATE judgments SET id=? WHERE id=?')
      .run('ffffffff-ffff-4fff-bfff-ffffffffffff', record.judgmentId!);
    record.judgmentId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    saveRepository(f.db, record);
    f.setText(evidence.readme.text + ' new');
    options.broken = true;
    await f.run('collect', 0);
    f.db
      .prepare(
        "UPDATE judgments SET id='00000000-0000-4000-8000-000000000000' WHERE state='unknown'",
      )
      .run();
    options.broken = false;
    const next = await f.run('continue', 0);
    assert.equal(f.calls(), 2);
    assert.ok(next.gaps.some((v) => v.includes('明确重试')));
  } finally {
    await f.close();
  }
});

for (const limit of [1, 3])
  test(`regression: the final quota slot belongs to the highest-Star eligible candidate (limit ${limit})`, async () => {
    const f = setup({ count: 4, slowHighest: true });
    try {
      const run = await f.run('collect', 0, limit);
      assert.equal(run.stats.requests, limit);
      assert.deepEqual(
        [...f.sent].sort(),
        Array.from({ length: limit }, (_, i) => metadata.owner + '/repo' + i),
      );
    } finally {
      await f.close();
    }
  });
test('regression: restoring model suggestions deletes the manual override, while an empty manual label set remains explicit', async () => {
  const f = setup();
  try {
    await f.run();
    f.catalog.setOverride(metadata.id, { decision: 'ignore', labels: [] });
    assert.deepEqual(f.catalog.get(metadata.id).labels, []);
    f.catalog.setOverride(metadata.id, { decision: null, labels: null });
    assert.equal(f.catalog.get(metadata.id).override, null);
    assert.equal(f.catalog.list(defaultFilter).items[0].override, null);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM overrides').get()?.n, 0);
    assert.ok(f.catalog.get(metadata.id).labels.length > 0);
  } finally {
    await f.close();
  }
});
test('regression: running progress reports the persisted queue before the first judgment returns', async () => {
  const f = setup({ count: 4, pauseAfter: 0 });
  try {
    const started = f.collection.start({
      kind: 'collect',
      settings: { ...defaults, discoveryRequestLimit: 5 },
    });
    for (let i = 0; i < 200 && f.calls() < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(f.calls(), 2);
    const run = f.collection.getRun(started.run.id);
    assert.equal(run.status, 'running');
    assert.equal(run.stats.pending, 4);
    assert.equal(run.stats.pending, pendingCount(f.db));
    assert.equal(run.stats.inputTokens, null);
    assert.equal(run.stats.outputTokens, null);
    assert.equal(run.stats.cost, null);
  } finally {
    await f.close();
  }
});
test('slow unlimited discovery reserves time to classify committed candidates in the same task', async () => {
  const f = setup({ discoveryPauseAfter: 1, maxDurationMs: 400, discoveryBudget: -1 });
  try {
    const run = await f.run();
    assert.equal(run.stats.discovered, 1);
    assert.equal(run.stats.judged, 1);
    assert.equal(f.calls(), 1);
    assert.equal(run.status, 'partial');
    assert.deepEqual(run.errors, []);
    assert.ok(run.gaps.some((gap) => gap.includes('发现阶段达到时间预算')));
    assert.equal(f.catalog.get(metadata.id).state, 'collected');
  } finally {
    await f.close();
  }
});

test('regression: discovery timeout after committed results is partial and manual continue judges saved candidates', async () => {
  const f = setup({ discoveryTimeoutAfter: 1 });
  try {
    const run = await f.run();
    assert.equal(run.status, 'partial');
    assert.equal(run.stats.discovered, 1);
    assert.equal(run.stats.pending, 1);
    assert.match(run.errors.join(' '), /超时/);
    assert.ok(run.gaps.length > 0);
    assert.equal(f.calls(), 0);
    const next = await f.run('continue');
    assert.equal(next.stats.judged, 1);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});
test('empty descriptive evidence is filtered before paid dispatch and obeys the refresh interval', async () => {
  const f = setup({ blankEvidence: true });
  try {
    f.setText(' \n\t');
    const run = await f.run();
    assert.equal(run.stats.emptyEvidenceFiltered, 1);
    assert.equal(run.stats.requests, 0);
    assert.equal(f.calls(), 0);
    const detail = f.catalog.get(metadata.id);
    assert.equal(detail.state, 'filtered');
    assert.equal(detail.filterReason, '无有效分类证据');
    assert.ok(detail.evidence);
    assert.equal(detail.judgments.length, 0);
    assert.equal((await f.run()).stats.skipped, 1);
    assert.equal((await f.run('collect', 0)).stats.emptyEvidenceFiltered, 1);
    assert.equal(f.calls(), 0);
    const rejudge = f.collection.start({ kind: 'rejudge', repositoryId: metadata.id });
    for (let i = 0; i < 100 && !f.collection.getRun(rejudge.run.id).endedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(f.collection.getRun(rejudge.run.id).stats.requests, 0);
  } finally {
    await f.close();
  }
  const g = setup();
  try {
    g.setText('');
    assert.equal((await g.run()).stats.judged, 1);
  } finally {
    await g.close();
  }
});

test('README removal clears current model classification while preserving judgment history', async () => {
  const options: { missing?: boolean } = {};
  const f = setup(options);
  try {
    await f.run();
    assert.ok(f.catalog.get(metadata.id).labels.length);
    options.missing = true;
    f.advance();
    const run = await f.run('collect', 0);
    const detail = f.catalog.get(metadata.id);
    assert.equal(run.stats.noReadme, 1);
    assert.equal(detail.state, 'filtered');
    assert.equal(detail.filterReason, '无 README');
    assert.equal(detail.evidence, null);
    assert.equal(detail.judgmentId, null);
    assert.deepEqual(detail.labels, []);
    assert.deepEqual(Object.values(detail.facetStates), ['unjudged', 'unjudged', 'unjudged']);
    assert.equal(detail.judgments.length, 1);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test('pending progress counts each repository once across queued work and new state', () => {
  const db = openDatabase(':memory:');
  try {
    saveRepository(db, repository({ state: 'new' }));
    db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run('a', '{}');
    db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run('b', '{}');
    const insert = db.prepare(
      "INSERT INTO work_items(run_id,repository_id,state,candidate) VALUES(?,?,'pending','{}')",
    );
    insert.run('a', metadata.id);
    insert.run('b', metadata.id);
    saveRepository(db, repository({ id: metadata.id + 1 }));
    insert.run('a', metadata.id + 1);
    assert.equal(pendingCount(db), 2);
  } finally {
    db.close();
  }
});

for (const state of ['error', 'pending'] as const)
  test(`changed evidence clears current model labels while ${state}, preserving history and manual decisions`, async () => {
    const options: { pauseAfter?: number; jevStatus?: number } = {};
    const f = setup(options);
    const id = metadata.id;
    try {
      await f.run();
      const before = f.catalog.get(id);
      assert.ok(before.labels.includes('form.tools'));
      if (state === 'pending')
        f.catalog.setOverride(id, { decision: 'keep', labels: ['purpose.office'] });
      f.advance();
      f.setText(evidence.readme.text + ' changed capabilities');
      if (state === 'error') {
        options.jevStatus = 400;
        await f.run('collect', 0, 1);
      } else {
        options.pauseAfter = 1;
        f.collection.start({
          kind: 'collect',
          settings: { ...defaults, refreshIntervalDays: 0, discoveryRequestLimit: 5 },
        });
        for (let i = 0; i < 200 && f.calls() < 2; i++)
          await new Promise((resolve) => setTimeout(resolve, 2));
        assert.equal(f.calls(), 2);
      }
      const detail = f.catalog.get(id);
      assert.equal(detail.state, state);
      assert.notEqual(detail.evidenceId, before.evidenceId);
      assert.equal(detail.judgmentId, null);
      assert.ok(detail.judgments.some((j) => j.id === before.judgmentId && j.state === 'complete'));
      assert.equal(
        f.catalog
          .list({ ...defaultFilter, state: 'all', labels: ['form.tools'] })
          .items.some((r) => r.id === id),
        false,
      );
      if (state === 'pending') {
        assert.deepEqual(detail.override, { decision: 'keep', labels: ['purpose.office'] });
        assert.deepEqual(detail.labels, ['purpose.office']);
        f.catalog.setOverride(id, { decision: null, labels: null });
      }
      const restored = f.catalog.get(id);
      assert.deepEqual(restored.labels, []);
      assert.deepEqual(Object.values(restored.facetStates), ['unjudged', 'unjudged', 'unjudged']);
    } finally {
      await f.close();
    }
  });

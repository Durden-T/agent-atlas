import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDatabase, saveRepository, getRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';
import { saveRun } from '../src/server/collection/store.ts';
import { defaults, emptyStats, defaultFilter } from '../src/shared/contracts.ts';
import { repository } from './fixtures.ts';

test('restart does not present a known subtotal as total usage after an uncertain dispatch', () => {
  for (const state of ['submitted', 'unknown', 'prepared'] as const) {
    const dir = mkdtempSync(tmpdir() + '/atlas-partial-'),
      path = dir + '/atlas.sqlite';
    let db = openDatabase(path);
    try {
      saveRepository(db, repository());
      saveRun(db, {
        id: 'partial-run',
        command: { kind: 'collect', settings: defaults },
        status: 'running',
        stage: '判断',
        startedAt: new Date().toISOString(),
        endedAt: null,
        stats: {
          ...emptyStats(),
          judged: 1,
          requests: state === 'prepared' ? 1 : 2,
          inputTokens: 100,
          outputTokens: 20,
          cost: 0.001,
        },
        errors: [],
        gaps: [],
      });
      const insert = db.prepare(
        "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES(?,?,'partial-run',?,?,?)",
      );
      insert.run('completed', repository().id, 'known', 'complete', new Date().toISOString());
      insert.run('next', repository().id, 'next', state, new Date().toISOString());
      db.close();
      db = openDatabase(path);
      const run = JSON.parse(
        String(db.prepare("SELECT data FROM runs WHERE id='partial-run'").get()?.data),
      );
      assert.equal(run.status, 'interrupted');
      assert.equal(run.stats.judged, 1);
      assert.equal(run.stats.unknownRequests, state === 'prepared' ? 0 : 1);
      for (const [field, known] of Object.entries({
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.001,
      }))
        assert.equal(run.stats[field], state === 'prepared' ? known : null, `${state}: ${field}`);
    } finally {
      db.close();
      rmSync(dir, { recursive: true });
    }
  }
});

test('local HTTP reads are offline; mutations enforce origin, validation, and durable overrides', async () => {
  const db = openDatabase(':memory:');
  let externalCalls = 0;
  const network = async () => {
    externalCalls++;
    throw new Error('Read-only page initiated external traffic');
  };
  const catalog = createCatalog(db),
    collection = createCollection({
      db,
      github: createGithub({ token: () => 'test-key', fetch: network }),
      judgment: createJudgment({ key: () => undefined, fetch: network }),
      settings: () => defaults,
      canJudge: () => false,
    });
  saveRepository(db, repository());
  const server = createHttpServer({
    catalog,
    collection,
    status: () => ({
      databasePath: ':memory:',
      jevConfigured: false,
      githubAuthentication: 'missing',
    }),
    webRoot: resolve('.'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  const request = (path: string, input?: unknown, headers?: Record<string, string>) =>
    fetch(
      origin + path,
      input === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(input),
          },
    );
  try {
    for (const path of [
      '/',
      '/api/settings',
      '/api/folders',
      '/api/status',
      '/api/resources',
      '/api/resources/' + repository().id,
      '/api/runs',
    ])
      assert.equal((await request(path)).status, 200);
    assert.equal(externalCalls, 0);
    assert.equal(catalog.get(repository().id).viewed, false, 'GET detail stays read-only');
    const folderResponse = await request('/api/folders', { kind: 'create', name: 'HTTP 收藏' });
    assert.equal(folderResponse.status, 200);
    const folder = await folderResponse.json();
    assert.equal(
      (
        await request('/api/resources/' + repository().id + '/personal', {
          viewed: true,
          folderIds: [folder.id],
        })
      ).status,
      200,
    );
    assert.equal(catalog.get(repository().id).viewed, true);
    assert.deepEqual(catalog.get(repository().id).folders, [folder]);
    assert.equal(
      (
        await request(
          '/api/resources/' + repository().id + '/personal',
          { viewed: false },
          { Origin: 'https://example.com' },
        )
      ).status,
      403,
    );
    assert.equal((await request('/api/folders', { kind: 'create', name: '' })).status, 400);
    assert.equal(
      (await request('/api/resources/' + repository().id + '/personal', { folderIds: [999] }))
        .status,
      404,
    );
    assert.equal(catalog.get(repository().id).viewed, true);
    assert.equal((await request('/api/folders', { kind: 'delete', id: folder.id })).status, 200);
    assert.deepEqual(catalog.get(repository().id).folders, []);

    assert.equal(
      (
        await request(
          '/api/runs',
          { kind: 'collect', settings: defaults },
          { Origin: 'https://example.com' },
        )
      ).status,
      403,
    );
    assert.equal((await request('/api/runs', { kind: 'collect', settings: defaults })).status, 400);
    assert.equal(
      (
        await request('/api/settings', {
          collection: { ...defaults, judgmentLimit: 0 },
          view: defaultFilter,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/api/settings', {
          collection: { ...defaults, judgmentLimit: 4 },
          view: { ...defaultFilter, state: 'all' },
        })
      ).status,
      200,
    );
    assert.equal(catalog.getSettings().collection.judgmentLimit, 4);
    assert.equal(
      (
        await request('/api/settings', {
          collection: { ...defaults, judgmentLimit: -1, discoveryRequestLimit: -1 },
          view: defaultFilter,
        })
      ).status,
      200,
    );
    assert.equal(catalog.getSettings().collection.judgmentLimit, -1);
    assert.equal(catalog.getSettings().collection.discoveryRequestLimit, -1);
    assert.equal(
      (
        await request('/api/resources/' + repository().id + '/override', {
          decision: 'ignore',
          labels: [],
        })
      ).status,
      200,
    );
    assert.equal(catalog.get(repository().id).effectiveState, 'ignored');
    assert.equal((await request('/api/resources?filter=%7B')).status, 400);
    assert.equal((await request('/api/resources?page=0')).status, 400);
    assert.equal((await request('/api/no-such-route')).status, 404);
    assert.equal((await request('/api/runs/missing/cancel', {})).status, 404);
    assert.equal((await request('/missing.js')).status, 404);
    assert.equal(
      (await request('/api/status')).headers
        .get('content-security-policy')
        ?.includes("frame-ancestors 'none'"),
      true,
    );
  } finally {
    await collection.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});
test('restart preserves records and overrides, interrupts active runs and marks uncertain dispatches', () => {
  const dir = mkdtempSync(tmpdir() + '/atlas-restart-'),
    path = dir + '/atlas.sqlite';
  let db = openDatabase(path);
  try {
    saveRepository(db, repository());
    createCatalog(db).setOverride(repository().id, { decision: 'keep', labels: ['form.skills'] });
    saveRun(db, {
      id: 'run',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: '判断',
      startedAt: new Date().toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    });
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES('j',?,'run','k','submitted',?)",
    ).run(repository().id, new Date().toISOString());
    db.close();
    db = openDatabase(path);
    assert.equal(getRepository(db, repository().id)?.state, 'unknown');
    assert.deepEqual(createCatalog(db).get(repository().id).labels, ['form.skills']);
    const run = JSON.parse(String(db.prepare("SELECT data FROM runs WHERE id='run'").get()?.data));
    assert.equal(run.status, 'interrupted');
    assert.equal(run.stats.unknownRequests, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
test('custom database path does not change permissions of an existing shared parent directory', async () => {
  const { chmodSync, statSync } = await import('node:fs');
  const dir = mkdtempSync(tmpdir() + '/atlas-permissions-');
  chmodSync(dir, 0o755);
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dir + '/atlas.sqlite');
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    assert.equal(statSync(dir + '/atlas.sqlite').mode & 0o777, 0o600);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true });
  }
});
test('restart keeps prepared requests uncharged and resumable, while submitted requests stay unknown', () => {
  const dir = mkdtempSync(tmpdir() + '/atlas-prepared-'),
    path = dir + '/atlas.sqlite';
  let db = openDatabase(path);
  try {
    saveRepository(db, repository({ state: 'pending', checkedAt: null }));
    saveRun(db, {
      id: 'prepared-run',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: 'prepared',
      startedAt: new Date().toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    });
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES('prepared-j',?,'prepared-run','k','prepared',?)",
    ).run(repository().id, new Date().toISOString());
    db.prepare(
      "INSERT INTO work_items(run_id,repository_id,state) VALUES('prepared-run',?,'prepared')",
    ).run(repository().id);
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT state FROM judgments WHERE id='prepared-j'").get()?.state,
      'not_sent',
    );
    assert.equal(
      db.prepare("SELECT state FROM work_items WHERE run_id='prepared-run'").get()?.state,
      'pending',
    );
    assert.equal(getRepository(db, repository().id)?.state, 'pending');
    const run = JSON.parse(
      String(db.prepare("SELECT data FROM runs WHERE id='prepared-run'").get()?.data),
    );
    assert.equal(run.stats.unknownRequests, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test('a second process cannot recover or mutate a database owned by a running application', () => {
  const dir = mkdtempSync(tmpdir() + '/atlas-exclusive-');
  const path = dir + '/atlas.sqlite';
  let db = openDatabase(path);
  try {
    saveRepository(db, repository());
    saveRun(db, {
      id: 'live-run',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: '判断',
      startedAt: new Date().toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    });
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES('live-j',?,'live-run','live','submitted',?)",
    ).run(repository().id, new Date().toISOString());
    const second = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {openDatabase} from './src/server/database.ts';openDatabase(${JSON.stringify(path)}).close();`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    const active = JSON.parse(
      String(db.prepare("SELECT data FROM runs WHERE id='live-run'").get()?.data),
    );
    assert.equal(active.status, 'running', 'Duplicate startup must not interrupt a live run');
    assert.equal(
      db.prepare("SELECT state FROM judgments WHERE id='live-j'").get()?.state,
      'submitted',
    );
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /数据库正在被其他进程使用/);
    db.close();
    db = openDatabase(path);
    const recovered = JSON.parse(
      String(db.prepare("SELECT data FROM runs WHERE id='live-run'").get()?.data),
    );
    assert.equal(recovered.status, 'interrupted');
    assert.equal(
      db.prepare("SELECT state FROM judgments WHERE id='live-j'").get()?.state,
      'unknown',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

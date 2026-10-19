import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  saveRepository,
  getEvidence,
  getRepository,
} from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { processRepository, type WorkContext } from '../src/server/collection/work.ts';
import { pendingCandidates, saveRun } from '../src/server/collection/store.ts';
import { defaults, emptyStats } from '../src/shared/contracts.ts';
import { api } from '../src/web/api.ts';
import {
  repository,
  metadata,
  evidence,
  githubMetadata,
  providerResponse,
  now,
} from './fixtures.ts';

function setup() {
  const db = openDatabase(':memory:');
  let fresh = metadata,
    etag = 'v1',
    status = 200,
    reads = 0,
    calls = 0;
  const ctx: WorkContext = {
    db,
    run: {
      id: 'review',
      command: { kind: 'continue', settings: defaults, retryErrors: false },
      status: 'running',
      stage: '',
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    },
    settings: { ...defaults, updatedWithinDays: null, refreshIntervalDays: 0 },
    signal: AbortSignal.timeout(10000),
    now: () => now,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    dispatchStopped: false,
    github: createGithub({
      token: () => 'test-key',
      fetch: async (url) => {
        reads++;
        return String(url).endsWith('/readme')
          ? Response.json(
              {
                path: 'README.md',
                sha: 'same',
                encoding: 'base64',
                content: Buffer.from(evidence.readme.text).toString('base64'),
              },
              { headers: { etag } },
            )
          : Response.json(githubMetadata(fresh), { headers: { etag } });
      },
    }),
    judgment: createJudgment({
      key: () => 'test-key',
      fetch: async () => {
        calls++;
        return Response.json(status === 200 ? providerResponse() : { error: 'Rejected' }, {
          status,
        });
      },
    }),
  };
  saveRepository(db, repository({ state: 'new', checkedAt: null }));
  saveRun(db, ctx.run);
  return {
    db,
    ctx,
    setFresh: (value: typeof metadata) => {
      fresh = value;
    },
    setEtag: (value: string) => {
      etag = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
    reads: () => reads,
    calls: () => calls,
  };
}

test('folder migration preserves memberships and never reuses a deleted identity after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-folder-migration-')),
    filename = join(dir, 'atlas.sqlite');
  let db: DatabaseSync = new DatabaseSync(filename);
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE repositories(id INTEGER PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE folders(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE); CREATE TABLE repository_folders(repository_id INTEGER REFERENCES repositories(id),folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,PRIMARY KEY(repository_id,folder_id));',
    );
    saveRepository(db, repository());
    db.prepare("INSERT INTO folders(id,name) VALUES(41,'Original')").run();
    db.prepare('INSERT INTO repository_folders VALUES(?,41)').run(metadata.id);
    db.close();
    db = openDatabase(filename);
    const catalog = createCatalog(db);
    assert.deepEqual(catalog.get(metadata.id).folders, [{ id: 41, name: 'Original' }]);
    catalog.changeFolder({ kind: 'delete', id: 41 });
    db.close();
    db = openDatabase(filename);
    const replacement = createCatalog(db).changeFolder({ kind: 'create', name: 'Replacement' })!;
    assert.ok(replacement.id > 41);
    assert.throws(() => createCatalog(db).setPersonal(metadata.id, { folderIds: [41] }), /不存在/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test('an unsent attempt cannot clear an unresolved paid failure', async () => {
  const f = setup();
  try {
    saveRepository(f.db, repository({ state: 'pending', checkedAt: null }));
    const insert = f.db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES(?,?,'old','old',?,'2026-10-14T00:00:00Z')",
    );
    insert.run('paid', metadata.id, 'unknown');
    insert.run('cancelled-before-send', metadata.id, 'not_sent');
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    assert.equal(f.calls(), 0);
    assert.equal(f.reads(), 0);
    assert.match(f.ctx.run.gaps.join(' '), /明确重试/);
  } finally {
    f.db.close();
  }
});

test('blocked paid failures do not starve lower-star pending work before the queue limit', () => {
  const f = setup();
  try {
    const blocked = repository({ state: 'error' });
    saveRepository(f.db, blocked);
    f.db
      .prepare(
        "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at) VALUES('paid',?,'old','old','error','2026-10-14T00:00:00Z')",
      )
      .run(metadata.id);
    const pending = repository({
      id: metadata.id + 1,
      state: 'new',
      metadata: { ...metadata, id: metadata.id + 1, stars: 100 },
    });
    saveRepository(f.db, pending);
    assert.deepEqual(
      pendingCandidates(f.db, f.ctx.run, 1).map((r) => r.record.id),
      [pending.id],
    );
  } finally {
    f.db.close();
  }
});

test('successful fresh metadata below the threshold replaces the stale local snapshot', async () => {
  const f = setup();
  try {
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    f.setFresh({ ...metadata, stars: 50 });
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    assert.equal(getRepository(f.db, metadata.id)!.metadata.stars, 50);
    assert.equal(f.calls(), 1);
  } finally {
    f.db.close();
  }
});

test('metadata-only refresh persists new conditional validators without a new evidence version', async () => {
  const f = setup();
  try {
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    const id = getRepository(f.db, metadata.id)!.evidenceId;
    f.setFresh({ ...metadata, stars: metadata.stars + 1 });
    f.setEtag('v2');
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    assert.equal(getRepository(f.db, metadata.id)!.evidenceId, id);
    assert.equal(getEvidence(f.db, id)!.metadataEtag, 'v2');
    assert.equal(f.calls(), 1);
  } finally {
    f.db.close();
  }
});

test('an eligible repository loses its obsolete filtering reason even when judgment fails', async () => {
  const f = setup();
  try {
    saveRepository(
      f.db,
      repository({ state: 'filtered', checkedAt: null, filterReason: '无 README' }),
    );
    f.setStatus(500);
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    const saved = getRepository(f.db, metadata.id)!;
    assert.equal(saved.state, 'error');
    assert.equal(saved.filterReason, null);
    assert.match(saved.error!, /HTTP 500/);
  } finally {
    f.db.close();
  }
});

test('account rejection cancels queued dispatches across independent callers and permits a later explicit attempt', async () => {
  let rejectFirst!: () => void,
    releaseSecond!: () => void,
    calls = 0;
  const judgment = createJudgment({
    key: () => 'test-key',
    fetch: async () => {
      const call = ++calls;
      if (call === 1) {
        await new Promise<void>((r) => {
          rejectFirst = r;
        });
        return new Response(null, { status: 402 });
      }
      if (call === 2)
        await new Promise<void>((r) => {
          releaseSecond = r;
        });
      return Response.json(providerResponse());
    },
  });
  const signal = AbortSignal.timeout(10000),
    requests = [
      judgment.judge(evidence, signal),
      judgment.judge(evidence, signal),
      judgment.judge(evidence, signal),
    ];
  const settled = Promise.allSettled(requests);
  rejectFirst();
  await requests[0].catch(() => {});
  releaseSecond();
  const results = await settled;
  assert.equal(results[2].status, 'rejected');
  assert.equal(calls, 2);
  await judgment.judge(evidence, signal);
  assert.equal(calls, 3);
});

test('a 200 response without validators clears obsolete ETags and follows numeric rename redirects', async () => {
  const f = setup();
  try {
    await processRepository(f.ctx, getRepository(f.db, metadata.id)!, metadata);
    const previous = getEvidence(f.db, getRepository(f.db, metadata.id)!.evidenceId);
    const github = createGithub({
      token: () => 'test-key',
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === '/repos/' + metadata.full_name)
          return new Response(null, {
            status: 301,
            headers: { location: 'https://api.github.com/repositories/' + metadata.id },
          });
        if (path.endsWith('/readme'))
          return Response.json({
            path: 'README.md',
            sha: 'same',
            encoding: 'base64',
            content: Buffer.from(evidence.readme.text).toString('base64'),
          });
        return Response.json(githubMetadata());
      },
    });
    const read = await github.read(metadata, repository(), previous, AbortSignal.timeout(10000));
    assert.equal(read.snapshot!.metadataEtag, null);
    assert.equal(read.snapshot!.readmeEtag, null);
  } finally {
    f.db.close();
  }
});

test('shared browser requests have a deadline and retain caller cancellation', async (t) => {
  const timeout = new AbortController();
  let received: AbortSignal | undefined;
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 15000);
    return timeout.signal;
  });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    received = init.signal!;
    return Response.json({ ok: true });
  });
  await api('/api/status');
  assert.ok(received);
  timeout.abort();
  assert.equal(received.aborted, true);
  const caller = new AbortController();
  await api('/api/status', undefined, caller.signal);
  caller.abort();
  assert.equal(received.aborted, true);
});

test('discovery provenance is bounded and older sources remain accessible by page', () => {
  const f = setup();
  try {
    const insert = f.db.prepare('INSERT INTO sources(repository_id,key,data) VALUES(?,?,?)');
    for (let i = 0; i < 101; i++)
      insert.run(
        metadata.id,
        'entry-' + i,
        JSON.stringify({
          key: 'entry-' + i,
          label: String(i),
          parentId: null,
          discoveredAt: new Date(now + i).toISOString(),
        }),
      );
    const first = createCatalog(f.db).get(metadata.id).sources;
    assert.equal(Array.isArray(first), false, 'Source history must carry bounded page metadata');
    assert.equal(first.items.length, 50);
    assert.equal(first.total, 101);
    assert.equal(first.items[0].key, 'entry-100');
    const second = createCatalog(f.db).get(metadata.id, 2).sources;
    assert.equal(second.items.length, 50);
    assert.equal(second.items[0].key, 'entry-50');
  } finally {
    f.db.close();
  }
});

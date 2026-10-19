import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openDatabase, saveRepository, transaction } from '../src/server/database.ts';
import { pendingCandidates } from '../src/server/collection/store.ts';
import { defaults, emptyStats, type RunRecord } from '../src/shared/contracts.ts';
import { repository, metadata } from './fixtures.ts';

test('large pending queues remain responsive and prefer current-run candidates over newer backlog', () => {
  const db = openDatabase(':memory:');
  const count = 12000;
  try {
    const current: RunRecord = {
      id: 'current',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: '读取与判断',
      startedAt: new Date().toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    const addRun = db.prepare('INSERT INTO runs(id,data) VALUES(?,?)');
    for (const id of ['current', 'backlog']) addRun.run(id, JSON.stringify({ ...current, id }));
    const addWork = db.prepare(
      "INSERT INTO work_items(run_id,repository_id,state,candidate) VALUES(?,?,'pending',?)",
    );
    transaction(db, () => {
      for (let i = 0; i < count; i++) {
        const meta = { ...metadata, id: metadata.id + i, full_name: 'queue/repo' + i, stars: i };
        saveRepository(db, repository({ id: meta.id, metadata: meta, state: 'new' }));
        addWork.run('current', meta.id, JSON.stringify(meta));
        addWork.run('backlog', meta.id, JSON.stringify({ ...meta, stars: 10000 + i }));
      }
    });
    const started = performance.now();
    const rows = pendingCandidates(db, current, 50);
    const duration = performance.now() - started;
    assert.equal(rows.length, 50);
    assert.deepEqual(
      rows.map((r) => r.candidate.stars),
      Array.from({ length: 50 }, (_, i) => count - 1 - i),
    );
    assert.ok(
      duration < 1000,
      `${count} repositories must select their queue within 1s, took ${duration.toFixed(0)}ms`,
    );
  } finally {
    db.close();
  }
});

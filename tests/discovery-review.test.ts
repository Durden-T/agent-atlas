import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { discover } from '../src/server/collection/discovery.ts';
import { saveRun } from '../src/server/collection/store.ts';
import { createGithub } from '../src/server/github.ts';
import { defaults, emptyStats, type RunRecord } from '../src/shared/contracts.ts';
import { repository, now } from './fixtures.ts';

test('attempted unfinished discovery work cannot hide the backlog beyond the first thousand rows', async () => {
  const db = openDatabase(':memory:'),
    seen = new Set<string>();
  try {
    const settings = { ...defaults, updatedWithinDays: null, discoveryRequestLimit: -1 },
      bucket = JSON.stringify(['intervals-v2', settings.minStars, null]);
    const insert = db.prepare('INSERT INTO discovery_work(key,data,visited) VALUES(?,?,?)');
    for (let i = 0; i < 1001; i++)
      insert.run(
        'unfinished-' + i,
        JSON.stringify({
          kind: 'search',
          bucket,
          keyword: 'old-' + i,
          page: 1,
          pushedDate: null,
          start: null,
          end: null,
          grain: 'root',
          starMin: 100,
          starMax: null,
          done: false,
        }),
        i,
      );
    const run: RunRecord = {
      id: 'fair',
      command: { kind: 'collect', settings },
      status: 'running',
      stage: '',
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    saveRun(db, run);
    const github = createGithub({
      token: () => 'test-key',
      fetch: async (url) => {
        const query = new URL(String(url)).searchParams.get('q')!;
        seen.add(query.split(' ')[0]);
        return Response.json({ items: [], total_count: 1, incomplete_results: true });
      },
    });
    await discover({
      db,
      run,
      settings,
      github,
      signal: AbortSignal.timeout(30000),
      now: () => now,
    });
    assert.ok(
      seen.has('old-1000'),
      'An unfinished first window must not permanently starve later work',
    );
  } finally {
    db.close();
  }
});

test('the author limit counts distinct owners rather than prolific repositories', async () => {
  const db = openDatabase(':memory:'),
    owners: string[] = [];
  try {
    const insertSource = db.prepare('INSERT INTO sources(repository_id,key,data) VALUES(?,?,?)');
    for (let i = 0; i < 1002; i++) {
      const record = repository({
        id: i + 1,
        judgmentId: 'relevant',
        metadata: {
          ...repository().metadata,
          id: i + 1,
          owner: i === 1001 ? 'second-owner' : 'first-owner',
          full_name: 'owner/repo-' + i,
          stars: 2000 - i,
        },
      });
      saveRepository(db, record);
      insertSource.run(record.id, 'search', JSON.stringify({ parentId: null }));
    }
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES('relevant',1,'old','old','complete','2026-10-14T00:00:00Z',?)",
    ).run(
      JSON.stringify({ decisions: { relevance: { type: 'noul', noul: 1, needsReview: false } } }),
    );
    const settings = { ...defaults, updatedWithinDays: null, discoveryRequestLimit: 20 };
    const run: RunRecord = {
      id: 'owners',
      command: { kind: 'collect', settings },
      status: 'running',
      stage: '',
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    saveRun(db, run);
    const github = createGithub({
      token: () => 'test-key',
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.startsWith('/orgs/')) {
          owners.push(path.split('/')[2]);
          return Response.json([]);
        }
        return Response.json({ items: [], total_count: 0, incomplete_results: false });
      },
    });
    await discover({
      db,
      run,
      settings,
      github,
      signal: AbortSignal.timeout(30000),
      now: () => now,
    });
    assert.deepEqual(owners.sort(), ['first-owner', 'second-owner']);
  } finally {
    db.close();
  }
});

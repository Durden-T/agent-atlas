import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, saveRepository, getRepository } from '../src/server/database.ts';
import { createGithub } from '../src/server/github.ts';
import { discover } from '../src/server/collection/discovery.ts';
import { saveRun } from '../src/server/collection/store.ts';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { taxonomy } from '../src/shared/taxonomy.ts';
import { defaults, emptyStats, type RunRecord } from '../src/shared/contracts.ts';
import { now, evidence, repository, providerResponse, githubMetadata } from './fixtures.ts';

for (const discoveryRequestLimit of [1000, -1])
  for (const mode of ['pagination', 'segmentation'] as const)
    test(`${mode} and owner successors reopen across two complete discovery cycles (budget ${discoveryRequestLimit})`, async () => {
      const db = openDatabase(':memory:');
      let cycle = 0;
      const calls: string[][] = [[], []];
      try {
        const seed = repository();
        saveRepository(db, { ...seed, judgmentId: 'seed' });
        const result = interpretResponse(
          providerResponse(),
          buildJevBody(evidence, taxonomy).questions,
        );
        db.prepare(
          "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES('seed',?,'seed','seed','complete',?,?)",
        ).run(seed.id, new Date(now).toISOString(), JSON.stringify(result));
        db.prepare('INSERT INTO sources(repository_id,key,data) VALUES(?,?,?)').run(
          seed.id,
          'search',
          JSON.stringify({ parentId: null }),
        );
        const github = {
          search: async (q: string, page: number, _signal: AbortSignal, consume: () => void) => {
            consume();
            calls[cycle].push(`search:${page}:${q}`);
            const leaf = mode === 'pagination' ? page === 2 : q.includes('created:');
            const meta = { ...seed.metadata, id: seed.id + 10 + cycle };
            return {
              items:
                mode === 'pagination'
                  ? Array.from({ length: 100 }, (_, i) => ({
                      ...(leaf ? meta : seed.metadata),
                      id: (leaf ? meta.id : seed.id) + i * 100,
                    }))
                  : [leaf ? meta : seed.metadata],
              total: mode === 'pagination' ? 200 : leaf ? 1 : 1001,
              incomplete: false,
            };
          },
          owner: async (
            _owner: string,
            _type: string,
            page: number,
            _signal: AbortSignal,
            consume: () => void,
          ) => {
            consume();
            calls[cycle].push('owner:' + page);
            return { items: [{ ...seed.metadata, id: seed.id + 20 + cycle }], hasNext: page === 1 };
          },
          read: async () => {
            throw new Error('unused');
          },
        };
        for (cycle = 0; cycle < 2; cycle++) {
          const settings = { ...defaults, discoveryRequestLimit };
          const run: RunRecord = {
            id: mode + cycle,
            command: { kind: 'collect', settings },
            status: 'running',
            stage: 'discover',
            startedAt: new Date(now).toISOString(),
            endedAt: null,
            stats: emptyStats(),
            errors: [],
            gaps: [],
          };
          saveRun(db, run);
          await discover({
            db,
            run,
            settings,
            github,
            signal: new AbortController().signal,
            now: () => now,
          });
          assert.deepEqual(run.gaps, []);
        }
        assert.ok(
          calls[1].some((c) =>
            mode === 'pagination' ? c.startsWith('search:2:') : c.includes('created:'),
          ),
        );
        assert.ok(calls[1].includes('owner:2'));
        if (discoveryRequestLimit === -1 && mode === 'segmentation') {
          assert.ok(calls[1].length > 40);
          assert.ok(calls[1].indexOf('owner:1') < calls[1].length - 2);
        }
        assert.ok(getRepository(db, seed.id + 11));
      } finally {
        db.close();
      }
    });

test('all five discovery searches send actual GitHub Star ordering and threshold parameters', async () => {
  const db = openDatabase(':memory:');
  const urls: URL[] = [];
  try {
    const github = createGithub({
      token: () => 'test-key',
      fetch: async (url) => {
        urls.push(new URL(String(url)));
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      },
    });
    const run: RunRecord = {
      id: 'queries',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: 'discover',
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    await discover({
      db,
      run,
      settings: { ...defaults, discoveryRequestLimit: 5 },
      github,
      signal: new AbortController().signal,
      now: () => now,
    });
    assert.equal(urls.length, 5);
    assert.deepEqual(urls.map((u) => u.searchParams.get('q')!.split(' ')[0]).sort(), [
      'agent',
      'claude',
      'codex',
      'harness',
      'skill',
    ]);
    for (const url of urls) {
      assert.equal(url.pathname, '/search/repositories');
      assert.equal(url.searchParams.get('sort'), 'stars');
      assert.equal(url.searchParams.get('order'), 'desc');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('page'), '1');
      assert.match(
        url.searchParams.get('q')!,
        /in:name,description,readme is:public fork:false stars:>=100 pushed:>=2026-04-17/,
      );
    }
  } finally {
    db.close();
  }
});
test('unlimited discovery completes retries across a scheduling quantum and ignores legacy range cursors', async () => {
  const db = openDatabase(':memory:');
  let requests = 0;
  const queries: string[] = [];
  try {
    db.prepare('INSERT INTO discovery_work(key,data,visited) VALUES(?,?,0)').run(
      'legacy-range',
      JSON.stringify({
        kind: 'search',
        bucket: JSON.stringify([defaults.minStars, defaults.updatedWithinDays]),
        keyword: 'agent',
        page: 1,
        pushedDate: '1900-01-01',
        start: null,
        end: null,
        grain: 'root',
        starMin: 100,
        starMax: null,
        done: false,
      }),
    );
    const github = createGithub({
      token: () => 'test-key',
      sleep: async () => {},
      fetch: async (url) => {
        requests++;
        if (requests === 9) return new Response(null, { status: 503 });
        const q = new URL(String(url)).searchParams.get('q')!;
        queries.push(q);
        return Response.json({
          total_count: 1000,
          incomplete_results: false,
          items: Array.from({ length: 100 }, (_, i) =>
            githubMetadata({ ...repository().metadata, id: repository().id + i }),
          ),
        });
      },
    });
    const settings = { ...defaults, discoveryRequestLimit: -1 };
    const run: RunRecord = {
      id: 'unlimited-retry',
      command: { kind: 'collect', settings },
      status: 'running',
      stage: 'discover',
      startedAt: new Date(now).toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    };
    saveRun(db, run);
    await discover({
      db,
      run,
      settings,
      github,
      signal: new AbortController().signal,
      now: () => now,
    });
    assert.equal(requests, 51);
    assert.deepEqual(run.gaps, []);
    assert.ok(queries.every((q) => !q.includes('1900-01-01')));
    assert.ok(db.prepare("SELECT key FROM discovery_work WHERE key='legacy-range'").get());
  } finally {
    db.close();
  }
});

test('a later discovery page failure retains its cursor and resumes on the next manual run', async () => {
  const db = openDatabase(':memory:');
  let broken = true,
    laterCalls = 0;
  const seed = repository();
  try {
    const github = createGithub({
      token: () => 'test-key',
      sleep: async () => {},
      fetch: async (url) => {
        const params = new URL(String(url)).searchParams;
        const agent = params.get('q')!.startsWith('agent ');
        const page = Number(params.get('page'));
        if (agent && page === 2) {
          laterCalls++;
          if (broken) return new Response(null, { status: 503 });
        }
        const meta = { ...seed.metadata, id: seed.id + page };
        return Response.json({
          total_count: agent ? 200 : 0,
          incomplete_results: false,
          items: agent
            ? Array.from({ length: 100 }, (_, i) =>
                githubMetadata({ ...meta, id: meta.id + i * 100 }),
              )
            : [],
        });
      },
    });
    const execute = (id: string) => {
      const run: RunRecord = {
        id,
        command: { kind: 'collect', settings: defaults },
        status: 'running',
        stage: 'discover',
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        stats: emptyStats(),
        errors: [],
        gaps: [],
      };
      saveRun(db, run);
      return discover({
        db,
        github,
        settings: { ...defaults, discoveryRequestLimit: 20 },
        signal: new AbortController().signal,
        now: () => now,
        run,
      });
    };
    await assert.rejects(execute('failed-page'), /重试/);
    assert.equal(laterCalls, 3);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM discovery_work WHERE json_extract(data,'$.keyword')='agent' AND json_extract(data,'$.page')=2 AND json_extract(data,'$.done')=0",
        )
        .get()?.n,
      1,
    );
    broken = false;
    await execute('resumed-page');
    assert.equal(laterCalls, 4);
    assert.ok(getRepository(db, seed.id + 2));
  } finally {
    db.close();
  }
});

test('owner expansion is once per account per run and revisits completed first pages', async () => {
  const db = openDatabase(':memory:');
  let ownerCalls = 0;
  try {
    const result = interpretResponse(
      providerResponse(),
      buildJevBody(evidence, taxonomy).questions,
    );
    for (const id of [1, 2]) {
      saveRepository(db, repository({ id, judgmentId: 'j' + id }));
      db.prepare(
        "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES(?,?,?,?,'complete',?,?)",
      ).run('j' + id, id, 'old', 'k' + id, new Date(now).toISOString(), JSON.stringify(result));
      db.prepare('INSERT INTO sources(repository_id,key,data) VALUES(?,?,?)').run(
        id,
        'search',
        JSON.stringify({ parentId: null }),
      );
    }
    const github = {
      search: async (_q: string, _page: number, _signal: AbortSignal, consume: () => void) => {
        consume();
        return { items: [], total: 0, incomplete: false };
      },
      owner: async (
        _owner: string,
        _type: string,
        _page: number,
        _signal: AbortSignal,
        consume: () => void,
      ) => {
        consume();
        ownerCalls++;
        return { items: [], hasNext: false };
      },
      read: async () => {
        throw new Error('unused');
      },
    };
    for (const id of ['one', 'two']) {
      const run: RunRecord = {
        id,
        command: { kind: 'collect', settings: defaults },
        status: 'running',
        stage: 'discover',
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        stats: emptyStats(),
        errors: [],
        gaps: [],
      };
      saveRun(db, run);
      await discover({
        db,
        run,
        settings: { ...defaults, discoveryRequestLimit: 10 },
        github,
        signal: new AbortController().signal,
        now: () => now,
      });
      assert.equal(ownerCalls, id === 'one' ? 1 : 2);
    }
    assert.equal(ownerCalls, 2);
  } finally {
    db.close();
  }
});
test('pagination cursor survives a partial budget and incomplete responses remain explicit', async () => {
  const db = openDatabase(':memory:');
  const pages: number[] = [];
  try {
    const github = {
      search: async (_q: string, page: number, _signal: AbortSignal, consume: () => void) => {
        consume();
        pages.push(page);
        return {
          items: Array.from({ length: 100 }, (_, i) => ({
            ...repository().metadata,
            id: repository().id + i,
          })),
          total: 200,
          incomplete: false,
        };
      },
      owner: async () => ({ items: [], hasNext: false }),
      read: async () => {
        throw new Error('unused');
      },
    };
    for (let i = 0; i < 6; i++) {
      const run: RunRecord = {
        id: String(i),
        command: { kind: 'collect', settings: defaults },
        status: 'running',
        stage: 'discover',
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        stats: emptyStats(),
        errors: [],
        gaps: [],
      };
      saveRun(db, run);
      await discover({
        db,
        run,
        settings: { ...defaults, discoveryRequestLimit: 1 },
        github,
        signal: new AbortController().signal,
        now: () => now,
      });
      assert.ok(run.gaps.length);
    }
    assert.ok(pages.includes(2));
    assert.equal(db.prepare('SELECT count(*) AS n FROM repositories').get()?.n, 100);
  } finally {
    db.close();
  }
});
test('incomplete search is visible and remains resumable instead of falsely completing its cursor', async () => {
  const db = openDatabase(':memory:');
  const run: RunRecord = {
    id: 'incomplete',
    command: { kind: 'collect', settings: defaults },
    status: 'running',
    stage: 'discover',
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    stats: emptyStats(),
    errors: [],
    gaps: [],
  };
  saveRun(db, run);
  try {
    const github = {
      search: async (_q: string, _page: number, _signal: AbortSignal, consume: () => void) => {
        consume();
        return { items: [], total: 100, incomplete: true };
      },
      owner: async () => ({ items: [], hasNext: false }),
      read: async () => {
        throw new Error('unused');
      },
    };
    await discover({
      db,
      run,
      settings: { ...defaults, discoveryRequestLimit: 1 },
      github,
      signal: new AbortController().signal,
      now: () => now,
    });
    assert.ok(run.gaps.some((v) => v.includes('不完整')));
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM discovery_work WHERE json_extract(data,'$.done')=0")
        .get()?.n,
      5,
    );
  } finally {
    db.close();
  }
});
test('fresh keyword roots are interleaved with a large resumable segment backlog', async () => {
  const db = openDatabase(':memory:');
  const queries: string[] = [];
  try {
    const github = {
      search: async (q: string, _page: number, _signal: AbortSignal, consume: () => void) => {
        consume();
        queries.push(q);
        return { items: [], total: 1001, incomplete: false };
      },
      owner: async () => ({ items: [], hasNext: false }),
      read: async () => {
        throw new Error('unused');
      },
    };
    for (let i = 0; i < 7; i++) {
      const run: RunRecord = {
        id: 'fair' + i,
        command: { kind: 'collect', settings: defaults },
        status: 'running',
        stage: 'discover',
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        stats: emptyStats(),
        errors: [],
        gaps: [],
      };
      saveRun(db, run);
      await discover({
        db,
        run,
        settings: { ...defaults, discoveryRequestLimit: 1 },
        github,
        signal: new AbortController().signal,
        now: () => now,
      });
    }
    assert.ok(queries.slice(-2).some((q) => !q.includes('created:')));
  } finally {
    db.close();
  }
});

for (const [total, shortCount] of [
  [200, 0],
  [300, 0],
  [150, 5],
] as const)
  test(`premature search page (${total} total, ${shortCount} returned on page 2) remains resumable`, async () => {
    const db = openDatabase(':memory:');
    let broken = true;
    const calls: number[] = [];
    const github = {
      search: async (q: string, page: number, _signal: AbortSignal, consume: () => void) => {
        consume();
        if (!q.startsWith('agent ')) return { items: [], total: 0, incomplete: false };
        calls.push(page);
        const count = broken && page === 2 ? shortCount : Math.min(100, total - (page - 1) * 100);
        return {
          items: Array.from({ length: count }, (_, i) => ({
            ...repository().metadata,
            id: page * 1000 + i,
          })),
          total,
          incomplete: false,
        };
      },
      owner: async () => ({ items: [], hasNext: false }),
      read: async () => {
        throw new Error('unused');
      },
    };
    const execute = async (id: string) => {
      const settings = { ...defaults, discoveryRequestLimit: 20 };
      const run: RunRecord = {
        id,
        command: { kind: 'collect', settings },
        status: 'running',
        stage: 'discover',
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        stats: emptyStats(),
        errors: [],
        gaps: [],
      };
      saveRun(db, run);
      await discover({
        db,
        run,
        settings,
        github,
        signal: new AbortController().signal,
        now: () => now,
      });
      return run;
    };
    const page2 = () =>
      JSON.parse(
        String(
          db
            .prepare(
              "SELECT data FROM discovery_work WHERE json_extract(data,'$.keyword')='agent' AND json_extract(data,'$.page')=2",
            )
            .get()?.data,
        ),
      );
    try {
      const first = await execute('first');
      assert.ok(first.gaps.some((gap) => gap.includes('分页提前结束')));
      assert.equal(page2().done, false);
      broken = false;
      calls.length = 0;
      const second = await execute('second');
      assert.ok(calls.includes(2));
      assert.equal(page2().done, true);
      assert.deepEqual(second.gaps, []);
    } finally {
      db.close();
    }
  });

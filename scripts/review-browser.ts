import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { RequestListener } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowser, closeBrowserAndApp } from './browser.ts';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';
import { emptyStats } from '../src/shared/contracts.ts';
import { repository } from '../tests/fixtures.ts';

const browser = createBrowser('atlas-review-browser', '127.0.0.1,github.com'),
  db = openDatabase(':memory:'),
  catalog = createCatalog(db);
let slowStatus = false,
  delayedWrites = false,
  marker = 'initial-status',
  statusPending = 0,
  maxStatus = 0,
  writes = 0,
  writePending = 0,
  maxWrites = 0,
  external = 0;
const offline = async () => {
  external++;
  throw new Error('Review regression must stay offline');
};
const collection = createCollection({
  db,
  github: createGithub({
    token: () => {
      throw new Error('No credentials');
    },
    fetch: offline,
  }),
  judgment: createJudgment({ key: () => undefined, fetch: offline }),
  settings: () => catalog.getSettings().collection,
  canJudge: () => false,
});
for (let i = 0; i < 60; i++) {
  const record = repository({
    id: repository().id + i,
    metadata: {
      ...repository().metadata,
      id: repository().id + i,
      full_name: 'atlas-review/repo-' + i,
      pushed_at: new Date().toISOString(),
    },
  });
  saveRepository(db, record);
}
const settings = catalog.getSettings();
catalog.saveSettings({
  ...settings,
  view: { ...settings.view, state: 'all', minStars: 0, updatedWithinDays: null },
});
const insertSource = db.prepare('INSERT INTO sources(repository_id,key,data) VALUES(?,?,?)');
for (let i = 0; i < 101; i++)
  insertSource.run(
    repository().id,
    'source-' + i,
    JSON.stringify({
      key: 'source-' + i,
      label: 'Source entry ' + i,
      parentId: null,
      discoveredAt: new Date().toISOString(),
    }),
  );
const server = createHttpServer({
  catalog,
  collection,
  status: () => ({ databasePath: marker, jevConfigured: false, githubAuthentication: 'missing' }),
  webRoot: resolve(process.env.ATLAS_REVIEW_WEB_ROOT ?? 'dist/web'),
});
const handler = server.listeners('request')[0] as RequestListener;
server.removeListener('request', handler);
server.on('request', (req, res) => {
  if (slowStatus && req.url === '/api/status') {
    statusPending++;
    maxStatus = Math.max(maxStatus, statusPending);
    res.once('finish', () => {
      statusPending--;
    });
    setTimeout(() => handler(req, res), 1700);
    return;
  }
  if (delayedWrites && req.method === 'POST' && req.url?.endsWith('/personal')) {
    writes++;
    writePending++;
    maxWrites = Math.max(maxWrites, writePending);
    res.once('finish', () => {
      writePending--;
    });
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      setTimeout(() => end(...args), 800);
      return res;
    }) as typeof res.end;
  }
  handler(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = 'http://127.0.0.1:' + address.port;
async function evaluate<T>(script: string): Promise<T> {
  return JSON.parse(await browser('eval', script, '--json')).data.result;
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Controlled browser operation must finish');
    await delay(20);
  }
}
try {
  await browser('set', 'viewport', '1440', '1000');
  const cases = process.argv[2]
    ? [process.argv[2]]
    : ['links', 'sticky', 'sources', 'writes', 'polling'];
  for (const scenario of cases) {
    db.exec('DELETE FROM personal_state');
    await browser('open', origin);
    await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 50');
    if (scenario === 'links') {
      await browser(
        'network',
        'route',
        'https://github.com/**',
        '--body',
        'Repository destination',
      );
      const href = await evaluate<string>('document.querySelector(".catalog a.repo").href');
      assert.equal(href, 'https://github.com/atlas-review/repo-0');
      await browser('click', '.catalog article:first-of-type a.repo', '--new-tab');
      assert.match(
        await browser('tab', 'list', '--json'),
        /https:\/\/github.com\/atlas-review\/repo-0/,
      );
      await browser('tab', 't1');
      await browser('click', '.catalog article .resource-details');
      await browser('wait', '--text', 'Source entry');
      assert.equal(await evaluate('location.origin'), origin);
    } else if (scenario === 'sticky') {
      await browser('click', '.catalog article .resource-details');
      await browser('wait', '--text', 'Source entry');
      await evaluate('window.scrollTo(0, 1200)');
      const top = await evaluate<number>(
        'document.querySelector(".detail").getBoundingClientRect().top',
      );
      assert.ok(
        Math.abs(top - 12) < 1,
        'Desktop details must remain visible while scrolling a long catalog: top=' + top,
      );
    } else if (scenario === 'sources') {
      await browser('click', '.catalog article .resource-details');
      await browser('wait', '--text', 'Source entry');
      assert.equal(await evaluate('document.querySelectorAll(".detail .sources li").length'), 50);
      await evaluate(
        'Array.from(document.querySelectorAll(".detail button")).find(b => b.textContent === "较早来源").click()',
      );
      await browser(
        'wait',
        '--fn',
        'document.querySelector(".detail .sources li")?.textContent.includes("Source entry 50")',
      );
      assert.equal(await evaluate('document.querySelectorAll(".detail .sources li").length'), 50);
      await evaluate(
        'Array.from(document.querySelectorAll(".detail button")).find(b => b.textContent === "较新来源").click()',
      );
      await browser(
        'wait',
        '--fn',
        'document.querySelector(".detail .sources li")?.textContent.includes("Source entry 100")',
      );
    } else if (scenario === 'writes') {
      writes = 0;
      maxWrites = 0;
      delayedWrites = true;
      await evaluate('document.querySelector(".catalog article").scrollIntoView({block:"start"})');
      await evaluate(
        'window.scrollBy(0, document.querySelector(".catalog article").getBoundingClientRect().height * 2 + 20)',
      );
      await waitFor(() => writes >= 2 && writePending > 0);
      assert.equal(
        await evaluate('document.querySelector(".save-view").disabled'),
        true,
        'Controls must stay busy until all writes finish',
      );
      await waitFor(() => writePending === 0);
      assert.equal(maxWrites, 1, 'Personal snapshots must be saved and applied in order');
      delayedWrites = false;
    } else if (scenario === 'polling') {
      db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run(
        'slow-poll',
        JSON.stringify({
          id: 'slow-poll',
          command: { kind: 'collect', settings: settings.collection },
          status: 'running',
          stage: 'poll fixture',
          startedAt: new Date().toISOString(),
          endedAt: null,
          stats: emptyStats(),
          errors: [],
          gaps: [],
        }),
      );
      await browser('reload');
      await browser('wait', '--text', '任务记录 / 运行中');
      await browser('click', '.collect-panel > details > summary');
      slowStatus = true;
      marker = 'slow-status-applied';
      await browser('wait', '--text', 'slow-status-applied');
      assert.equal(maxStatus, 1, 'Slow status reads must not overlap or invalidate every response');
      slowStatus = false;
      db.exec('DELETE FROM runs');
    } else throw new Error('Unknown browser scenario: ' + scenario);
    console.log('Review browser regression passed: ' + scenario);
  }
  assert.equal(external, 0);
  console.log('Review browser regressions passed; external calls=0; user database writes=0.');
} finally {
  await closeBrowserAndApp(browser, async () => {
    await collection.shutdown();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
  });
}

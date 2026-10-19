import assert from 'node:assert/strict';
import { createBrowser } from './browser.ts';
import { once } from 'node:events';
import type { RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/server/database.ts';
import { emptyStats } from '../src/shared/contracts.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';

const browser = createBrowser('atlas-run-history'),
  db = openDatabase(':memory:'),
  staleError = process.argv.includes('--stale-error');
let external = 0,
  reads = 0,
  failResource = true,
  failStatus = false,
  release: (() => void) | undefined;
const network = async () => {
  external++;
  throw new Error('External network prohibited');
};
const catalog = createCatalog(db);
for (let i = 1; i <= 41; i++) {
  const run = {
    id: 'run-' + i,
    command: { kind: 'collect', settings: catalog.getSettings().collection },
    status: 'completed',
    stage: 'history-fixture-' + i,
    startedAt: new Date(1760400000000 + i * 1000).toISOString(),
    endedAt: new Date(1760400000500 + i * 1000).toISOString(),
    stats: emptyStats(),
    errors: [],
    gaps: [],
  };
  db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run(run.id, JSON.stringify(run));
}
const collection = createCollection({
  db,
  github: createGithub({ token: () => '', fetch: network }),
  judgment: createJudgment({ key: () => undefined, fetch: network }),
  settings: () => catalog.getSettings().collection,
  canJudge: () => false,
});
const server = createHttpServer({
  catalog,
  collection,
  status: () => ({
    databasePath: ':memory:',
    jevConfigured: false,
    githubAuthentication: 'missing',
  }),
  webRoot: resolve('dist/web'),
});
const handler = server.listeners('request')[0] as RequestListener;
server.removeListener('request', handler);
server.on('request', (req, res) => {
  if (failStatus && req.url === '/api/status') {
    failStatus = false;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Current history read failed' }));
    return;
  }
  if (failResource && req.url?.startsWith('/api/resources?')) {
    failResource = false;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Fixture read failure' }));
    return;
  }
  if (req.url?.startsWith('/api/runs?page=')) {
    reads++;
    if (reads === 2) {
      release = () => {
        release = undefined;
        if (staleError) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Obsolete history read failed' }));
        } else handler(req, res);
      };
      return;
    }
  }
  handler(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
try {
  await browser('open', 'http://127.0.0.1:' + address.port);
  await browser('wait', '--text', 'Fixture read failure');
  await browser('click', '.masthead button');
  await browser('wait', '--text', 'history-fixture-41');
  await browser(
    'eval',
    `(() => {
    const fetch = window.fetch.bind(window);
    window.__historyBodyDone = false;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]) === '/api/runs?page=1') {
        const json = response.json.bind(response);
        response.json = async () => {
          const value = await json();
          window.__historyBodyDone = true;
          return value;
        };
      }
      return response;
    };
  })()`,
  );
  await browser('find', 'role', 'button', 'click', '--name', '重新读取本机数据', '--exact');
  const deadline = Date.now() + 10000;
  while (!release) {
    assert.ok(Date.now() < deadline, 'The page-1 reload must be held before paging');
    await delay(40);
  }
  await browser('find', 'role', 'button', 'click', '--name', '下一页任务', '--exact');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.runs .pagination span')?.textContent?.trim()==='2 / 3'`,
  );
  release();
  await browser('wait', '--fn', 'window.__historyBodyDone === true');
  await browser(
    'eval',
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  assert.equal(
    JSON.parse(
      await browser(
        'eval',
        `document.querySelector('.runs .pagination span')?.textContent?.trim()`,
      ),
    ),
    '2 / 3',
    'A late page-1 response must not replace the selected page',
  );
  assert.equal(
    JSON.parse(
      await browser('eval', `document.querySelector('[role="alert"]')?.textContent ?? null`),
    ),
    null,
    'A superseded read failure must not replace the current page with an error',
  );
  const before = reads;
  await browser('find', 'role', 'button', 'click', '--name', '下一页任务', '--exact');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.runs .pagination span')?.textContent?.trim()==='3 / 3'`,
  );
  assert.ok(reads > before, 'Next must request the third page');
  failStatus = true;
  await browser('find', 'role', 'button', 'click', '--name', '上一页任务', '--exact');
  await browser('wait', '--text', 'Current history read failed');
  await browser('find', 'role', 'button', 'click', '--name', '重新读取本机数据', '--exact');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.runs .pagination span')?.textContent?.trim()==='2 / 3'`,
  );
  assert.equal(external, 0);
  console.log(
    `Run history browser passed: stale ${staleError ? 'failed' : 'successful'} page-1 GET cannot replace page 2 or block next-page navigation; external calls=0.`,
  );
} finally {
  release?.();
  await browser('close').catch(() => {});
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  db.close();
}

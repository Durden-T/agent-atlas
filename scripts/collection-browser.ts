import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowser, closeBrowserAndApp } from './browser.ts';
import { openDatabase } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';
import { defaults, defaultFilter } from '../src/shared/contracts.ts';
import { dateText, stateNames } from '../src/web/api.ts';
import { metadata, evidence, githubMetadata, providerResponse } from '../tests/fixtures.ts';

const directory = mkdtempSync(join(tmpdir(), 'atlas-collection-browser-'));
const databasePath = join(directory, 'atlas.sqlite');
const browser = createBrowser('atlas-collection');
const names = [
  'unrelated',
  'relevance-review',
  'all-labels-review',
  'partial-labels-review',
  'missing-readme',
  'empty-evidence',
  'low-stars',
  'outdated',
];
let time = Date.now(),
  metadataFailure = false,
  paidFailure = false,
  calls = 0,
  reads = 0;
const fixtures = names.map((name, index) => ({
  metadata: {
    ...metadata,
    id: metadata.id + index,
    full_name: 'atlas-e2e/' + name,
    owner: 'atlas-e2e',
    stars: index === 6 ? 10 : 1000 - index,
    pushed_at: new Date(time - (index === 7 ? 181 * 86400000 : 0)).toISOString(),
    description: index === 5 ? ' ' : metadata.description,
    topics: index === 5 ? [] : metadata.topics,
  },
  text: index === 5 ? ' \n\t' : evidence.readme.text,
}));
const checks: { name: string; requests: number; cumulative: number }[] = [];
const dispatches: { repository: string; questions: number }[] = [];
const mutations: string[] = [];
function makeApp() {
  const db = openDatabase(databasePath),
    catalog = createCatalog(db, () => time);
  const github = createGithub({
    token: () => 'offline-fixture-key',
    now: () => time,
    sleep: async () => {},
    fetch: async (url) => {
      const request = new URL(String(url));
      assert.equal(request.origin, 'https://api.github.com');
      if (request.pathname === '/search/repositories')
        return Response.json({
          total_count: fixtures.length,
          incomplete_results: false,
          items: fixtures.map((f) => githubMetadata(f.metadata)),
        });
      if (request.pathname.startsWith('/orgs/'))
        return Response.json(fixtures.map((f) => githubMetadata(f.metadata)));
      const fixture = fixtures.find(
        (f) =>
          request.pathname === '/repos/' + f.metadata.full_name ||
          request.pathname === '/repos/' + f.metadata.full_name + '/readme',
      );
      assert.ok(fixture, 'Unexpected GitHub fixture endpoint');
      reads++;
      if (metadataFailure && fixture === fixtures[0]) return new Response(null, { status: 503 });
      if (!request.pathname.endsWith('/readme'))
        return Response.json(githubMetadata(fixture.metadata));
      if (fixture === fixtures[4]) return new Response(null, { status: 404 });
      return Response.json({
        path: 'README.md',
        encoding: 'base64',
        sha: createHash('sha1').update(fixture.text).digest('hex'),
        content: Buffer.from(fixture.text).toString('base64'),
      });
    },
  });
  const judgment = createJudgment({
    key: () => 'offline-fixture-key',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions');
      const body = JSON.parse(String(init?.body)),
        name = body.state.repository.full_name;
      calls++;
      dispatches.push({ repository: name, questions: Object.keys(body.questions).length });
      assert.equal(Object.keys(body.questions).length, 16);
      if (paidFailure)
        return Response.json({ error: 'Controlled paid request failure' }, { status: 400 });
      const response = providerResponse(undefined, name !== fixtures[0].metadata.full_name);
      if (name === fixtures[1].metadata.full_name)
        response.answers.relevance = { type: 'noul', noul: 0.5 };
      for (const [id, answer] of Object.entries(response.answers)) {
        if (
          id === 'relevance' ||
          (name !== fixtures[2].metadata.full_name &&
            !(name === fixtures[3].metadata.full_name && id === 'label.form.skills'))
        )
          continue;
        if (answer.type === 'noul') answer.noul = 0.5;
        else {
          answer.probabilities = { supported: 0.5, not_supported: 0.5 };
          answer.confidence = 0;
        }
      }
      return Response.json(response);
    },
  });
  const collection = createCollection({
    db,
    github,
    judgment,
    now: () => time,
    settings: () => catalog.getSettings().collection,
    canJudge: () => true,
  });
  const server = createHttpServer({
    catalog,
    collection,
    webRoot: resolve('dist/web'),
    status: () => ({ databasePath, jevConfigured: true, githubAuthentication: 'environment' }),
  });
  server.on('request', (req) => {
    if (req.method === 'POST') mutations.push(req.url ?? '');
  });
  return { db, catalog, collection, server };
}
let app = makeApp();
app.catalog.saveSettings({
  collection: { ...defaults, judgmentLimit: 1, discoveryRequestLimit: 5 },
  view: { ...defaultFilter, state: 'all', minStars: 0, updatedWithinDays: null },
});
async function open() {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  await browser('open', 'http://127.0.0.1:' + address.port);
  await browser('wait', '--text', '收集参数');
}
async function closeApp() {
  await app.collection.shutdown();
  app.server.closeAllConnections();
  await new Promise<void>((resolve) => app.server.close(() => resolve()));
  app.db.close();
}
async function run(name: string, button: string, expected: number) {
  const count = app.collection.listRuns().total,
    before = calls;
  time += 1000;
  await browser('find', 'role', 'button', 'click', '--name', button, '--exact');
  let result;
  for (let i = 0; i < 250; i++) {
    const page = app.collection.listRuns();
    if (page.total === count + 1 && page.items[0].endedAt) {
      result = page.items[0];
      break;
    }
    await delay(20);
  }
  assert.ok(result, name + ': browser action must create and complete a real local task');
  assert.equal(result.stats.requests, expected, name + ': persisted dispatch count');
  assert.equal(calls - before, expected, name + ': actual provider transport count');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".runs > details > summary")?.textContent.includes(' +
      JSON.stringify(dateText(result.startedAt)) +
      ') && ' +
      'Array.from(document.querySelectorAll(".runs > details:first-of-type .run-stats > div"))' +
      '.find(e => e.querySelector("dt")?.textContent === "实际 Jev 请求")?.querySelector("dd")?.textContent === ' +
      JSON.stringify(String(expected)) +
      ' && document.querySelector(".runs > details:first-of-type .run-content > p")?.textContent.includes("已结束")',
  );
  checks.push({ name, requests: expected, cumulative: calls });
  return result;
}
const fill = (index: number, value: string) =>
  browser(
    'fill',
    '[aria-label="收集参数"] .collect-fields label:nth-child(' + index + ') input',
    value,
  );
try {
  await open();
  assert.equal(calls, 0);
  await run('finite quota stops dispatch', '开始收集', 1);
  await fill(4, '-1');
  await run('unlimited continuation drains pending candidates', '继续待判断', 3);
  const states = ['unrelated', 'review', 'review', 'collected'];
  for (let i = 0; i < 4; i++) {
    const f = fixtures[i],
      saved = app.catalog.get(f.metadata.id);
    assert.equal(saved.state, states[i]);
    assert.equal(saved.judgments.length, 1);
    await browser(
      'wait',
      '--fn',
      'document.querySelector(' +
        JSON.stringify('[data-repository-id="' + f.metadata.id + '"] .row-footer') +
        ')?.textContent.includes(' +
        JSON.stringify(stateNames[states[i]]) +
        ')',
    );
  }
  assert.equal(app.catalog.get(fixtures[4].metadata.id).filterReason, '无 README');
  assert.equal(app.catalog.get(fixtures[5].metadata.id).filterReason, '无有效分类证据');
  for (const fixture of fixtures.slice(4))
    assert.equal(app.catalog.get(fixture.metadata.id).judgments.length, 0);
  const readBefore = reads;
  await run('minus one skips every completed outcome', '开始收集', 0);
  assert.equal(reads, readBefore);
  await fill(3, '0');
  assert.equal(
    (await run('unchanged evidence reuses all four outcomes', '开始收集', 0)).stats.cached,
    4,
  );
  await fill(3, '1');
  const intervalReads = reads;
  await run('one day interval skips before expiry', '开始收集', 0);
  assert.equal(reads, intervalReads);
  time += 2 * 86400000;
  assert.equal(
    (await run('expired interval still reuses unchanged judgments', '开始收集', 0)).stats.cached,
    4,
  );
  await fill(3, '0');
  metadataFailure = true;
  await run('metadata failure does not dispatch Jev', '开始收集', 0);
  assert.equal(app.catalog.get(fixtures[0].metadata.id).state, 'error');
  metadataFailure = false;
  await browser('click', '.collect-panel > details > summary');
  await run('read failure retry keeps successful cache', '明确重试失败请求', 0);
  assert.equal(app.catalog.get(fixtures[0].metadata.id).state, 'unrelated');
  await browser('scrollintoview', `[data-repository-id="${fixtures[3].metadata.id}"] .repo`);
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".catalog [aria-busy]")?.getAttribute("aria-busy") === "false"',
  );
  await browser(
    'click',
    '[data-repository-id="' + fixtures[3].metadata.id + '"] .resource-details',
  );
  await browser('wait', '--text', '用已保存证据重新判断（付费）');
  await run('explicit rejudge dispatches once', '用已保存证据重新判断（付费）', 1);
  paidFailure = true;
  await run('failed paid rejudge counts one attempt', '用已保存证据重新判断（付费）', 1);
  paidFailure = false;
  await run('ordinary continue never replays paid error', '继续待判断', 0);
  await run('explicit paid retry is not hidden by older success', '明确重试失败请求', 1);
  fixtures[1].text += '\nChanged evidence for the controlled fixture.';
  await run('changed evidence dispatches only the changed repository', '开始收集', 1);
  const totalRuns = app.collection.listRuns().total,
    beforeRestart = calls;
  await closeApp();
  app = makeApp();
  await open();
  assert.equal(calls, beforeRestart);
  assert.equal(app.collection.listRuns().total, totalRuns);
  assert.equal(app.catalog.getSettings().collection.judgmentLimit, -1);
  assert.equal(
    (await run('restart preserves all successful caches', '开始收集', 0)).stats.cached,
    4,
  );
  await browser('screenshot', resolve('.comet/collection-e2e.png'));
  assert.equal(calls, 8);
  assert.ok(mutations.filter((url) => url === '/api/runs').length === checks.length);
  writeFileSync(
    '.comet/collection-e2e-results.json',
    JSON.stringify(
      {
        checks,
        controlledProviderRequests: calls,
        dispatches,
        externalJevCalls: 0,
        userDatabaseWrites: 0,
        persistedRestarts: 1,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Collection browser E2E passed: ' +
      checks.length +
      ' UI-driven tasks; unrelated/relevance review/all-label review/partial-label review, filters, quotas, intervals, caches, read retry, paid retry, changed evidence and restart; controlled provider requests=8; real Jev calls=0; user database writes=0.',
  );
} catch (error) {
  console.error('Collection E2E failure', JSON.stringify({ checks, calls, mutations }));
  console.error(await browser('snapshot', '-i').catch((failure) => String(failure)));
  throw error;
} finally {
  await closeBrowserAndApp(browser, closeApp);
  rmSync(directory, { recursive: true });
}

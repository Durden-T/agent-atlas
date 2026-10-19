import assert from 'node:assert/strict';
import { createBrowser, closeBrowserAndApp } from './browser.ts';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { repository, evidence, providerResponse } from '../tests/fixtures.ts';
import { defaults, emptyStats } from '../src/shared/contracts.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment, interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { taxonomy } from '../src/shared/taxonomy.ts';
import { createHttpServer } from '../src/server/http.ts';
const browser = createBrowser('atlas-smoke'),
  db = openDatabase(':memory:');
const requestTrace: { url: string | undefined; body: string; status: number }[] = [];
let delayDetailMs = 0;
let externalCalls = 0,
  mutationRequests = 0,
  detailRequests = 0,
  resourceReads = 0;
const network = async () => {
  externalCalls++;
  throw new Error('Browser recovery must stay offline');
};
const catalog = createCatalog(db),
  collection = createCollection({
    db,
    github: createGithub({
      token: () => {
        throw new Error('No credentials permitted');
      },
      fetch: network,
    }),
    judgment: createJudgment({ key: () => undefined, fetch: network }),
    settings: () => catalog.getSettings().collection,
    canJudge: () => false,
  });
saveRepository(db, repository());
const reviewId = repository().id + 1;
const reviewRequest = buildJevBody(
  { ...evidence, full_name: 'travisvn/awesome-claude-skills' },
  taxonomy,
);
const reviewResponse = providerResponse(['form.skills']);
reviewResponse.answers.relevance = { type: 'noul', noul: 0.7 };
const review = {
  ...interpretResponse(reviewResponse, reviewRequest.questions),
  request: reviewRequest,
  response: reviewResponse,
};
saveRepository(
  db,
  repository({
    id: reviewId,
    metadata: {
      ...repository().metadata,
      id: reviewId,
      full_name: 'travisvn/awesome-claude-skills',
    },
    state: review.status,
    judgmentId: 'review',
    evidenceId: 'browser-evidence',
  }),
);
db.prepare(
  "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES('review',?,'browser','browser','complete','2026-10-14T00:00:00Z',?)",
).run(reviewId, JSON.stringify(review));
db.prepare('INSERT INTO evidence(id,repository_id,hash,data) VALUES(?,?,?,?)').run(
  'browser-evidence',
  reviewId,
  'browser-hash',
  JSON.stringify({
    id: 'browser-evidence',
    repositoryId: reviewId,
    hash: 'browser-hash',
    evidence,
    sha: 'browser-sha',
    metadataEtag: null,
    readmeEtag: null,
    readAt: new Date().toISOString(),
  }),
);
const settings = catalog.getSettings();
catalog.saveSettings({
  ...settings,
  view: { ...settings.view, state: 'all', updatedWithinDays: null },
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
const handler = server.listeners('request')[0] as (
  req: IncomingMessage,
  res: ServerResponse,
) => void;
server.removeListener('request', handler);
server.on('request', (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    res.on('finish', () => requestTrace.push({ url: req.url, body, status: res.statusCode }));
  }

  if (delayDetailMs && req.method === 'GET' && req.url === '/api/resources/' + reviewId) {
    const finish = res.end.bind(res),
      delay = delayDetailMs;
    res.end = ((...args: Parameters<typeof res.end>) => {
      setTimeout(() => finish(...args), delay);
      return res;
    }) as typeof res.end;
  }
  handler(req, res);
});
server.on('request', (req) => {
  if (req.method === 'POST') mutationRequests++;
  if (req.url === '/api/resources/' + reviewId) detailRequests++;
  if (req.url?.startsWith('/api/resources?')) resourceReads++;
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
try {
  await browser('network', 'route', '**/api/settings', '--abort');
  await browser('open', 'http://127.0.0.1:' + address.port);
  await browser('wait', '--text', '配置加载失败');
  await browser('network', 'unroute', '**/api/settings');
  await browser('find', 'role', 'button', 'click', '--name', '重新读取本机数据', '--exact');
  await browser('wait', '--text', '收集参数');
  const recovered = JSON.parse(
    await browser('eval', '!!document.querySelector("[aria-label=收集参数]")', '--json'),
  );
  assert.equal(recovered.data.result, true);
  await browser('fill', '[aria-label="收集参数"] .collect-fields label:first-child input', '-1');
  await browser('find', 'role', 'button', 'click', '--name', '继续待判断', '--exact');
  const invalid = JSON.parse(
    await browser('eval', 'document.body.textContent.includes("非负安全整数")', '--json'),
  );
  assert.equal(invalid.data.result, true);
  assert.equal(mutationRequests, 0);
  assert.equal(externalCalls, 0);
  await browser('fill', '[aria-label="收集参数"] .collect-fields label:first-child input', '100');
  await browser('wait', '--text', '标签暂未应用');
  await browser('click', '[data-repository-id="' + reviewId + '"] .resource-details');
  await browser('wait', '--text', '模型判断记录');
  await browser('wait', '--text', '标为未查看');
  assert.equal(catalog.get(reviewId).viewed, true);
  const noul = JSON.parse(
    await browser(
      'eval',
      'document.querySelector(".detail .decisions")?.textContent.includes("相关概率 0.7")',
      '--json',
    ),
  );
  assert.equal(noul.data.result, true);
  await browser('find', 'role', 'button', 'click', '--name', '忽略', '--exact');
  await browser('wait', '--text', '当前有人工整理。');
  assert.equal(catalog.get(reviewId).override?.decision, 'ignore');
  await browser('find', 'role', 'button', 'click', '--name', '恢复模型建议', '--exact');
  await browser('wait', '--text', '当前使用模型建议。');
  assert.equal(catalog.get(reviewId).override, null);
  delayDetailMs = 1000;
  await browser('find', 'role', 'button', 'click', '--name', '修正标签', '--exact');
  await browser('click', '.detail form fieldset:first-child label:first-of-type input');
  await browser('find', 'role', 'button', 'click', '--name', '保存人工标签', '--exact');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".detail form button.primary")?.disabled === false',
  );
  await browser('find', 'role', 'button', 'click', '--name', '保留', '--exact');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".detail")?.textContent.includes("已收录 /")',
  );
  assert.deepEqual(catalog.get(reviewId).override?.labels, ['form.tools']);
  await browser('find', 'role', 'button', 'click', '--name', '恢复模型建议', '--exact');
  await browser('wait', '--text', '当前使用模型建议。');
  await browser('find', 'role', 'button', 'click', '--name', '修正标签', '--exact');

  await browser('click', '.folder-manager > summary');
  delayDetailMs = 1000;
  for (const name of ['开发工具', '科研工具']) {
    await browser('find', 'label', '新收藏夹名称', 'fill', name, '--exact');
    await browser('find', 'role', 'button', 'click', '--name', '创建收藏夹', '--exact');
    await browser('wait', '--text', name);
    await browser('find', 'role', 'checkbox', 'click', '--name', name, '--exact');
    await browser(
      'wait',
      '--fn',
      'document.querySelector(".detail > fieldset input")?.disabled === false && document.querySelector(".detail > .folder-memberships")?.textContent.includes(' +
        JSON.stringify(name) +
        ')',
    );
  }
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".catalog .resource.selected .folder-memberships")?.textContent.includes("科研工具")',
  );
  assert.equal(catalog.get(reviewId).folders.length, 2);
  delayDetailMs = 0;
  await browser('fill', '[aria-label="收藏夹名称 科研工具"]', '科研');
  await browser('find', 'role', 'button', 'click', '--name', '重命名收藏夹 科研工具', '--exact');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".catalog .resource.selected .folder-memberships")?.textContent.includes("科研") && !document.querySelector(".catalog .resource.selected .folder-memberships")?.textContent.includes("科研工具")',
  );
  const folderId = catalog.listFolders().find((folder) => folder.name === '开发工具')!.id;
  await browser('select', '.filters > label:nth-of-type(2) select', String(folderId));
  await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 1');
  await browser('select', '.filters > label:nth-of-type(2) select', '');
  await browser('select', '.filters > label:nth-of-type(3) select', 'unviewed');
  await browser(
    'wait',
    '--fn',
    'document.querySelectorAll(".catalog article").length === 1 && document.querySelector(".catalog article .repo")?.textContent.includes("agent-browser")',
  );
  await browser('select', '.filters > label:nth-of-type(3) select', 'all');
  delayDetailMs = 1000;
  await browser('find', 'role', 'button', 'click', '--name', '删除收藏夹 科研', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '确认删除', '--exact');
  await browser(
    'wait',
    '--fn',
    '!Array.from(document.querySelectorAll(".folder-manager input")).some(input => input.getAttribute("aria-label") === "收藏夹名称 科研") && document.querySelector(".detail > fieldset input")?.disabled === false',
  );
  await browser('click', '.detail > fieldset label:first-of-type input');
  await browser('wait', '--text', '未加入收藏夹');
  assert.deepEqual(catalog.get(reviewId).folders, []);
  await browser('find', 'role', 'checkbox', 'click', '--name', '开发工具', '--exact');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".catalog .resource.selected .folder-memberships")?.textContent.includes("开发工具") && !document.querySelector(".catalog .resource.selected .folder-memberships")?.textContent.includes("科研")',
  );
  assert.deepEqual(
    catalog.get(reviewId).folders.map((folder) => folder.name),
    ['开发工具'],
  );
  delayDetailMs = 0;
  await browser('eval', 'window.scrollTo(0, 0)');
  await browser('screenshot', resolve('docs/screenshots/personal-desktop.png'));

  db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run(
    'browser-active',
    JSON.stringify({
      id: 'browser-active',
      command: { kind: 'collect', settings: defaults },
      status: 'running',
      stage: '读取与判断',
      startedAt: new Date().toISOString(),
      endedAt: null,
      stats: emptyStats(),
      errors: [],
      gaps: [],
    }),
  );
  await browser('reload');
  await browser('wait', '--text', '任务记录 / 运行中');
  await browser('wait', '--text', 'travisvn/awesome-claude-skills');
  await browser('click', '[data-repository-id="' + reviewId + '"] .resource-details');
  await browser('wait', '--text', '展开原文');
  await browser('wait', '--text', '标为未查看');
  await browser('find', 'role', 'button', 'click', '--name', '标为未查看', '--exact');
  await browser('wait', '--text', '标为已查看');
  await browser('find', 'text', '展开原文', 'click', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '修正标签', '--exact');
  await browser('click', '.detail form fieldset:first-child label:first-of-type input');
  const pollStart = detailRequests;
  for (let i = 0; i < 60 && detailRequests < pollStart + 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(detailRequests >= pollStart + 2, 'The active task must actually refresh detail twice');
  const retained = JSON.parse(
    await browser(
      'eval',
      `({
    readmeOpen: document.querySelector('.readme')?.closest('details')?.open,
    editing: !!document.querySelector('.detail form'),
    chosen: document.querySelector('.detail form fieldset:first-child label:first-of-type input')?.checked,
  })`,
      '--json',
    ),
  );
  assert.deepEqual(retained.data.result, { readmeOpen: true, editing: true, chosen: true });
  assert.equal(
    catalog.get(reviewId).viewed,
    false,
    'Polling must preserve a manual unviewed decision',
  );
  assert.deepEqual(
    catalog.get(reviewId).folders.map((folder) => folder.name),
    ['开发工具'],
  );
  await browser('set', 'viewport', '390', '844');
  await browser('find', 'role', 'button', 'click', '--name', '返回列表', '--exact');
  catalog.setPersonal(repository().id, { viewed: false });
  await browser('network', 'route', '**/api/resources/' + repository().id, '--abort');
  await browser('click', '[data-repository-id="' + repository().id + '"] .resource-details');
  await browser('wait', '--text', 'Failed to fetch');
  const back = JSON.parse(
    await browser(
      'eval',
      'Array.from(document.querySelectorAll(".detail button")).some(b => b.textContent === "返回列表" && b.getClientRects().length)',
      '--json',
    ),
  );
  assert.equal(
    back.data.result,
    true,
    'Mobile detail failure must retain visible return navigation',
  );
  await browser('find', 'role', 'button', 'click', '--name', '返回列表', '--exact');
  const listVisible = JSON.parse(
    await browser(
      'eval',
      'getComputedStyle(document.querySelector(".catalog")).display !== "none"',
      '--json',
    ),
  );
  assert.equal(listVisible.data.result, true);
  assert.equal(
    catalog.get(repository().id).viewed,
    false,
    'A failed detail load must not mark the project viewed',
  );
  assert.deepEqual(
    requestTrace
      .filter((request) => request.url?.endsWith('/personal'))
      .map((request) => JSON.parse(request.body).folderIds)
      .filter((ids) => ids !== undefined),
    [[folderId], [folderId, folderId + 1], [], [folderId]],
    'Each folder click must produce exactly one membership write',
  );
  for (let i = 0; i < 49; i++) {
    const id = repository().id + 10 + i;
    saveRepository(
      db,
      repository({
        id,
        metadata: { ...repository().metadata, id, full_name: 'atlas-pagination-fixture/repo-' + i },
      }),
    );
  }
  await browser('set', 'viewport', '1440', '1000');
  await browser('select', '.filters > label:nth-of-type(3) select', 'unviewed');
  await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 50');
  await browser(
    'eval',
    'window.scrollTo(0, 0); document.querySelector(".pagination button:last-child").click()',
  );
  await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 1');
  await browser('click', '.catalog article .resource-details');
  await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 50');
  assert.equal(catalog.list({ ...catalog.getSettings().view, viewed: 'unviewed' }).total, 50);

  await browser(
    'eval',
    'document.querySelector(".catalog article").scrollIntoView({block:"start"})',
  );
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".catalog article").getBoundingClientRect().top >= -1',
  );
  const first = catalog.list({ ...catalog.getSettings().view, viewed: 'unviewed' }).items[0];
  const unseen = catalog.list({ ...catalog.getSettings().view, viewed: 'unviewed' }).items.at(-1)!;
  await browser(
    'eval',
    'window.scrollBy(0, document.querySelector(".catalog article").getBoundingClientRect().height + 20)',
  );
  await browser(
    'wait',
    '--fn',
    '!Array.from(document.querySelectorAll(".catalog article .repo")).some(e => e.textContent === ' +
      JSON.stringify(first.metadata.full_name) +
      ')',
  );
  assert.equal(catalog.get(first.id).viewed, true);
  assert.equal(catalog.get(unseen.id).viewed, false);

  await browser('set', 'viewport', '390', '844');
  await browser('find', 'role', 'button', 'click', '--name', '返回列表', '--exact');
  const hiddenTarget = catalog.list({ ...catalog.getSettings().view, viewed: 'unviewed' }).items[0];
  const target = '[data-repository-id="' + hiddenTarget.id + '"]';
  await browser(
    'eval',
    'document.querySelector(' + JSON.stringify(target) + ').scrollIntoView({block:"start"})',
  );
  const visibleAt = JSON.parse(await browser('eval', 'window.scrollY', '--json')).data.result;
  await browser(
    'eval',
    'document.querySelectorAll(".catalog article .resource-details")[1].click()',
  );
  await browser(
    'wait',
    '--fn',
    'getComputedStyle(document.querySelector(".catalog")).display === "none"',
  );
  // Give the short fixture detail the height of a real README.
  await browser(
    'eval',
    'document.querySelector(".detail").style.minHeight="3000px"; window.scrollTo(0, ' +
      (visibleAt + 1000) +
      ')',
  );
  await browser('eval', 'document.querySelector(".detail-top button").click()');
  await browser(
    'wait',
    '--fn',
    'getComputedStyle(document.querySelector(".catalog")).display !== "none"',
  );
  const hiddenGeometry = JSON.parse(
    await browser(
      'eval',
      '({scrollY:window.scrollY,bottom:document.querySelector(' +
        JSON.stringify(target) +
        ')?.getBoundingClientRect().bottom})',
      '--json',
    ),
  ).data.result;
  assert.ok(hiddenGeometry.scrollY > visibleAt && hiddenGeometry.bottom < 0);
  const readsBefore = resourceReads;
  for (let i = 0; i < 50 && resourceReads < readsBefore + 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    resourceReads >= readsBefore + 2,
    'The hidden-return case must include actual list polling',
  );
  assert.equal(
    catalog.get(hiddenTarget.id).viewed,
    false,
    'Scrolling in hidden mobile detail must not mark a list row viewed',
  );

  db.prepare("DELETE FROM runs WHERE id='browser-active'").run();
  await browser(
    'wait',
    '--fn',
    '!Array.from(document.querySelectorAll("button")).find(e => e.textContent === "保存配置").disabled',
  );
  await browser('fill', '[aria-label="收集参数"] .collect-fields label:nth-child(4) input', '-1');
  await browser('fill', '[aria-label="收集参数"] .collect-fields label:nth-child(5) input', '-1');
  await browser('find', 'role', 'button', 'click', '--name', '保存配置', '--exact');
  await browser('wait', '--text', '收集默认值与查看条件已保存');
  assert.equal(catalog.getSettings().collection.judgmentLimit, -1);
  assert.equal(catalog.getSettings().collection.discoveryRequestLimit, -1);
  await browser('reload');
  await browser(
    'wait',
    '--fn',
    'document.querySelector("[aria-label=收集参数] .collect-fields label:nth-child(4) input")?.value === "-1" && document.querySelector("[aria-label=收集参数] .collect-fields label:nth-child(5) input")?.value === "-1"',
  );

  assert.equal(externalCalls, 0);
  console.log(
    'Browser smoke passed: settings/input recovery, both -1 budgets save and reload, Noul history and withheld labels, manual override restoration, multi-folder create/rename/delete/filter and membership display, delayed GET preserves consecutive folder and manual-label writes, shrinking last page recovers, scroll-past marks viewed and filters it out while never-visible records stay unviewed, hidden mobile detail scrolling cannot mark rows on return/poll, automatic detail viewed and manual unviewed preserved by polling, active polling preserves README and label drafts, mobile return navigation; external calls=0.',
  );
} catch (e) {
  console.log('REQUEST TRACE', JSON.stringify(requestTrace));
  console.log('UI FAILURE', await browser('snapshot', '-i').catch((error) => String(error)));
  console.log('DB FAILURE', JSON.stringify(catalog.get(reviewId).folders));
  throw e;
} finally {
  await closeBrowserAndApp(browser, async () => {
    await collection.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Detail } from '../src/web/Detail.tsx';
import { ResourceList, ResourceViewport } from '../src/web/ResourceList.tsx';
import { Filters } from '../src/web/Filters.tsx';
import { RunPanel } from '../src/web/RunPanel.tsx';
import { CollectPanel } from '../src/web/CollectPanel.tsx';
import {
  defaults,
  defaultFilter,
  emptyStats,
  unknownUsage,
  type ResourceDetail,
  type RunRecord,
} from '../src/shared/contracts.ts';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { taxonomy } from '../src/shared/taxonomy.ts';
import { evidence, repository, providerResponse } from './fixtures.ts';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { readFileSync } from 'node:fs';
const noop = () => {};

test('pagination remains reachable when a mutation shrinks the current last page', () => {
  const html = renderToStaticMarkup(
    createElement(ResourceList, {
      data: { items: [], total: 50, page: 2, pageSize: 50 },
      selected: null,
      loading: false,
      onSelect: noop,
      onPage: noop,
      onViewed: async () => true,
    }),
  );
  assert.match(html, /上一页/);
});
const result = {
  ...interpretResponse(providerResponse(), buildJevBody(evidence, taxonomy).questions),
  request: {},
  response: providerResponse(),
};
const detail: ResourceDetail = {
  ...repository(),
  folders: [],
  viewed: false,
  labels: ['form.skills'],
  facetStates: { form: 'confirmed', purpose: 'none', capability: 'none' },
  effectiveState: 'ignored',
  override: { decision: 'ignore', labels: ['form.skills'] },
  sources: {
    items: [
      {
        key: 'search',
        label: 'search:skill',
        parentId: null,
        discoveredAt: new Date().toISOString(),
      },
    ],
    total: 1,
    page: 1,
    pageSize: 50,
  },
  evidence: {
    id: 'e',
    repositoryId: repository().id,
    hash: 'hash',
    sha: 'sha',
    metadataEtag: null,
    readmeEtag: null,
    readAt: new Date().toISOString(),
    evidence: { ...evidence, readme: { ...evidence.readme, text: '<script>alert(1)</script>' } },
  },
  judgments: [{ id: 'j', state: 'complete', at: new Date().toISOString(), result, error: null }],
};
test('list refresh keeps a surviving visible row in place and ignores hidden, removed or offscreen rows', (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const scrolls: number[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerHeight: 1000, scrollBy: (x: number, y: number) => scrolls.push([x, y]) },
  });
  const rows = [
    { id: 1, top: 0, bottom: 240, height: 240 },
    { id: 2, top: 0, bottom: 0, height: 0 },
    { id: 3, top: -240, bottom: 0, height: 240 },
    { id: 4, top: 1000, bottom: 1240, height: 240 },
    { id: 5, top: -20, bottom: 220, height: 240 },
    { id: 6, top: 220, bottom: 460, height: 240 },
  ];
  const elements = rows.map((row) => ({
    dataset: { repositoryId: String(row.id) },
    isConnected: true,
    getBoundingClientRect: () => row,
  }));
  const data = {
    items: rows.map((row) => ({ ...detail, id: row.id })),
    total: 6,
    page: 1,
    pageSize: 50,
  };
  const previous = { data, loading: false, listRef: { current: null }, children: null };
  const props = {
    ...previous,
    data: { ...data, items: data.items.slice(1), total: 5 },
    listRef: {
      current: { querySelectorAll: () => elements } as unknown as HTMLDivElement,
    },
  };
  const viewport = new ResourceViewport(props),
    position = viewport.getSnapshotBeforeUpdate(previous);
  assert.equal(position?.element, elements[4]);
  rows[4].top -= 240;
  viewport.componentDidUpdate(previous, {}, position);
  assert.deepEqual(scrolls, [[0, -240]], 'Removing a row above must keep the current row at -20px');
  scrolls.length = 0;
  rows[4].top = -20;
  viewport.componentDidUpdate(previous, {}, position);
  assert.deepEqual(scrolls, [[0, 0]], 'Native scroll anchoring must not be applied twice');
  scrolls.length = 0;
  elements[4].isConnected = false;
  viewport.componentDidUpdate(previous, {}, position);
  viewport.componentDidUpdate(previous, {}, null);
  assert.deepEqual(scrolls, []);
  assert.equal(viewport.getSnapshotBeforeUpdate(props), null);
  assert.equal(viewport.getSnapshotBeforeUpdate({ ...previous, data: { ...data, page: 2 } }), null);
  assert.equal(
    new ResourceViewport({ ...props, listRef: { current: null } }).getSnapshotBeforeUpdate(
      previous,
    ),
    null,
  );
  assert.equal(
    new ResourceViewport({
      ...props,
      data: { ...data, items: data.items.slice(1, 4) },
    }).getSnapshotBeforeUpdate(previous),
    null,
  );
});
test('empty detail retains a return path while loading or after a failed request', () => {
  const html = renderToStaticMarkup(
    createElement(Detail, {
      value: null,
      onClose: noop,
      onSourcePage: noop,
      folders: [],
      onPersonal: noop,
      personalBusy: false,
      onOverride: noop,
      onRejudge: noop,
      busy: false,
    }),
  );
  assert.match(html, /<button[^>]*>返回列表<\/button>/);
});
test('detail safely displays original evidence, provenance and human decisions apart from model suggestions', () => {
  const html = renderToStaticMarkup(
    createElement(Detail, {
      value: detail,
      onClose: noop,
      onSourcePage: noop,
      folders: [],
      onPersonal: noop,
      personalBusy: false,
      onOverride: noop,
      onRejudge: noop,
      busy: false,
    }),
  );
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('采用标签'));
  assert.ok(!html.includes('标签采用依据'));
  assert.ok(html.includes('相关概率 1'));
  assert.ok(html.includes('支持概率 0'));
  assert.match(html, /not_supported \/ 最高概率 1/);
  assert.ok(html.includes('search:skill'));
  assert.ok(html.includes('已忽略'));
  assert.ok(html.includes('人工整理'));
  assert.ok(html.includes('重新判断（付费）'));
  assert.ok(
    renderToStaticMarkup(
      createElement(Detail, {
        value: { ...detail, evidence: null, judgments: [], filterReason: '无 README' },
        onClose: noop,
        onSourcePage: noop,
        folders: [],
        onPersonal: noop,
        personalBusy: false,
        onOverride: noop,
        onRejudge: noop,
        busy: true,
      }),
    ).includes('无 README'),
  );
});
test('repository rows show Star, push time, links, three facets and pagination before opening detail', () => {
  const html = renderToStaticMarkup(
    createElement(ResourceList, {
      data: { items: [detail], total: 100, page: 1, pageSize: 50 },
      selected: detail.id,
      loading: false,
      onSelect: noop,
      onPage: noop,
      onViewed: async () => true,
    }),
  );
  assert.match(
    html,
    /<a class="repo" href="https:\/\/github.com\/vercel-labs\/agent-browser" target="_blank" rel="noreferrer">vercel-labs\/agent-browser<\/a>/,
  );
  assert.match(html, /<button class="resource-details" aria-pressed="true">查看详情<\/button>/);
  for (const value of [
    '43,935',
    '查看详情',
    '资源形态',
    '任务用途',
    'agent 能力',
    '采集',
    '下一页',
  ])
    assert.ok(html.includes(value));
  assert.ok(
    renderToStaticMarkup(
      createElement(ResourceList, {
        data: { items: [], total: 0, page: 1, pageSize: 50 },
        selected: null,
        loading: false,
        onSelect: noop,
        onPage: noop,
        onViewed: async () => true,
      }),
    ).includes('调整左侧查看条件'),
  );
});
test('collection and view controls expose their independent defaults and bounds', () => {
  const collection = renderToStaticMarkup(
    createElement(CollectPanel, {
      value: defaults,
      onChange: noop,
      onSave: noop,
      onStart: noop,
      busy: false,
      status: null,
    }),
  );
  for (const value of [
    'value="-1"',
    'value="100"',
    'value="180"',
    'value="40"',
    'max="1000"',
    '明确重试失败请求',
  ])
    assert.ok(collection.includes(value));
  const filters = renderToStaticMarkup(
    createElement(Filters, { folders: [], value: defaultFilter, onChange: noop }),
  );
  assert.equal((filters.match(/type="checkbox"/g) ?? []).length, 15);
  assert.ok(filters.includes('仅筛选本地记录'));
});
test('task history retains partial coverage, unknown cost and explicit cancellation', () => {
  const run: RunRecord = {
    id: 'r',
    command: { kind: 'collect', settings: defaults },
    status: 'partial',
    stage: '读取',
    startedAt: new Date().toISOString(),
    endedAt: null,
    stats: { ...emptyStats(), ...unknownUsage, requests: 1 },
    errors: ['README 超过读取上限'],
    gaps: ['查询未完成'],
  };
  const html = renderToStaticMarkup(
    createElement(RunPanel, {
      data: { items: [run], total: 1, page: 1, pageSize: 20 },
      onCancel: noop,
      onPage: noop,
    }),
  );
  for (const value of [
    '部分完成',
    '查询未完成',
    'README 超过读取上限',
    '实际费用',
    '未知',
    '取消任务',
  ])
    assert.ok(html.includes(value));
});
test('client validation names invalid controls and numeric blanks stay renderable', async () => {
  const { settingsSchema } = await import('../src/shared/contracts.ts');
  const { validationMessage, inputNumber } = await import('../src/web/api.ts');
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const parsed = settingsSchema.safeParse({
      collection: { ...defaults, minStars: value },
      view: defaultFilter,
    });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.match(validationMessage(parsed.error), /收集参数.*最小 Star/);
    }
  }
  assert.equal(inputNumber(NaN), '');
  assert.equal(inputNumber(null), '');
  assert.equal(inputNumber(100), 100);
});

test('regression: list and detail use the current judgment certainty, even when cache restores a result older than the history window', () => {
  const db = openDatabase(':memory:');
  try {
    const record = repository({ judgmentId: 'current' });
    const confirmed = {
      ...interpretResponse(
        providerResponse(['form.tools', 'purpose.development']),
        buildJevBody(evidence, taxonomy).questions,
      ),
      request: {},
      response: {},
    };
    saveRepository(db, record);
    const insert = db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES(?,?,'r','k','complete','2026-10-14T00:00:00Z',?)",
    );
    insert.run('current', record.id, JSON.stringify(confirmed));
    const uncertain = structuredClone(confirmed);
    uncertain.decisions['label.capability.memory'].needsReview = true;
    for (let i = 0; i < 101; i++) insert.run('newer-' + i, record.id, JSON.stringify(uncertain));
    const catalog = createCatalog(db),
      value = catalog.get(record.id);
    assert.equal(
      value.judgments.some((j) => j.id === 'current'),
      false,
    );
    assert.deepEqual(value.facetStates, {
      form: 'confirmed',
      purpose: 'confirmed',
      capability: 'none',
    });
    const render = (value: ResourceDetail) =>
      renderToStaticMarkup(
        createElement(Detail, {
          value,
          onClose: noop,
          onSourcePage: noop,
          folders: [],
          onPersonal: noop,
          personalBusy: false,
          onOverride: noop,
          onRejudge: noop,
          busy: false,
        }),
      );
    assert.ok(!render(value).includes('部分待确认'));
    const list = catalog.list({ ...defaultFilter, minStars: 0, updatedWithinDays: null });
    assert.deepEqual(list.items[0].facetStates, {
      form: 'confirmed',
      purpose: 'confirmed',
      capability: 'none',
    });
    const html = renderToStaticMarkup(
      createElement(ResourceList, {
        data: list,
        selected: null,
        loading: false,
        onSelect: noop,
        onPage: noop,
        onViewed: async () => true,
      }),
    );
    assert.ok(html.includes('无匹配标签'));
    assert.ok(!html.includes('暂无确认标签'));
    record.judgmentId = 'newer-100';
    saveRepository(db, record);
    assert.deepEqual(catalog.get(record.id).facetStates, {
      form: 'confirmed',
      purpose: 'confirmed',
      capability: 'pending',
    });
    assert.match(render(catalog.get(record.id)), /class="muted small">待确认/);
    catalog.setOverride(record.id, { decision: null, labels: [] });
    assert.deepEqual(catalog.get(record.id).facetStates, {
      form: 'none',
      purpose: 'none',
      capability: 'none',
    });
  } finally {
    db.close();
  }
});

test('a confirmed model label withheld by relevance review is not displayed as no matching tags', () => {
  const request = buildJevBody(evidence, taxonomy);
  const response = providerResponse(['form.skills']);
  response.answers.relevance = { type: 'noul', noul: 0.7 };
  const saved = { ...interpretResponse(response, request.questions), request, response };
  const db = openDatabase(':memory:');
  try {
    const record = repository({ judgmentId: 'review', state: saved.status });
    saveRepository(db, record);
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES('review',?,'r','k','complete','2026-10-14T00:00:00Z',?)",
    ).run(record.id, JSON.stringify(saved));
    const resource = createCatalog(db).get(record.id);
    const html = renderToStaticMarkup(
      createElement(ResourceList, {
        data: { items: [resource], total: 1, page: 1, pageSize: 50 },
        selected: null,
        loading: false,
        onSelect: noop,
        onPage: noop,
        onViewed: async () => true,
      }),
    );
    const form = html.match(/<div class="band form">(.*?)<div class="band purpose">/s)?.[1] ?? '';
    assert.ok(!form.includes('无匹配标签'));
    assert.ok(form.includes('标签暂未应用'));
  } finally {
    db.close();
  }
});

test('historical classifications retain their saved labels without reinterpreting their certainty under current rules', () => {
  const db = openDatabase(':memory:');
  try {
    const row = JSON.parse(
      readFileSync('tests/live/results-14-regressions-1.json', 'utf8'),
    ).results.find((r: { name: string }) => r.name === 'mem0ai/mem0');
    const record = repository({ judgmentId: 'historical' });
    saveRepository(db, record);
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES(?,?,'r','k','complete','2026-10-14T00:00:00Z',?)",
    ).run('historical', record.id, JSON.stringify(row.result));
    const value = createCatalog(db).get(record.id);
    assert.deepEqual(value.labels, row.result.labels);
    assert.deepEqual(value.facetStates, {
      form: 'historical',
      purpose: 'historical',
      capability: 'historical',
    });
    const html = renderToStaticMarkup(
      createElement(Detail, {
        value,
        onClose: noop,
        onSourcePage: noop,
        folders: [],
        onPersonal: noop,
        personalBusy: false,
        onOverride: noop,
        onRejudge: noop,
        busy: false,
      }),
    );
    assert.match(html, /历史规则结果/);
    assert.ok(!html.includes('部分待确认'));
    createCatalog(db).setOverride(record.id, { decision: 'keep', labels: ['form.skills'] });
    assert.deepEqual(createCatalog(db).get(record.id).facetStates, {
      form: 'confirmed',
      purpose: 'none',
      capability: 'none',
    });
  } finally {
    db.close();
  }
});

test('a real historical unconfirmed label stays unapplied and displays its original probability and rule', () => {
  const historical = JSON.parse(
    readFileSync('tests/live/results-30-former-fresh-1.json', 'utf8'),
  ).results.find((row: { name: string }) => row.name === 'obra/superpowers').result;
  const db = openDatabase(':memory:');
  try {
    const record = repository({ judgmentId: 'historical' });
    saveRepository(db, record);
    db.prepare(
      "INSERT INTO judgments(id,repository_id,run_id,cache_key,state,at,result) VALUES(?,?,'r','k','complete','2026-10-14T00:00:00Z',?)",
    ).run('historical', record.id, JSON.stringify(historical));
    const value = createCatalog(db).get(record.id);
    assert.ok(!value.labels.includes('capability.interaction'));
    assert.equal(value.facetStates.capability, 'historical');
    assert.equal(value.judgments[0].result?.ruleVersion, 'atlas-30');
    const html = renderToStaticMarkup(
      createElement(Detail, {
        value,
        onClose: noop,
        onSourcePage: noop,
        folders: [],
        onPersonal: noop,
        personalBusy: false,
        onOverride: noop,
        onRejudge: noop,
        busy: false,
      }),
    );
    assert.match(html, /历史规则结果/);
    assert.match(html, /atlas-30/);
    assert.match(html, /最高概率 0\.51/);
    assert.match(html, /待确认/);
  } finally {
    db.close();
  }
});

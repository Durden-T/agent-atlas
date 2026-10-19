import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createBrowser, closeBrowserAndApp } from './browser.ts';
import { liveDatabasePath, stopProcess } from './live-support.ts';
import {
  openDatabase,
  defaultDatabasePath,
  getRepository,
  saveRepository,
} from '../src/server/database.ts';
import { dateText } from '../src/web/api.ts';
import type {
  AppStatus,
  Settings,
  RunRecord,
  Page,
  CatalogResource,
  ResourceDetail,
  Folder,
} from '../src/shared/contracts.ts';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, resume: { type: 'string' } } });
if (!values.run) throw new Error('Real GitHub and paid Jev E2E requires explicit --run');
if (!process.env.JEV_OPENROUTER_KEY?.trim()) throw new Error('JEV_OPENROUTER_KEY is missing');
const budget = 100,
  directory = values.resume
    ? resolve(values.resume)
    : resolve(
        '.comet/live-e2e',
        new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
      );
assert.ok(directory.startsWith(resolve('.comet/live-e2e') + '/'));
if (values.resume) assert.ok(existsSync(join(directory, 'atlas.sqlite')));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const databasePath = liveDatabasePath(directory, resolve('.comet/live-e2e'), defaultDatabasePath());
const browser = createBrowser('atlas-live-e2e');
const reportName = values.resume ? 'report-resume-' + Date.now() + '.json' : 'report.json';
const report: {
  directory: string;
  budget: number;
  steps: { name: string; requests: number; cumulative: number; run: RunRecord }[];
  checks: string[];
  errors: string[];
} = { directory, budget, steps: [], checks: [], errors: [] };
let child: ChildProcess | undefined,
  base = '';
const persist = () =>
  writeFileSync(join(directory, reportName), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
async function get<T>(path: string): Promise<T> {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
  if (!response.ok)
    throw new Error(
      'Local API ' + path + ': HTTP ' + response.status + ' ' + (await response.text()),
    );
  return (await response.json()) as T;
}
async function runs() {
  return await get<Page<RunRecord>>('/api/runs');
}
const usage = (page: Page<RunRecord>) => {
  assert.ok(
    page.total <= page.items.length,
    'Every paid run must remain in the bounded audit page',
  );
  return page.items.reduce((n, r) => n + r.stats.requests, 0);
};
async function startApp() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => socket.close(() => done()));
  base = 'http://127.0.0.1:' + address.port;
  const appProcess = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PORT: String(address.port),
      ATLAS_DATABASE_PATH: databasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = appProcess;
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Production process startup timed out')),
      15000,
    );
    appProcess.once('error', reject);
    appProcess.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Production process exited: ' + code));
    });
    appProcess.stdout!.on('data', (chunk: Buffer) => {
      appendFileSync(join(directory, 'server.log'), chunk, { mode: 0o600 });
      if (chunk.toString().includes('Agent Atlas:')) {
        clearTimeout(timer);
        done();
      }
    });
    appProcess.stderr!.on('data', (chunk: Buffer) =>
      appendFileSync(join(directory, 'server.log'), chunk, { mode: 0o600 }),
    );
  });
  const status = await get<AppStatus>('/api/status');
  assert.equal(status.databasePath, databasePath);
  assert.equal(status.jevConfigured, true);
  assert.notEqual(status.githubAuthentication, 'missing');
  assert.equal(status.activeRun, null);
  await browser('open', base);
  await browser('wait', '--text', '收集参数');
}
async function stopApp() {
  const appProcess = child;
  child = undefined;
  await stopProcess(appProcess);
}
const fill = (index: number, value: string) =>
  browser(
    'fill',
    '[aria-label="收集参数"] .collect-fields label:nth-child(' + index + ') input',
    value,
  );
async function click(name: string) {
  await browser(
    'wait',
    '--fn',
    'Array.from(document.querySelectorAll("button")).some(e=>(e.getAttribute("aria-label") ?? e.textContent.trim()) === ' +
      JSON.stringify(name) +
      ' && !e.disabled && e.getClientRects().length > 0)',
  );
  await browser('find', 'role', 'button', 'click', '--name', name, '--exact');
}
async function save() {
  await click('保存配置');
  await browser('wait', '--text', '收集默认值与查看条件已保存');
}
async function run(name: string, button: string, expected: number, quota?: number, cancel = false) {
  const before = await runs(),
    used = usage(before),
    remaining = budget - used;
  assert.ok(remaining > 0, 'Total paid request budget exhausted');
  await fill(4, String(Math.min(quota ?? remaining, remaining)));
  const validity = JSON.parse(
    await browser(
      'eval',
      'Array.from(document.querySelectorAll(".collect-panel form input")).map(e=>({value:e.value,valid:e.validity.valid,message:e.validationMessage}))',
      '--json',
    ),
  ).data.result;
  assert.ok(
    validity.every((v: { valid: boolean }) => v.valid),
    JSON.stringify(validity),
  );
  console.log('LIVE STEP ' + name + ' (paid so far ' + used + '/' + budget + ')');
  await click(button);
  if (cancel) {
    await browser('wait', '--text', '取消任务');
    await click('取消任务');
  }
  let result: RunRecord | undefined;
  for (let i = 0; i < 600; i++) {
    const page = await runs();
    assert.ok(usage(page) <= budget);
    if (page.total === before.total + 1 && page.items[0].endedAt) {
      result = page.items[0];
      break;
    }
    if (i === 25 && page.total === before.total) {
      const state = await browser(
        'eval',
        '({alert:document.querySelector("[role=alert]")?.textContent,form:document.querySelector(".collect-panel form")?.checkValidity(),inputs:Array.from(document.querySelectorAll(".collect-panel form input")).map(e=>({value:e.value,valid:e.validity.valid,message:e.validationMessage}))})',
        '--json',
      );
      throw new Error('The browser click did not submit a task: ' + state);
    }
    await delay(200);
  }
  assert.ok(result, name + ': real task must finish within two minutes');
  report.steps.push({
    name,
    requests: result.stats.requests,
    cumulative: usage(await runs()),
    run: result,
  });
  persist();
  assert.equal(result.stats.requests, expected, name + ': actual paid dispatch count');
  if (cancel) assert.equal(result.status, 'cancelled');
  else assert.deepEqual(result.errors, [], name + ': real upstream errors');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".runs > details > summary")?.textContent.includes(' +
      JSON.stringify(dateText(result.startedAt)) +
      ') && Array.from(document.querySelectorAll(".runs > details:first-of-type .run-stats > div"))' +
      '.find(e => e.querySelector("dt")?.textContent === "实际 Jev 请求")?.querySelector("dd")?.textContent === ' +
      JSON.stringify(String(expected)) +
      ' && document.querySelector(".runs > details:first-of-type .run-content > p")?.textContent.includes("已结束")',
  );
  return result;
}
async function resources() {
  const settings = await get<Settings>('/api/settings');
  const filter = encodeURIComponent(
    JSON.stringify({
      ...settings.view,
      state: 'all',
      query: '',
      folderId: null,
      viewed: 'all',
      labels: [],
      minStars: 0,
      updatedWithinDays: null,
    }),
  );
  const all: CatalogResource[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await get<Page<CatalogResource>>(
      '/api/resources?filter=' + filter + '&page=' + page,
    );
    all.push(...response.items);
    if (all.length >= response.total) return all;
  }
  throw new Error('Live discovery exceeded the bounded 1000-repository audit');
}
async function detail(id: number) {
  return await get<ResourceDetail>('/api/resources/' + id);
}
async function exportEvidence() {
  const all = await resources();
  const details = [];
  for (const resource of all.filter((r) => r.evidenceId || r.judgmentId || r.error))
    details.push(await detail(resource.id));
  writeFileSync(join(directory, 'resources.json'), JSON.stringify(all, null, 2), { mode: 0o600 });
  writeFileSync(
    join(directory, 'raw-judgments-and-evidence.json'),
    JSON.stringify(details, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(join(directory, 'runs.json'), JSON.stringify(await runs(), null, 2), {
    mode: 0o600,
  });
  return details;
}
try {
  await browser('set', 'viewport', '1440', '1000');
  await startApp();
  if (!values.resume) {
    await fill(5, '9');
    await browser('select', '.filters > label:first-of-type select', 'all');
    await browser('fill', '.filters > label:nth-of-type(4) input', '0');
    await browser('fill', '.filters > label:nth-of-type(5) input', '');
    await run('real GitHub discovery and finite Jev quota', '开始收集', 5, 5);
    await run('continue real saved candidates', '继续待判断', 5, 5);
    let all = await resources();
    const judged = all.filter((r) => r.judgmentId),
      unjudged = all.filter((r) => !r.checkedAt);
    assert.equal(judged.length, 10);
    const bottom = Math.min(...judged.map((r) => r.metadata.stars));
    const next = Math.max(0, ...unjudged.map((r) => r.metadata.stars));
    assert.ok(
      bottom > next,
      'The observed Star order must allow an input-preserving refresh cohort',
    );
    const cutoff = Math.floor((bottom + next) / 2);
    await fill(1, String(cutoff));
    await fill(5, '5');
    let last = await run('completed results skip at minus one', '开始收集', 0);
    assert.ok(last.stats.skipped >= 10);
    for (let i = 0; last.stats.pending && i < 5; i++)
      last = await run('drain candidates below the collection threshold', '继续待判断', 0);
    assert.equal(last.stats.pending, 0);
    await fill(3, '0');
    last = await run('unchanged real GitHub evidence reuses Jev cache', '开始收集', 0);
    assert.ok(last.stats.cached >= 10);
  }
  await fill(3, '1');
  let last = await run('positive interval skips completed results', '开始收集', 0);
  assert.ok(last.stats.skipped >= 10);
  const judged = (await resources()).filter((r) => r.judgmentId);
  const target = judged[0];
  await click(target.metadata.full_name);
  await browser('wait', '--text', '标为未查看');
  assert.equal((await detail(target.id)).viewed, true);
  await click('标为未查看');
  await browser('wait', '--text', '标为已查看');
  await browser('click', '.folder-manager > summary');
  for (const folder of await get<Folder[]>('/api/folders')) {
    await click('删除收藏夹 ' + folder.name);
    await click('确认删除');
    await browser(
      'wait',
      '--fn',
      '!Array.from(document.querySelectorAll(".folder-manager input")).some(e=>e.getAttribute("aria-label") === ' +
        JSON.stringify('收藏夹名称 ' + folder.name) +
        ')',
    );
  }
  for (const name of ['端到端收藏甲', '端到端收藏乙']) {
    await browser('find', 'label', '新收藏夹名称', 'fill', name, '--exact');
    await click('创建收藏夹');
    await browser('wait', '--text', name);
    await browser('find', 'role', 'checkbox', 'click', '--name', name, '--exact');
    await browser(
      'wait',
      '--fn',
      'document.querySelector(".detail > .folder-memberships")?.textContent.includes(' +
        JSON.stringify(name) +
        ') && document.querySelector(".detail > fieldset input")?.disabled === false',
    );
  }
  const folders = await get<Folder[]>('/api/folders');
  assert.equal((await detail(target.id)).folders.length, 2);
  await browser('fill', '[aria-label="收藏夹名称 端到端收藏甲"]', '端到端保留');
  await click('重命名收藏夹 端到端收藏甲');
  await browser('wait', '--text', '端到端保留');
  const folderId = folders[0].id;
  await browser('select', '.filters > label:nth-of-type(2) select', String(folderId));
  await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 1');
  await browser('select', '.filters > label:nth-of-type(2) select', '');
  await click('删除收藏夹 端到端收藏乙');
  await click('确认删除');
  await browser(
    'wait',
    '--fn',
    '!Array.from(document.querySelectorAll(".folder-manager input")).some(e=>e.getAttribute("aria-label") === "收藏夹名称 端到端收藏乙")',
  );
  assert.equal((await detail(target.id)).folders.length, 1);
  await click('修正标签');
  await browser('check', '.detail form fieldset:first-child label:first-of-type input');
  await click('保存人工标签');
  await browser('wait', '--text', '当前有人工整理。');
  await click('忽略');
  await browser(
    'wait',
    '--fn',
    'document.querySelector(".detail")?.textContent.includes("已忽略 /")',
  );
  assert.equal((await detail(target.id)).override?.decision, 'ignore');
  const beforeLocal = usage(await runs());
  await browser('reload');
  await browser('wait', '--text', '收集参数');
  assert.equal(usage(await runs()), beforeLocal);
  await click(target.metadata.full_name);
  await browser('wait', '--text', '用已保存证据重新判断（付费）');
  if (!(await runs()).items.some((r) => r.command.kind === 'rejudge' && r.stats.judged === 1))
    await run(
      'explicit real Jev rejudge keeps personal decisions',
      '用已保存证据重新判断（付费）',
      1,
    );
  const paidAfterRejudge = usage(await runs());
  assert.equal((await detail(target.id)).override?.decision, 'ignore');
  report.checks.push(
    'real folder multi-membership, rename, filter, deletion, manual labels, ignore, viewed/unviewed and reload preservation',
  );
  await fill(4, '-1');
  await fill(5, '-1');
  await save();
  await browser('reload');
  await browser(
    'wait',
    '--fn',
    'document.querySelector("[aria-label=收集参数] .collect-fields label:nth-child(4) input")?.value === "-1" && document.querySelector("[aria-label=收集参数] .collect-fields label:nth-child(5) input")?.value === "-1"',
  );
  await fill(5, '5');
  await fill(3, '0');
  await run('cancel a real discovery without paid replay', '开始收集', 0, undefined, true);
  await fill(3, '-1');
  await run('continue after cancellation preserves successful judgments', '继续待判断', 0);
  await exportEvidence();
  const personalBeforeRestart = await detail(target.id);
  const rawBefore = new Map(
    (await resources()).filter((r) => r.judgmentId).map((r) => [r.id, r.judgmentId]),
  );
  await stopApp();
  const db = openDatabase(databasePath);
  try {
    for (const resource of judged) {
      const record = getRepository(db, resource.id)!;
      record.checkedAt = new Date(Date.now() - 2 * 86400000).toISOString();
      saveRepository(db, record);
    }
  } finally {
    db.close();
  }
  await startApp();
  assert.equal(usage(await runs()), paidAfterRejudge);
  const restored = await detail(target.id);
  assert.equal(restored.viewed, personalBeforeRestart.viewed);
  assert.equal(restored.override?.decision, 'ignore');
  assert.ok(restored.override?.labels?.includes('form.tools'));
  assert.equal(restored.folders[0]?.name, '端到端保留');
  await fill(3, '1');
  last = await run(
    'real process restart and expired interval retain cached judgments',
    '开始收集',
    0,
  );
  assert.ok(last.stats.cached >= 10);
  const all = await resources();
  for (const [id, judgmentId] of rawBefore)
    assert.equal(all.find((r) => r.id === id)?.judgmentId, judgmentId);
  await click(target.metadata.full_name);
  await browser('wait', '--text', '恢复模型建议');
  await click('恢复模型建议');
  await browser('wait', '--text', '当前使用模型建议。');
  assert.equal((await detail(target.id)).override, null);
  await browser('set', 'viewport', '390', '844');
  await browser(
    'wait',
    '--fn',
    'getComputedStyle(document.querySelector(".catalog")).display === "none"',
  );
  await click('返回列表');
  await browser(
    'wait',
    '--fn',
    'getComputedStyle(document.querySelector(".catalog")).display !== "none"',
  );
  await browser('set', 'viewport', '1440', '1000');
  await browser('eval', 'window.scrollTo(0,0)');
  await browser('screenshot', '--full', join(directory, 'live-desktop.png'));
  const details = await exportEvidence();
  const histories = details.flatMap((r) => r.judgments);
  const complete = histories.filter((j) => j.result).map((j) => j.result!);
  const totals = {
    requests: usage(await runs()),
    completed: complete.length,
    knownCost: complete.reduce((n, j) => n + (j.usage.cost ?? 0), 0),
    unknownCosts: complete.filter((j) => j.usage.cost === null).length,
    inputTokens: complete.reduce((n, j) => n + (j.usage.inputTokens ?? 0), 0),
    outputTokens: complete.reduce((n, j) => n + (j.usage.outputTokens ?? 0), 0),
    outcomeStates: Object.fromEntries(
      ['collected', 'review', 'unrelated'].map((s) => [
        s,
        details.filter((r) => r.state === s).length,
      ]),
    ),
  };
  writeFileSync(join(directory, 'totals.json'), JSON.stringify(totals, null, 2) + '\n', {
    mode: 0o600,
  });
  report.checks.push(
    'actual production process restart, aged checkedAt fixture, raw judgment identity retained, model restoration and mobile navigation',
  );
  persist();
  console.log(
    'LIVE E2E PASSED ' + JSON.stringify({ directory, steps: report.steps.length, ...totals }),
  );
} catch (error) {
  report.errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  persist();
  console.error('LIVE E2E FAILED ' + directory);
  console.error(await browser('snapshot', '-i').catch((failure) => String(failure)));
  await exportEvidence().catch((failure) => console.error('Evidence export failed', failure));
  throw error;
} finally {
  await closeBrowserAndApp(browser, stopApp);
  console.log('Live artifacts preserved at ' + directory);
}

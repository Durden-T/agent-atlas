import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createBrowser, closeBrowserAndApp } from './browser.ts';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';
import { defaults, emptyStats } from '../src/shared/contracts.ts';
import { repository } from '../tests/fixtures.ts';

const browser = createBrowser('atlas-scroll'),
  db = openDatabase(':memory:'),
  catalog = createCatalog(db);
let externalCalls = 0,
  resourceReads = 0;
const network = async () => {
  externalCalls++;
  throw new Error('Scroll regression must stay offline');
};
const collection = createCollection({
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
for (let i = 0; i < 60; i++) {
  const id = repository().id + i;
  saveRepository(
    db,
    repository({
      id,
      metadata: { ...repository().metadata, id, full_name: 'atlas-scroll-fixture/repo-' + i },
    }),
  );
}
const pollRun = JSON.stringify({
  id: 'scroll-poll',
  command: { kind: 'collect', settings: defaults },
  status: 'running',
  stage: 'Scroll fixture',
  startedAt: new Date().toISOString(),
  endedAt: null,
  stats: emptyStats(),
  errors: [],
  gaps: [],
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
server.on('request', (req) => {
  if (req.url?.startsWith('/api/resources?')) resourceReads++;
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
async function evaluate<T>(script: string): Promise<T> {
  return JSON.parse(await browser('eval', script, '--json')).data.result;
}
try {
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    for (const viewed of ['all', 'unviewed'] as const) {
      db.exec('DELETE FROM runs');
      db.exec('DELETE FROM personal_state');
      const settings = catalog.getSettings();
      catalog.saveSettings({
        ...settings,
        view: { ...settings.view, viewed, updatedWithinDays: null },
      });
      await browser('set', 'viewport', String(width), String(height));
      await browser('open', 'http://127.0.0.1:' + address.port);
      await browser('wait', '--fn', 'document.querySelectorAll(".catalog article").length === 50');
      await browser('find', 'role', 'button', 'click', '--name', '保存配置', '--exact');
      await browser('wait', '--text', '收集默认值与查看条件已保存');
      db.prepare('INSERT INTO runs(id,data) VALUES(?,?)').run('scroll-poll', pollRun);
      await evaluate('document.querySelector(".catalog article").scrollIntoView({block:"start"})');
      await browser(
        'wait',
        '--fn',
        'Math.abs(document.querySelector(".catalog article").getBoundingClientRect().top) < 1',
      );
      // Capture the reading position in the same frame that initiates the user's scroll.
      const before = await evaluate<{ id: number; top: number; scrollY: number }>(`(() => {
        const first = document.querySelector('.catalog article');
        const anchor = first.nextElementSibling;
        window.scrollBy(0, first.getBoundingClientRect().height + 20);
        return {id:Number(anchor.dataset.repositoryId), top:anchor.getBoundingClientRect().top, scrollY};
      })()`);
      const firstId = repository().id,
        readsBefore = resourceReads;
      for (
        let i = 0;
        i < 60 && (!catalog.get(firstId).viewed || resourceReads < readsBefore + 3);
        i++
      )
        await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        catalog.get(firstId).viewed,
        true,
        'The row scrolled past must be saved as viewed',
      );
      assert.ok(
        resourceReads >= readsBefore + 3,
        'The reading position must survive actual polling',
      );
      const after = await evaluate<{
        top: number | null;
        scrollY: number;
        workbenchScroll: number;
      }>(`({
        top:document.querySelector('[data-repository-id="${before.id}"]')?.getBoundingClientRect().top ?? null,
        scrollY,
        workbenchScroll:document.querySelector('.workbench').scrollTop
      })`);
      console.log(JSON.stringify({ viewport: [width, height], viewed, before, after }));
      assert.notEqual(
        after.top,
        null,
        'The current row must not be marked viewed without more scrolling',
      );
      assert.ok(
        Math.abs(after.top! - before.top) <= 2,
        'Saving viewed state and polling must preserve the visible reading position',
      );
      assert.equal(after.workbenchScroll, 0, 'Only the document should scroll');
      assert.equal(catalog.get(before.id).viewed, false);
      assert.equal(catalog.get(repository().id + 49).viewed, false);
    }
  }
  assert.equal(externalCalls, 0);
  console.log(
    'Scroll browser regression passed: desktop/mobile, all/unviewed, polling; external calls=0.',
  );
} finally {
  await closeBrowserAndApp(browser, async () => {
    await collection.shutdown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
}

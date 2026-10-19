import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { defaultFilter, defaults } from '../src/shared/contracts.ts';
import { repository } from './fixtures.ts';

test('folders support multiple memberships, renaming, combined filters, and deletion without deleting resources', () => {
  const db = openDatabase(':memory:');
  try {
    const catalog = createCatalog(db),
      repo = repository();
    saveRepository(db, repo);
    saveRepository(db, repository({ id: repo.id + 1 }));
    const a = catalog.changeFolder({ kind: 'create', name: ' 开发 ' })!;
    const b = catalog.changeFolder({ kind: 'create', name: '研究' })!;
    catalog.setPersonal(repo.id, { folderIds: [a.id, b.id], viewed: true });
    catalog.setPersonal(repo.id + 1, { folderIds: [a.id] });
    const filter = { ...defaultFilter, minStars: 0, updatedWithinDays: null };
    assert.equal(catalog.list({ ...filter, folderId: a.id }).total, 2);
    assert.equal(catalog.list({ ...filter, folderId: b.id, viewed: 'viewed' }).total, 1);
    assert.equal(catalog.list({ ...filter, folderId: b.id, viewed: 'unviewed' }).total, 0);
    assert.deepEqual(
      catalog
        .get(repo.id)
        .folders.map((f) => f.name)
        .sort(),
      ['开发', '研究'],
    );
    catalog.changeFolder({ kind: 'rename', id: b.id, name: '科研' });
    assert.equal(catalog.get(repo.id).folders.find((f) => f.id === b.id)?.name, '科研');
    catalog.saveSettings({ collection: defaults, view: { ...filter, folderId: b.id } });
    catalog.changeFolder({ kind: 'delete', id: b.id });
    assert.equal(catalog.getSettings().view.folderId, null);
    assert.deepEqual(catalog.get(repo.id).folders, [a]);
    assert.equal(catalog.get(repo.id).viewed, true);
    assert.equal(catalog.list(filter).total, 2);
    catalog.setPersonal(repo.id, { folderIds: [] });
    assert.deepEqual(catalog.get(repo.id).folders, []);
    assert.equal(catalog.get(repo.id).viewed, true);
  } finally {
    db.close();
  }
});
test('invalid folders and duplicate names fail without partially changing personal state', () => {
  const db = openDatabase(':memory:');
  try {
    const catalog = createCatalog(db),
      repo = repository();
    saveRepository(db, repo);
    const folder = catalog.changeFolder({ kind: 'create', name: 'Work' })!;
    catalog.setPersonal(repo.id, { folderIds: [folder.id], viewed: false });
    assert.throws(() => catalog.changeFolder({ kind: 'create', name: 'work' }), /已存在/);
    assert.throws(() => catalog.changeFolder({ kind: 'create', name: ' ' }));
    assert.throws(
      () => catalog.changeFolder({ kind: 'rename', id: 999, name: 'Missing' }),
      /不存在/,
    );
    assert.throws(
      () => catalog.setPersonal(repo.id, { folderIds: [folder.id, 999], viewed: true }),
      /不存在/,
    );
    assert.equal(catalog.get(repo.id).viewed, false);
    assert.deepEqual(catalog.get(repo.id).folders, [folder]);
    assert.throws(() => catalog.setPersonal(repo.id, { folderIds: [folder.id, folder.id] }));
    assert.throws(() => catalog.setPersonal(repo.id, {}));
    assert.throws(() => catalog.setPersonal(999, { viewed: true }), /不存在/);
    catalog.setPersonal(repo.id, { viewed: true });
    catalog.setPersonal(repo.id, { viewed: true });
    assert.equal(catalog.get(repo.id).viewed, true);
    assert.deepEqual(catalog.get(repo.id).folders, [folder]);
  } finally {
    db.close();
  }
});
test('personal organization survives repository rewrites, old settings, and a real database restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-personal-'));
  const path = join(dir, 'atlas.sqlite');
  let db = openDatabase(path);
  try {
    const repo = repository(),
      catalog = createCatalog(db);
    saveRepository(db, repo);
    const folder = catalog.changeFolder({ kind: 'create', name: '收藏' })!;
    catalog.setPersonal(repo.id, { viewed: true, folderIds: [folder.id] });
    saveRepository(db, { ...repo, state: 'unrelated', metadata: { ...repo.metadata, stars: 200 } });
    const { folderId, viewed, ...legacyView } = defaultFilter;
    db.prepare("INSERT INTO settings(key,data) VALUES('view',?)").run(JSON.stringify(legacyView));
    assert.equal(catalog.getSettings().view.folderId, null);
    assert.equal(catalog.getSettings().view.viewed, 'all');
    db.close();
    db = openDatabase(path);
    const restored = createCatalog(db);
    assert.equal(restored.get(repo.id).viewed, true);
    assert.deepEqual(restored.get(repo.id).folders, [folder]);
    restored.setPersonal(repo.id, { viewed: false });
    assert.equal(restored.get(repo.id).viewed, false);
    assert.deepEqual(restored.get(repo.id).folders, [folder]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

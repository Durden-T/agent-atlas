import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createSocket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, saveRepository } from '../src/server/database.ts';
import { createCatalog } from '../src/server/catalog/index.ts';
import { createCollection } from '../src/server/collection/index.ts';
import { createGithub } from '../src/server/github.ts';
import { createJudgment } from '../src/server/judgment/index.ts';
import { createHttpServer } from '../src/server/http.ts';
import { defaults } from '../src/shared/contracts.ts';
import { repository, evidence, now } from './fixtures.ts';

test('oversized local JSON requests receive a readable 413 response', async () => {
  const db = openDatabase(':memory:'),
    catalog = createCatalog(db);
  const collection = createCollection({
    db,
    github: createGithub({
      token: () => {
        throw new Error('Offline');
      },
    }),
    judgment: createJudgment({ key: () => undefined }),
    settings: () => defaults,
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
    webRoot: resolve('.'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  try {
    const response = await new Promise<{ status: number; body: string }>((done, reject) => {
      const request = httpRequest(
        origin + '/api/settings',
        { method: 'POST', headers: { origin, 'content-type': 'application/json' } },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('error', reject);
          response.on('end', () => done({ status: response.statusCode!, body }));
        },
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('Local request timed out')));
      request.write('a'.repeat(200 * 1024));
      const more = setTimeout(() => request.write('a'.repeat(100 * 1024)), 10);
      const end = setTimeout(() => request.end('a'.repeat(50 * 1024)), 100);
      request.once('close', () => {
        clearTimeout(more);
        clearTimeout(end);
      });
    });
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /大小上限/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await collection.shutdown();
    db.close();
  }
});

test('source startup serves the built page when an ancestor directory is named dist', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-source-root-')),
    project = join(directory, 'dist', 'project');
  mkdirSync(project, { recursive: true });
  cpSync('src', join(project, 'src'), { recursive: true });
  cpSync('package.json', join(project, 'package.json'));
  symlinkSync(resolve('node_modules'), join(project, 'node_modules'));
  mkdirSync(join(project, 'dist', 'web'), { recursive: true });
  writeFileSync(join(project, 'dist', 'web', 'index.html'), '<h1>Isolated startup check</h1>');
  const socket = createSocket();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((r) => socket.close(() => r()));
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: project,
    env: {
      ...process.env,
      PORT: String(address.port),
      ATLAS_DATABASE_PATH: join(directory, 'isolated.sqlite'),
      GH_TOKEN: 'offline-fixture',
      GITHUB_TOKEN: '',
      JEV_OPENROUTER_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated startup timed out')), 10000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Isolated startup exited: ' + code));
      });
      child.stdout!.on('data', (chunk) => {
        if (String(chunk).includes('Agent Atlas:')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const response = await fetch('http://127.0.0.1:' + address.port, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Isolated startup check/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true });
  }
});

test('active status includes a running rejudge even outside the selected task-history page', async () => {
  const db = openDatabase(':memory:'),
    record = repository({ evidenceId: 'saved' });
  saveRepository(db, record);
  db.prepare('INSERT INTO evidence(id,repository_id,hash,data) VALUES(?,?,?,?)').run(
    'saved',
    record.id,
    'saved',
    JSON.stringify({
      id: 'saved',
      repositoryId: record.id,
      hash: 'saved',
      evidence,
      sha: 'saved',
      metadataEtag: null,
      readmeEtag: null,
      readAt: new Date(now).toISOString(),
    }),
  );
  const collection = createCollection({
    db,
    github: createGithub({
      token: () => {
        throw new Error('Rejudge must not read GitHub');
      },
    }),
    judgment: createJudgment({
      key: () => 'fixture',
      fetch: async (_url, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          }),
        ),
    }),
    settings: () => ({ ...defaults, updatedWithinDays: null }),
    canJudge: () => true,
    now: () => now,
  });
  try {
    const started = collection.start({ kind: 'rejudge', repositoryId: record.id });
    assert.equal(collection.activeRun()?.id, started.run.id);
    assert.equal(collection.activeRun()?.command.kind, 'rejudge');
  } finally {
    await collection.shutdown();
    db.close();
  }
});

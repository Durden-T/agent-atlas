import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { liveDatabasePath, stopProcess } from '../scripts/live-support.ts';
import { closeBrowserAndApp } from '../scripts/browser.ts';

test('browser cleanup failure still shuts down the application and preserves the failure', async () => {
  const failure = new Error('Browser crashed');
  let stopped = false;
  await assert.rejects(
    closeBrowserAndApp(
      async () => {
        throw failure;
      },
      async () => {
        stopped = true;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(stopped, true);
});
test('live test isolation rejects directory and database symlinks to personal data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-isolation-')),
    root = join(dir, 'runs'),
    personal = join(dir, 'personal');
  try {
    mkdirSync(root);
    mkdirSync(personal);
    writeFileSync(join(personal, 'atlas.sqlite'), 'personal');
    symlinkSync(personal, join(root, 'linked-directory'));
    assert.throws(() =>
      liveDatabasePath(join(root, 'linked-directory'), root, join(personal, 'atlas.sqlite')),
    );
    mkdirSync(join(root, 'valid'));
    symlinkSync(join(personal, 'atlas.sqlite'), join(root, 'valid', 'atlas.sqlite'));
    assert.throws(() =>
      liveDatabasePath(join(root, 'valid'), root, join(personal, 'atlas.sqlite')),
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test('stopping a process that has already exited by signal does not wait for another exit', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  assert.notEqual(child.signalCode, null);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const done = await Promise.race([stopProcess(child).then(() => true), delay(20, false)]);
  assert.equal(done, true);
});

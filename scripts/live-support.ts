import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';

export function liveDatabasePath(directory: string, root: string, defaultPath: string): string {
  assert.ok(directory.startsWith(resolve(root) + sep));
  const physicalDirectory = realpathSync(directory);
  assert.ok(
    physicalDirectory.startsWith(realpathSync(root) + sep),
    'Live directory must remain inside the test root',
  );
  const database = join(physicalDirectory, 'atlas.sqlite');
  if (existsSync(database)) {
    assert.equal(realpathSync(database), database, 'Live database cannot be a symlink');
    if (existsSync(defaultPath)) {
      const actual = statSync(database),
        personal = statSync(defaultPath);
      assert.ok(
        actual.dev !== personal.dev || actual.ino !== personal.ino,
        'Live database cannot be the personal database',
      );
    }
  }
  assert.notEqual(database, resolve(defaultPath));
  return database;
}
export async function stopProcess(appProcess: ChildProcess | undefined) {
  if (!appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null) return;
  const exited = once(appProcess, 'exit');
  appProcess.kill('SIGTERM');
  const timer = setTimeout(() => appProcess.kill('SIGKILL'), 10000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

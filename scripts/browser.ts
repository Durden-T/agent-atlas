import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function createBrowser(prefix: string) {
  const session = prefix + '-' + randomUUID().slice(0, 8);
  return async (...args: string[]) =>
    (
      await exec(
        'agent-browser',
        ['--session', session, '--allowed-domains', '127.0.0.1', ...args],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      )
    ).stdout;
}
export async function closeBrowserAndApp(
  browser: ReturnType<typeof createBrowser>,
  shutdown: () => Promise<void>,
) {
  try {
    await browser('close');
  } finally {
    await shutdown();
  }
}

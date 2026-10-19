import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openDatabase, defaultDatabasePath } from './database.ts';
import { createGithub, githubToken, githubAuthentication } from './github.ts';
import { createJudgment } from './judgment/index.ts';
import { createCatalog } from './catalog/index.ts';
import { createCollection } from './collection/index.ts';
import { createHttpServer } from './http.ts';
import { safeError } from './errors.ts';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT 必须为 1–65535 的整数');
const databasePath = process.env.ATLAS_DATABASE_PATH ?? defaultDatabasePath(),
  db = openDatabase(databasePath);
const catalog = createCatalog(db),
  github = createGithub({ token: githubToken });
const judgment = createJudgment({ key: () => process.env.JEV_OPENROUTER_KEY });
const collection = createCollection({
  db,
  github,
  judgment,
  settings: () => catalog.getSettings().collection,
  canJudge: () => Boolean(process.env.JEV_OPENROUTER_KEY?.trim()),
});
const authentication = githubAuthentication();
const server = createHttpServer({
  catalog,
  collection,
  status: () => ({
    databasePath,
    jevConfigured: Boolean(process.env.JEV_OPENROUTER_KEY?.trim()),
    githubAuthentication: authentication,
  }),
  webRoot: join(
    fileURLToPath(new URL('.', import.meta.url)),
    import.meta.url.endsWith('.js') ? '../web' : '../../dist/web',
  ),
});
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(`Agent Atlas: http://localhost:${port}\n`),
);
server.on('error', (error) => {
  process.stderr.write(safeError(error) + '\n');
  db.close();
  process.exitCode = 1;
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await collection.shutdown();
  server.closeAllConnections();
  db.close();
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { ZodError } from 'zod';
import type { Collection } from './collection/index.ts';
import type { createCatalog } from './catalog/index.ts';
import type { AppStatus } from '../shared/contracts.ts';
import {
  commandSchema,
  filterSchema,
  overrideSchema,
  settingsSchema,
  folderCommandSchema,
  personalSchema,
} from '../shared/contracts.ts';
import { AppError, safeError } from './errors.ts';

interface Options {
  catalog: ReturnType<typeof createCatalog>;
  collection: Collection;
  status: () => Omit<AppStatus, 'activeRun'>;
  webRoot: string;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new AppError('请求须为 application/json', 'content_type', 415);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256 * 1024) throw new AppError('请求超过大小上限', 'body_limit', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('请求不是有效 JSON');
  }
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
function positive(value: string) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new AppError('标识或分页参数非法');
  return number;
}
export function createHttpServer(options: Options) {
  const { catalog, collection } = options,
    root = resolve(options.webRoot);
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      let status = error instanceof AppError ? error.status : 500;
      let message = safeError(error);
      if (error instanceof ZodError) {
        status = 400;
        message = '输入参数非法';
      } else if (status === 500) message = '本机服务内部错误，请查看服务终端';
      json(
        res,
        {
          error: message,
        },
        status,
      );
      if (status === 500) process.stderr.write(safeError(error) + '\n');
    });
  });
  server.maxConnections = 100;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const host = req.headers.host,
      port = req.socket.localPort;
    if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
      throw new AppError('请求主机不受信任', 'host', 403);
    const origin = 'http://' + host,
      url = new URL(req.url ?? '/', origin),
      path = url.pathname;
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')
        throw new AppError('修改请求必须来自本机应用页面', 'origin', 403);
      const input = await body(req);
      if (path === '/api/folders') {
        json(res, catalog.changeFolder(folderCommandSchema.parse(input)));
        return;
      }
      const personal = path.match(/^\/api\/resources\/(\d+)\/personal$/);
      if (personal) {
        const id = positive(personal[1]);
        catalog.setPersonal(id, personalSchema.parse(input));
        json(res, catalog.get(id));
        return;
      }
      if (path === '/api/settings') {
        catalog.saveSettings(settingsSchema.parse(input));
        json(res, catalog.getSettings());
        return;
      }
      if (path === '/api/runs') {
        json(res, collection.start(commandSchema.parse(input)), 202);
        return;
      }
      const override = path.match(/^\/api\/resources\/(\d+)\/override$/);
      if (override) {
        json(res, catalog.setOverride(positive(override[1]), overrideSchema.parse(input)));
        return;
      }
      const cancel = path.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
      if (cancel) {
        json(res, collection.cancel(cancel[1]));
        return;
      }
      throw new AppError('接口不存在', 'not_found', 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      throw new AppError('请求方法不支持', 'method', 405);
    if (path === '/api/folders') {
      json(res, catalog.listFolders());
      return;
    }
    if (path === '/api/status') {
      json(res, { ...options.status(), activeRun: collection.activeRun() });
      return;
    }
    if (path === '/api/settings') {
      json(res, catalog.getSettings());
      return;
    }
    if (path === '/api/resources') {
      let filter: unknown = catalog.getSettings().view;
      if (url.searchParams.has('filter')) {
        try {
          filter = JSON.parse(url.searchParams.get('filter')!);
        } catch {
          throw new AppError('筛选参数不是有效 JSON');
        }
      }
      json(
        res,
        catalog.list(filterSchema.parse(filter), positive(url.searchParams.get('page') ?? '1')),
      );
      return;
    }
    const resource = path.match(/^\/api\/resources\/(\d+)$/);
    if (resource) {
      json(
        res,
        catalog.get(positive(resource[1]), positive(url.searchParams.get('sourcePage') ?? '1')),
      );
      return;
    }
    if (path === '/api/runs') {
      json(res, collection.listRuns(positive(url.searchParams.get('page') ?? '1')));
      return;
    }
    const run = path.match(/^\/api\/runs\/([\w-]+)$/);
    if (run) {
      json(res, collection.getRun(run[1]));
      return;
    }
    if (path.startsWith('/api/')) throw new AppError('接口不存在', 'not_found', 404);
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new AppError('文件路径非法');
    }
    const file = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!file.startsWith(root + sep)) throw new AppError('文件路径非法', 'path', 403);
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      throw new AppError('页面不存在；请先运行 npm run build', 'not_found', 404);
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.map': 'application/json',
    };
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  }
  return server;
}

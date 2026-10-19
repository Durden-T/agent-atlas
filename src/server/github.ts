// Keep the allowlisted transport and evidence reader together; splitting them would widen network access.
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type {
  RepositoryMetadata,
  RepositoryRecord,
  EvidenceSnapshot,
  RepositoryEvidence,
} from '../shared/contracts.ts';
import { AppError } from './errors.ts';
import { boundedJson, textPrefix, pause, limitConcurrency, type Fetch } from './transport.ts';

const githubSchema = z.object({
  id: z.number().int().positive().safe(),
  full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  private: z.literal(false),
  description: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  stargazers_count: z.number().int().nonnegative().safe(),
  pushed_at: z.iso.datetime().nullable(),
  language: z.string().nullable(),
  archived: z.boolean(),
  owner: z.object({ login: z.string().regex(/^[\w-]+$/), type: z.enum(['User', 'Organization']) }),
});
export function parseMetadata(input: unknown): RepositoryMetadata {
  const raw = githubSchema.safeParse(input);
  if (!raw.success)
    throw new AppError('GitHub 仓库元数据缺失、非法或不是公开仓库', 'invalid_github', 502);
  const r = raw.data;
  return {
    id: r.id,
    full_name: r.full_name,
    description: r.description,
    topics: r.topics,
    stars: r.stargazers_count,
    pushed_at: r.pushed_at,
    language: r.language,
    archived: r.archived,
    owner: r.owner.login,
    ownerType: r.owner.type,
  };
}
export function githubAuthentication(): 'environment' | 'gh' | 'missing' {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return 'environment';
  try {
    githubToken();
    return 'gh';
  } catch {
    return 'missing';
  }
}
let cliToken: string | undefined;
export function githubToken(): string {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env?.trim()) return env.trim();
  if (cliToken) return cliToken;
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16384,
    }).trim();
    if (token) return (cliToken = token);
  } catch {
    throw new AppError(
      'GitHub 未认证，请运行 gh auth login 或设置 GITHUB_TOKEN',
      'github_auth',
      401,
    );
  }
  throw new AppError('GitHub 登录凭据为空', 'github_auth', 401);
}
export function evidenceHash(evidence: RepositoryEvidence): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
export function truncateEvidence(evidence: RepositoryEvidence): RepositoryEvidence {
  const base = { ...evidence, readme: { ...evidence.readme, text: '', truncated: true } };
  const allowance = 48 * 1024 - Buffer.byteLength(JSON.stringify(base));
  if (allowance < 0) throw new AppError('仓库简介和主题超过证据上限', 'evidence_too_large');
  if (Buffer.byteLength(JSON.stringify(evidence)) <= 48 * 1024) return evidence;
  let length = 0;
  const chars: string[] = [];
  for (const char of evidence.readme.text) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (length + size > allowance) break;
    chars.push(char);
    length += size;
  }
  return { ...base, readme: { ...base.readme, text: chars.join('') } };
}
export interface GithubOptions {
  fetch?: Fetch;
  token: () => string;
  now?: () => number;
  sleep?: typeof pause;
}
export function createGithub(options: GithubOptions) {
  const limited = limitConcurrency(2);
  const fetcher = options.fetch ?? globalThis.fetch,
    now = options.now ?? Date.now,
    sleep = options.sleep ?? pause;
  async function request(
    path: string,
    signal: AbortSignal,
    extra: { etag?: string | null; consume?: () => void; redirects?: number; accept?: string } = {},
  ): Promise<Response> {
    if (
      !/^\/(search\/repositories\?|repos\/|users\/|orgs\/|repositories\/\d+(?:\/readme)?$)/.test(
        path,
      )
    )
      throw new AppError('GitHub 端点不在允许范围');
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      extra.consume?.();
      let response: Response;
      try {
        response = await fetcher('https://api.github.com' + path, {
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          headers: {
            Accept: extra.accept ?? 'application/vnd.github+json',
            Authorization: 'Bearer ' + options.token(),
            'X-GitHub-Api-Version': '2022-11-28',
            ...(extra.etag ? { 'If-None-Match': extra.etag } : {}),
          },
        });
      } catch (error) {
        if (signal.aborted || error instanceof AppError) throw error;
        if (attempt === 2)
          throw new AppError('GitHub 网络读取失败或超时（已重试 2 次）', 'network', 502);
        await sleep((attempt + 1) * 1000 + Math.floor(Math.random() * 500), signal);
        continue;
      }
      if ([301, 308].includes(response.status)) {
        const target = new URL(response.headers.get('location') || '', 'https://api.github.com');
        if (
          target.origin !== 'https://api.github.com' ||
          !/^\/(?:repos\/[\w.-]+\/[\w.-]+|repositories\/\d+)(?:\/readme)?$/.test(target.pathname) ||
          (extra.redirects ?? 0) >= 1
        )
          throw new AppError('GitHub 重定向超出允许范围', 'invalid_response', 502);
        await response.body?.cancel();
        return request(target.pathname, signal, { ...extra, redirects: 1 });
      }
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')))
      ) {
        const retry = response.headers.get('retry-after');
        const delay = retry
          ? Number(retry) * 1000
          : Number(response.headers.get('x-ratelimit-reset')) * 1000 - now();
        await response.body?.cancel();
        if (!Number.isFinite(delay) || delay < 0 || delay > 30000 || attempt === 2)
          throw new AppError('GitHub 限流，本轮保留进度，请稍后继续', 'rate_limit', 429);
        await sleep(Math.max(delay, 1000) + Math.floor(Math.random() * 500), signal);
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        if (attempt === 2)
          throw new AppError('GitHub 服务错误（已重试 2 次）', 'github_unavailable', 502);
        await sleep((attempt + 1) * 1000 + Math.floor(Math.random() * 500), signal);
        continue;
      }
      if ([200, 304, 404].includes(response.status)) return response;
      await response.body?.cancel();
      throw new AppError(
        `GitHub 请求失败：HTTP ${response.status}`,
        response.status === 401 ? 'github_auth' : 'github_response',
        response.status === 401 ? 401 : 502,
      );
    }
    throw new AppError('GitHub 读取未完成', 'github_unavailable', 502);
  }
  async function search(q: string, page: number, signal: AbortSignal, consume: () => void) {
    const query = new URLSearchParams({
      q,
      per_page: '100',
      sort: 'stars',
      order: 'desc',
      page: String(page),
    });
    const response = await request('/search/repositories?' + query, signal, { consume });
    if (response.status !== 200)
      throw new AppError('GitHub 搜索返回异常状态', 'invalid_response', 502);
    const data = z
      .object({
        total_count: z.number().int().nonnegative(),
        incomplete_results: z.boolean(),
        items: z.array(z.unknown()).max(100),
      })
      .parse(await boundedJson(response, 2 * 1024 * 1024));
    return {
      total: data.total_count,
      incomplete: data.incomplete_results,
      items: data.items.map(parseMetadata),
    };
  }
  async function owner(
    login: string,
    type: 'User' | 'Organization',
    page: number,
    signal: AbortSignal,
    consume: () => void,
  ) {
    if (!/^[\w-]+$/.test(login)) throw new AppError('GitHub 作者名称非法');
    const path =
      type === 'Organization'
        ? `/orgs/${login}/repos?type=public`
        : `/users/${login}/repos?type=owner`;
    const response = await request(path + `&per_page=100&page=${page}`, signal, { consume });
    if (response.status !== 200) throw new AppError('GitHub 作者读取失败', 'github_response', 502);
    const raw = z
      .array(z.unknown())
      .max(100)
      .parse(await boundedJson(response, 2 * 1024 * 1024));
    return {
      items: raw.map(parseMetadata),
      hasNext: response.headers.get('link')?.includes('rel="next"') ?? false,
    };
  }
  async function read(
    candidate: RepositoryMetadata,
    record: RepositoryRecord,
    previous: EvidenceSnapshot | null,
    signal: AbortSignal,
  ) {
    const metadataResponse = await request(`/repos/${candidate.full_name}`, signal, {
      etag: previous?.metadataEtag,
    });
    if (metadataResponse.status === 404)
      throw new AppError('GitHub 仓库不可访问或已删除', 'repository_missing', 404);
    const metadata =
      metadataResponse.status === 304
        ? record.metadata
        : parseMetadata(await boundedJson(metadataResponse, 512 * 1024));
    if (metadata.id !== record.id)
      throw new AppError('GitHub 仓库身份与扫描记录不一致', 'repository_identity', 502);
    const response = await request(`/repos/${metadata.full_name}/readme`, signal, {
      etag: previous?.readmeEtag,
    });
    if (response.status === 404) return { metadata, snapshot: null };
    let readme: RepositoryEvidence['readme'], sha: string;
    if (response.status === 304) {
      if (!previous) throw new AppError('缺少可复用的 README 证据', 'invalid_response', 502);
      readme = previous.evidence.readme;
      sha = previous.sha;
    } else {
      const raw = z
        .object({
          path: z.string().min(1),
          sha: z.string().min(1),
          encoding: z.enum(['base64', 'none']),
          content: z.string(),
        })
        .parse(await boundedJson(response, 2 * 1024 * 1024));
      if (raw.encoding === 'none') {
        if (raw.content !== '' || !/^[a-f0-9]{40}$/.test(raw.sha))
          throw new AppError('GitHub 大文件 README 元数据非法', 'invalid_response', 502);
        const blob = await request(`/repos/${metadata.full_name}/git/blobs/${raw.sha}`, signal, {
          accept: 'application/vnd.github.raw+json',
        });
        if (blob.status !== 200)
          throw new AppError('GitHub README 版本不可访问', 'invalid_response', 502);
        readme = { path: raw.path, ...(await textPrefix(blob, 48 * 1024)) };
      } else {
        const encoded = raw.content.replace(/\s/g, ''),
          buffer = Buffer.from(encoded, 'base64');
        if (buffer.toString('base64') !== encoded)
          throw new AppError('GitHub README base64 编码非法', 'invalid_response', 502);
        readme = {
          path: raw.path,
          text: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
          truncated: false,
        };
      }
      sha = raw.sha;
    }
    const evidence = truncateEvidence({
      full_name: metadata.full_name,
      description: metadata.description,
      topics: metadata.topics,
      readme,
    });
    const snapshot: EvidenceSnapshot = {
      id: randomUUID(),
      repositoryId: record.id,
      hash: evidenceHash(evidence),
      evidence,
      sha,
      metadataEtag:
        metadataResponse.headers.get('etag') ??
        (metadataResponse.status === 304 ? (previous?.metadataEtag ?? null) : null),
      readmeEtag:
        response.headers.get('etag') ??
        (response.status === 304 ? (previous?.readmeEtag ?? null) : null),
      readAt: new Date(now()).toISOString(),
    };
    return { metadata, snapshot };
  }
  return {
    search: (q: string, page: number, signal: AbortSignal, consume: () => void) =>
      limited(signal, () => search(q, page, signal, consume)),
    owner: (
      login: string,
      type: 'User' | 'Organization',
      page: number,
      signal: AbortSignal,
      consume: () => void,
    ) => limited(signal, () => owner(login, type, page, signal, consume)),
    read: (
      candidate: RepositoryMetadata,
      record: RepositoryRecord,
      previous: EvidenceSnapshot | null,
      signal: AbortSignal,
    ) => limited(signal, () => read(candidate, record, previous, signal)),
  };
}
export type Github = ReturnType<typeof createGithub>;

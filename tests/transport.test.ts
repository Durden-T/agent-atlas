import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJudgment,
  interpretResponse,
  JudgmentFailure,
} from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { createGithub, truncateEvidence } from '../src/server/github.ts';
import { taxonomy } from '../src/shared/taxonomy.ts';
import { evidence, metadata, repository, providerResponse, githubMetadata } from './fixtures.ts';
import { textPrefix } from '../src/server/transport.ts';

test('README prefix decoding preserves complete UTF-8 and rejects malformed retained bytes', async () => {
  assert.deepEqual(await textPrefix(new Response(null), 4), { text: '', truncated: false });
  assert.deepEqual(await textPrefix(new Response('text'), 4), { text: 'text', truncated: false });
  assert.deepEqual(await textPrefix(new Response('中🙂文'), 6), { text: '中', truncated: true });
  await assert.rejects(textPrefix(new Response(new Uint8Array([255])), 4));
  await assert.rejects(textPrefix(new Response(new Uint8Array([0xe4])), 4));
});

test('Jev shares a two-request ceiling across callers', async () => {
  let active = 0,
    maximum = 0;
  const judgment = createJudgment({
    key: () => 'test-key',
    fetch: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return Response.json(providerResponse());
    },
  });
  await Promise.all(
    Array.from({ length: 6 }, () => judgment.judge(evidence, new AbortController().signal)),
  );
  assert.equal(maximum, 2);
});
test('unexpected provider model is rejected', () => {
  assert.throws(
    () =>
      interpretResponse(
        { ...providerResponse(), model: 'other/model' },
        buildJevBody(evidence, taxonomy).questions,
      ),
    /模型/,
  );
});
test('empty evidence never reaches the paid dispatch boundary', async () => {
  let calls = 0,
    dispatches = 0;
  const judgment = createJudgment({
    key: () => 'test-key',
    fetch: async () => {
      calls++;
      return Response.json(providerResponse());
    },
  });
  await assert.rejects(
    judgment.judge(
      { ...evidence, description: null, topics: [], readme: { ...evidence.readme, text: ' ' } },
      new AbortController().signal,
      () => {
        dispatches++;
      },
    ),
    /无有效分类证据/,
  );
  assert.equal(calls, 0);
  assert.equal(dispatches, 0);
});
test('GitHub invalid base64 cannot masquerade as an empty README', async () => {
  const github = createGithub({
    token: () => 'test-key',
    fetch: async (url) =>
      String(url).endsWith('/readme')
        ? Response.json({ path: 'README.md', sha: 'abc', encoding: 'base64', content: '%%%' })
        : Response.json(githubMetadata()),
  });
  await assert.rejects(
    github.read(metadata, repository(), null, new AbortController().signal),
    /base64/,
  );
});
for (const repeats of [30000, 60000])
  test(`large README content is truncated within the evidence limit (${repeats} lines)`, async () => {
    const text = '# Large README\n' + '中文🙂\n'.repeat(repeats);
    const github = createGithub({
      token: () => 'test-key',
      fetch: async (url) =>
        String(url).endsWith('/readme')
          ? Response.json({
              path: 'README.md',
              sha: 'large-readme',
              encoding: 'base64',
              content: Buffer.from(text).toString('base64'),
            })
          : Response.json(githubMetadata()),
    });
    const result = await github.read(metadata, repository(), null, new AbortController().signal);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.evidence.readme.truncated, true);
    assert.ok(result.snapshot.evidence.readme.text.length > 0);
    assert.ok(text.startsWith(result.snapshot.evidence.readme.text));
    assert.ok(Buffer.byteLength(JSON.stringify(result.snapshot.evidence)) <= 48 * 1024);
    assert.equal(result.snapshot.evidence.readme.text.includes('\uFFFD'), false);
  });
test('GitHub encoding=none reads the exact README blob and cancels after a UTF-8 prefix', async () => {
  const text = '中文🙂'.repeat(200000),
    bytes = Buffer.from(text),
    sha = 'a'.repeat(40);
  let cancelled = false;
  const paths: string[] = [];
  const github = createGithub({
    token: () => 'test-key',
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/git/blobs/' + sha)) {
        assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github.raw+json');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 49151));
              controller.enqueue(bytes.subarray(49151));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }
      return path.endsWith('/readme')
        ? Response.json({ path: 'README.md', sha, encoding: 'none', content: '' })
        : Response.json(githubMetadata());
    },
  });
  const result = await github.read(metadata, repository(), null, new AbortController().signal);
  assert.ok(result.snapshot);
  const readme = result.snapshot.evidence.readme;
  assert.equal(readme.truncated, true);
  assert.equal(readme.text.includes('\uFFFD'), false);
  assert.ok(readme.text.length > 0 && text.startsWith(readme.text));
  assert.ok(Buffer.byteLength(JSON.stringify(result.snapshot.evidence)) <= 48 * 1024);
  assert.equal(result.snapshot.sha, sha);
  assert.equal(paths.length, 3);
  assert.equal(cancelled, true);
});

test('GitHub uses only metadata and README with conditional 304 and rename identity', async () => {
  const paths: string[] = [];
  const github = createGithub({
    token: () => 'test-key',
    fetch: async (url, init) => {
      paths.push(String(url));
      if (init?.headers && (init.headers as Record<string, string>)['If-None-Match'])
        return new Response(null, { status: 304 });
      return String(url).endsWith('/readme')
        ? Response.json(
            {
              path: 'README.md',
              sha: 'abc',
              encoding: 'base64',
              content: Buffer.from(evidence.readme.text).toString('base64'),
            },
            { headers: { etag: 'readme' } },
          )
        : Response.json(githubMetadata(), { headers: { etag: 'meta' } });
    },
  });
  const first = await github.read(metadata, repository(), null, new AbortController().signal);
  const next = await github.read(
    metadata,
    repository(),
    first.snapshot,
    new AbortController().signal,
  );
  assert.equal(first.snapshot?.hash, next.snapshot?.hash);
  assert.equal(paths.length, 4);
  assert.ok(paths.every((p) => /\/repos\//.test(p)));
});
test('missing README, transport failures and size bounds remain distinct', async () => {
  const github = createGithub({
    token: () => 'test-key',
    fetch: async (url) =>
      String(url).endsWith('/readme')
        ? new Response(null, { status: 404 })
        : Response.json(githubMetadata()),
  });
  assert.equal(
    (await github.read(metadata, repository(), null, new AbortController().signal)).snapshot,
    null,
  );
  let calls = 0;
  const broken = createGithub({
    token: () => 'test-key',
    sleep: async () => {},
    fetch: async () => {
      calls++;
      throw new TypeError('network');
    },
  });
  await assert.rejects(
    broken.read(metadata, repository(), null, new AbortController().signal),
    /重试/,
  );
  assert.equal(calls, 3);
  const trimmed = truncateEvidence({
    ...evidence,
    readme: { ...evidence.readme, text: '中文🙂'.repeat(30000) },
  });
  assert.equal(trimmed.readme.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 48 * 1024);
});
test('paid failures are sent once, missing usage remains unknown and cancellation prevents dispatch', async () => {
  let calls = 0;
  const j = createJudgment({
    key: () => 'test-key',
    fetch: async () => {
      calls++;
      throw new Error('network');
    },
  });
  await assert.rejects(j.judge(evidence, new AbortController().signal), /不会|重试/);
  assert.equal(calls, 1);
  await assert.rejects(j.judge(evidence, AbortSignal.abort()));
  assert.equal(calls, 1);
  const raw = providerResponse();
  assert.equal(
    interpretResponse({ ...raw, usage: undefined }, buildJevBody(evidence, taxonomy).questions)
      .usage.cost,
    null,
  );
});
test('unknown paid failures preserve bounded, redacted network diagnostics', async () => {
  const key = 'private-test-key';
  for (const [name, code] of [
    ['TimeoutError', null],
    ['TypeError', 'ECONNRESET'],
    [key.repeat(30), key.repeat(30)],
  ] as const) {
    const source = new Error('Private provider message ' + key, {
      cause: code === null ? undefined : { code, privateContext: key },
    });
    source.name = name;
    let calls = 0;
    const judgment = createJudgment({
      key: () => key,
      fetch: async () => {
        calls++;
        throw source;
      },
    });
    await assert.rejects(judgment.judge(evidence, new AbortController().signal), (error) => {
      assert.ok(error instanceof JudgmentFailure);
      assert.equal(error.code, 'jev_unknown');
      assert.deepEqual(error.trace.failure, {
        name: name.split(key).join('[已隐藏]').slice(0, 100),
        causeCode: code?.split(key).join('[已隐藏]').slice(0, 100) ?? null,
      });
      assert.equal(error.trace.response, null);
      assert.equal(error.trace.httpStatus, null);
      assert.ok(!JSON.stringify(error.trace).includes(key));
      return true;
    });
    assert.equal(calls, 1);
  }
});
test('authentication, rate limiting, redirects, oversized and malformed provider responses fail distinctly', async () => {
  for (const [status, headers] of [
    [401, {}],
    [429, { 'retry-after': '90' }],
    [301, { location: 'https://example.com/repos/x/y' }],
  ] as const) {
    const github = createGithub({
      token: () => 'test-key',
      sleep: async () => {},
      fetch: async () => new Response(null, { status, headers }),
    });
    await assert.rejects(github.read(metadata, repository(), null, new AbortController().signal));
  }
  let count = 0;
  const retry = createGithub({
    token: () => 'test-key',
    sleep: async () => {},
    fetch: async () => {
      count++;
      return count < 3
        ? new Response(null, { status: 503 })
        : Response.json({ total_count: 0, incomplete_results: false, items: [] });
    },
  });
  assert.equal((await retry.search('skill', 1, new AbortController().signal, () => {})).total, 0);
  assert.equal(count, 3);
  const malformed = createJudgment({ key: () => 'test-key', fetch: async () => new Response('{') });
  await assert.rejects(malformed.judge(evidence, new AbortController().signal), /JSON/);
  const failed = createJudgment({
    key: () => 'test-key',
    fetch: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(failed.judge(evidence, new AbortController().signal), /HTTP 401/);
});
test('queue cancellation does not dispatch or leak its permit', async () => {
  const { limitConcurrency, boundedText, pause } = await import('../src/server/transport.ts');
  const limit = limitConcurrency(1);
  let finish!: () => void;
  const first = limit(
    new AbortController().signal,
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
  );
  const abort = new AbortController(),
    queued = limit(abort.signal, async () => {
      throw new Error('Cancelled work dispatched');
    });
  abort.abort();
  await assert.rejects(queued);
  finish();
  await first;
  assert.equal(await limit(new AbortController().signal, async () => 42), 42);
  await assert.rejects(boundedText(new Response('abcd'), 2), /上限/);
  await assert.rejects(boundedText(new Response(new Uint8Array([255])), 2));
  await pause(1, new AbortController().signal);
  await assert.rejects(pause(100, AbortSignal.abort()));
});
test('repository rename follows one allowlisted redirect and retains the stable numeric identity', async () => {
  const paths: string[] = [];
  const renamed = { ...metadata, full_name: metadata.owner + '/renamed' };
  const github = createGithub({
    token: () => 'test-key',
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/repos/' + metadata.full_name)
        return new Response(null, {
          status: 301,
          headers: { location: 'https://api.github.com/repos/' + renamed.full_name },
        });
      if (path.endsWith('/readme'))
        return Response.json({
          path: 'README.md',
          sha: 'renamed',
          encoding: 'base64',
          content: Buffer.from(evidence.readme.text).toString('base64'),
        });
      return Response.json(githubMetadata(renamed));
    },
  });
  const result = await github.read(metadata, repository(), null, new AbortController().signal);
  assert.equal(result.metadata.id, metadata.id);
  assert.equal(result.metadata.full_name, renamed.full_name);
  assert.equal(paths.length, 3);
});
test('failed paid responses preserve the bounded raw request and response for inspection', async () => {
  const judgment = createJudgment({
    key: () => 'test-key',
    fetch: async () =>
      new Response('{invalid-json', { headers: { 'x-request-id': 'provider-request-1' } }),
  });
  await assert.rejects(judgment.judge(evidence, new AbortController().signal), (error) => {
    if (!(error instanceof Error) || !('trace' in error)) return false;
    const trace = error.trace as {
      request: { questions: Record<string, unknown> };
      response: unknown;
      providerRequestId: string;
    };
    assert.equal(Object.keys(trace.request.questions).length, 16);
    assert.equal(trace.response, '{invalid-json');
    assert.equal(trace.providerRequestId, 'provider-request-1');
    return true;
  });
});

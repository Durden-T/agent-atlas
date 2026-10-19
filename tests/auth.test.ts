import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { githubAuthentication, githubToken } from '../src/server/github.ts';
test('startup authentication detection reads local credentials without testing GitHub hosts', () => {
  const dir = mkdtempSync(tmpdir() + '/atlas-auth-'),
    previous = { ...process.env };
  try {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    process.env.PATH = dir;
    writeFileSync(
      dir + '/gh',
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "' + dir + '/calls"\nprintf "test-token"\n',
      { mode: 0o700 },
    );
    assert.equal(githubAuthentication(), 'gh');
    assert.equal(githubToken(), 'test-token');
    assert.equal(
      readFileSync(dir + '/calls', 'utf8')
        .trim()
        .split('\n').length,
      1,
    );
    assert.ok(
      readFileSync(dir + '/calls', 'utf8')
        .trim()
        .split('\n')
        .every((line) => line === 'auth token --hostname github.com'),
    );
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true });
  }
});

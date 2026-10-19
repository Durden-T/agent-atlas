import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULE_VERSION } from '../src/shared/taxonomy.ts';

const goldPath = `tests/live/gold-${RULE_VERSION.replace('atlas-', '')}-final.json`;

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/validate-live.ts', ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, JEV_OPENROUTER_KEY: '' },
  });
test('live-validation CLI checks pre-annotations offline and rejects altered evidence before paid work', () => {
  const valid = run('--check', '--gold', goldPath);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    valid.stdout.trim(),
    `Validated 20 pre-annotated ${RULE_VERSION} cases offline; no paid calls.`,
  );
  const dir = mkdtempSync(join(tmpdir(), 'atlas-live-check-'));
  try {
    const file = join(dir, 'invalid.json');
    const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
    gold.fixtures[0].evidence.readme.text += ' changed';
    writeFileSync(file, JSON.stringify(gold));
    const invalid = run('--check', '--gold', file);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Evidence identity or hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test('live-validation CLI refuses existing results before reading input or dispatching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-live-replay-'));
  try {
    const output = join(dir, 'results.json');
    writeFileSync(output, 'preserved result');
    const replay = run('--run', '--gold', join(dir, 'missing.json'), '--output', output);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /Results already exist/);
    assert.equal(readFileSync(output, 'utf8'), 'preserved result');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

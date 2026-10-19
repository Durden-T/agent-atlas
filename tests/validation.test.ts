import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { evidenceHash } from '../src/server/github.ts';
import { RULE_VERSION, taxonomy, labelIds } from '../src/shared/taxonomy.ts';
import { evidence, providerResponse } from './fixtures.ts';

test('offline acceptance verifies raw results, rejects excess errors and cannot dilute its denominator', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-validation-'));
  const version = RULE_VERSION.replace('atlas-', '');
  const run = () =>
    spawnSync(process.execPath, ['scripts/validate-results.ts', '--directory', directory], {
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    let index = 0;
    for (const group of ['final', 'regressions', 'former-fresh', 'recent-regressions']) {
      const fixtures = [],
        results = [];
      for (let n = 0; n < (group === 'final' ? 6 : 1); n++) {
        const name = `synthetic/${group}-${index++}`;
        const input = { ...evidence, full_name: name };
        const request = buildJevBody(input, taxonomy);
        const response = { ...providerResponse(labelIds), id: 'test-receipt-' + index };
        if (index === 1)
          response.answers['label.form.tools'] = {
            type: 'choice',
            choice: 'not_supported',
            probabilities: { supported: 0, not_supported: 1 },
            confidence: 1,
          };
        const hash = evidenceHash(input);
        fixtures.push({
          name,
          evidence: input,
          hash,
          sha: 'synthetic-sha',
          relevance: true,
          positive: labelIds,
          negative: [],
          abstain: [],
          boundary: [],
          reason: 'Synthetic validation-policy fixture; no provider call.',
        });
        results.push({
          name,
          hash,
          state: 'complete',
          mismatches: [],
          result: {
            ...interpretResponse(response, request.questions),
            request,
            response,
          },
        });
      }
      writeFileSync(
        join(directory, `gold-${version}-${group}.json`),
        JSON.stringify({
          ruleVersion: RULE_VERSION,
          annotatedBeforeCalls: true,
          preparedAt: '2026-10-01T00:00:00.000Z',
          fixtures,
        }),
      );
      writeFileSync(
        join(directory, `results-${version}-${group}-1.json`),
        JSON.stringify({
          ruleVersion: RULE_VERSION,
          createdAt: '2026-10-01T00:00:01.000Z',
          requests: results.length,
          results,
        }),
      );
    }
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).keys, 135);
    assert.equal(JSON.parse(baseline.stdout).errors, 1);
    const path = join(directory, `results-${version}-final-1.json`);
    const original = readFileSync(path, 'utf8');
    const mutated = JSON.parse(original);
    for (const row of mutated.results) {
      row.result.response.answers['label.form.skills'] = {
        type: 'choice',
        choice: 'not_supported',
        probabilities: { supported: 0, not_supported: 1 },
        confidence: 1,
      };
      row.result = {
        ...interpretResponse(row.result.response, row.result.request.questions),
        request: row.result.request,
        response: row.result.response,
      };
    }
    writeFileSync(path, JSON.stringify(mutated));
    const excessive = run();
    assert.equal(excessive.status, 1);
    assert.equal(JSON.parse(excessive.stdout).errors, 7);
    assert.match(excessive.stderr, /Fixed-label error rate exceeds/);
    const goldPath = join(directory, `gold-${version}-final.json`);
    const originalGold = readFileSync(goldPath, 'utf8');
    const dilutedGold = JSON.parse(originalGold);
    dilutedGold.fixtures[0].positive.push(...Array(400).fill('purpose.learning'));
    writeFileSync(goldPath, JSON.stringify(dilutedGold));
    const diluted = run();
    assert.equal(diluted.status, 1);
    assert.match(diluted.stderr, /Conflicting or duplicate annotations/);
    writeFileSync(goldPath, originalGold);
    writeFileSync(path, original);
    const duplicateGoldPath = join(directory, `gold-${version}-former-fresh.json`);
    const duplicateResultsPath = join(directory, `results-${version}-former-fresh-1.json`);
    const originalOtherGold = readFileSync(duplicateGoldPath, 'utf8');
    const originalOtherResults = readFileSync(duplicateResultsPath, 'utf8');
    const duplicateGold = JSON.parse(originalOtherGold);
    const duplicateResults = JSON.parse(originalOtherResults);
    const correctGold = JSON.parse(
      readFileSync(join(directory, `gold-${version}-regressions.json`), 'utf8'),
    );
    const correctResults = JSON.parse(
      readFileSync(join(directory, `results-${version}-regressions-1.json`), 'utf8'),
    );
    duplicateGold.fixtures[0] = correctGold.fixtures[0];
    duplicateResults.results[0] = correctResults.results[0];
    duplicateResults.results[0].result.response.id = 'test-distinct-duplicate-repo-receipt';
    writeFileSync(duplicateGoldPath, JSON.stringify(duplicateGold));
    writeFileSync(duplicateResultsPath, JSON.stringify(duplicateResults));
    const repeatedRepository = run();
    assert.equal(repeatedRepository.status, 1);
    assert.match(repeatedRepository.stderr, /Duplicate fixture repository/);
    writeFileSync(duplicateGoldPath, originalOtherGold);
    writeFileSync(duplicateResultsPath, originalOtherResults);
    const unrelatedGold = JSON.parse(originalOtherGold);
    unrelatedGold.fixtures[0].relevance = false;
    unrelatedGold.fixtures[0].positive = [];
    unrelatedGold.fixtures[0].negative = labelIds;
    const unrelatedResults = JSON.parse(originalOtherResults);
    const unrelated = unrelatedResults.results[0];
    unrelated.result.response.answers.relevance = { type: 'noul', noul: 0 };
    unrelated.result = {
      ...interpretResponse(unrelated.result.response, unrelated.result.request.questions),
      request: unrelated.result.request,
      response: unrelated.result.response,
    };
    writeFileSync(duplicateGoldPath, JSON.stringify(unrelatedGold));
    writeFileSync(duplicateResultsPath, JSON.stringify(unrelatedResults));
    const scoped = run();
    assert.equal(scoped.status, 0, scoped.stderr);
    const report = JSON.parse(scoped.stdout);
    assert.equal(report.keys, 120);
    assert.equal(report.errors, 1);
    assert.equal(report.unusedLabels.keys, 15);
    assert.equal(report.unusedLabels.errors, 15);
    assert.equal(report.unusedLabels.wrongLabels.length, 15);
    assert.equal(report.statusErrors, 0);
    writeFileSync(duplicateGoldPath, originalOtherGold);
    writeFileSync(duplicateResultsPath, originalOtherResults);
    const wrongStatus = JSON.parse(original);
    const first = wrongStatus.results[0];
    first.result.response.answers.relevance = { type: 'noul', noul: 0 };
    first.result = {
      ...interpretResponse(first.result.response, first.result.request.questions),
      request: first.result.request,
      response: first.result.response,
    };
    writeFileSync(path, JSON.stringify(wrongStatus));
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).statusErrors, 1);
    assert.equal(JSON.parse(rejected.stdout).keys, 135);
    assert.equal(JSON.parse(rejected.stdout).wrongStatuses[0].repository, first.name);
    assert.match(rejected.stderr, /Relevance and collection-state errors/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

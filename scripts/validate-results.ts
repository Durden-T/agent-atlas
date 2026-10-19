import { loadGold } from './gold.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildJevBody } from '../src/server/judgment/request.ts';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { evidenceHash } from '../src/server/github.ts';
import { emptyEvidence } from '../src/shared/repository-rules.ts';
import { taxonomy, RULE_VERSION, RELEVANT_MIN, labelValue } from '../src/shared/taxonomy.ts';

const { values } = parseArgs({
  options: {
    'include-holdout': { type: 'boolean' },
    directory: { type: 'string', default: 'tests/live' },
  },
});
const version = RULE_VERSION.replace('atlas-', '');
const groups = ['final', 'regressions', 'former-fresh', 'recent-regressions'];
if (values['include-holdout']) groups.push('fresh');
const load = (name: string) =>
  JSON.parse(readFileSync(join(values.directory!, name + '.json'), 'utf8'));
const ids = new Set<string>();
const repositories = new Set<string>();
let requests = 0,
  filtered = 0,
  keys = 0,
  errors = 0,
  statusErrors = 0;
let reviewLabels = 0,
  reviewRepositories = 0,
  knownCost = 0,
  unknownCosts = 0;
const summaries = [];
const wrongLabels = [];
const wrongStatuses = [];
const unusedLabels = {
  keys: 0,
  errors: 0,
  reviewLabels: 0,
  wrongLabels: [] as {
    repository: string;
    label: string;
    expected: boolean;
    actual: boolean | null;
  }[],
  abstainMismatches: [] as { repository: string; label: string; actual: boolean }[],
};
for (const group of groups) {
  const gold = loadGold(join(values.directory!, `gold-${version}-${group}.json`), repositories);
  const record = load(`results-${version}-${group}-1`);
  assert.equal(record.ruleVersion, RULE_VERSION);
  assert.ok(Date.parse(gold.preparedAt) <= Date.parse(record.createdAt));
  assert.equal(record.results.length, gold.fixtures.length);
  assert.equal(
    new Set(record.results.map((r: { name: string }) => r.name)).size,
    gold.fixtures.length,
  );
  let groupRequests = 0,
    groupKeys = 0,
    groupErrors = 0,
    groupUnusedKeys = 0,
    groupUnusedErrors = 0,
    groupStatusErrors = 0;
  for (const f of gold.fixtures) {
    const row = record.results.find((r: { name: string }) => r.name === f.name);
    assert.ok(row, f.name);
    assert.equal(row.hash, f.hash);
    assert.equal(evidenceHash(f.evidence), f.hash);
    if (f.disposition === 'filtered') {
      assert.ok(emptyEvidence(f.evidence));
      assert.equal(row.state, 'filtered');
      assert.equal(row.result, undefined);
      filtered++;
      continue;
    }
    assert.equal(row.state, 'complete', f.name);
    const { request, response, ...saved } = row.result;
    assert.deepEqual(request, buildJevBody(f.evidence, taxonomy), f.name);
    const replay = interpretResponse(response, request.questions);
    assert.deepEqual(replay, saved, f.name);
    assert.equal(typeof response.id, 'string');
    assert.ok(!ids.has(response.id), 'Duplicate provider response');
    ids.add(response.id);
    const relevance = replay.decisions.relevance;
    assert.equal(relevance.type, 'noul');
    if (relevance.type !== 'noul') throw new Error('Missing relevance');
    const actualRelevance = relevance.needsReview ? null : relevance.noul >= RELEVANT_MIN;
    const expectedStatus =
      f.relevance === null ? 'review' : f.relevance ? 'collected' : 'unrelated';
    if (actualRelevance !== f.relevance || replay.status !== expectedStatus) {
      statusErrors++;
      groupStatusErrors++;
      wrongStatuses.push({
        repository: f.name,
        expectedRelevance: f.relevance,
        actualRelevance,
        expectedStatus,
        actualStatus: replay.status,
      });
    }
    for (const [labels, expected] of [
      [f.positive, true],
      [f.negative, false],
    ] as const)
      for (const id of labels) {
        const actual = labelValue(replay.decisions['label.' + id]);
        if (f.relevance !== true) {
          unusedLabels.keys++;
          groupUnusedKeys++;
          if (actual !== expected) {
            unusedLabels.errors++;
            groupUnusedErrors++;
            unusedLabels.wrongLabels.push({ repository: f.name, label: id, expected, actual });
          }
          continue;
        }
        keys++;
        groupKeys++;
        if (actual === expected) continue;
        errors++;
        groupErrors++;
        wrongLabels.push({ repository: f.name, label: id, expected, actual });
      }
    for (const id of f.abstain ?? []) {
      const actual = labelValue(replay.decisions['label.' + id]);
      if (f.relevance === true) assert.equal(actual, null);
      else if (actual !== null)
        unusedLabels.abstainMismatches.push({ repository: f.name, label: id, actual });
    }
    const reviews = Object.entries(replay.decisions).filter(
      ([id, d]) => id !== 'relevance' && d.needsReview,
    ).length;
    reviewLabels += reviews;
    if (f.relevance !== true) unusedLabels.reviewLabels += reviews;
    if (replay.status === 'review') reviewRepositories++;
    if (replay.usage.cost === null) unknownCosts++;
    else knownCost += replay.usage.cost;
    requests++;
    groupRequests++;
  }
  assert.equal(record.requests, groupRequests);
  summaries.push({
    group,
    requests: groupRequests,
    keys: groupKeys,
    errors: groupErrors,
    unusedKeys: groupUnusedKeys,
    unusedErrors: groupUnusedErrors,
    statusErrors: groupStatusErrors,
  });
}
assert.ok(keys > 0);
console.log(
  JSON.stringify(
    {
      ruleVersion: RULE_VERSION,
      requests,
      filtered,
      keys,
      errors,
      labelErrorRate: errors / keys,
      labelEvaluationScope: 'preannotated-relevant-repositories',
      unusedLabels: {
        ...unusedLabels,
        labelErrorRate: unusedLabels.keys ? unusedLabels.errors / unusedLabels.keys : null,
      },
      statusErrors,
      reviewLabels,
      reviewRepositories,
      knownCost,
      unknownCosts,
      groups: summaries,
      wrongLabels,
      wrongStatuses,
      externalCalls: 0,
    },
    null,
    2,
  ),
);
assert.equal(statusErrors, 0, 'Relevance and collection-state errors must be zero');
assert.ok(errors / keys <= 0.02, 'Fixed-label error rate exceeds the user-approved 2%');

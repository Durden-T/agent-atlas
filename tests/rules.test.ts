import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { defaults, collectionSettingsSchema } from '../src/shared/contracts.ts';
import {
  skipRefresh,
  thresholdFailure,
  pushedSince,
  compareCandidates,
  emptyEvidence,
} from '../src/shared/repository-rules.ts';
import { taxonomy, RULE_VERSION } from '../src/shared/taxonomy.ts';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import {
  splitSearch,
  queryFor,
  keywords,
  type SearchWork,
} from '../src/server/collection/search.ts';
import { now, metadata, evidence, repository, providerResponse } from './fixtures.ts';

test('configuration validates integer bounds and time ranges', () => {
  assert.deepEqual(collectionSettingsSchema.parse(defaults), defaults);
  for (const value of [-2, 0.5, Infinity, NaN])
    assert.throws(() =>
      collectionSettingsSchema.parse({ ...defaults, refreshIntervalDays: value }),
    );
  for (const field of ['judgmentLimit', 'discoveryRequestLimit']) {
    assert.equal(
      collectionSettingsSchema.parse({ ...defaults, [field]: -1 })[field as keyof typeof defaults],
      -1,
    );
    for (const value of [-2, 0, 1001, 1.5, Infinity, NaN])
      assert.throws(() => collectionSettingsSchema.parse({ ...defaults, [field]: value }));
  }
  assert.throws(() =>
    collectionSettingsSchema.parse({ ...defaults, updatedWithinDays: Number.MAX_SAFE_INTEGER }),
  );
  assert.equal(pushedSince(null, now), null);
  assert.throws(() => pushedSince(Number.MAX_SAFE_INTEGER, now));
});
test('refresh applies only to completed scans and respects exact day boundary', () => {
  for (const state of ['collected', 'review', 'unrelated', 'filtered'])
    assert.equal(skipRefresh(repository({ state }), -1, now), true);
  assert.equal(skipRefresh(repository(), 0, now), false);
  assert.equal(skipRefresh(repository(), 1, now + 86400000 - 1), true);
  assert.equal(skipRefresh(repository(), 1, now + 86400000), false);
  for (const state of ['new', 'pending', 'error', 'unknown'])
    assert.equal(skipRefresh(repository({ state }), -1, now), false);
  assert.equal(skipRefresh(repository({ checkedAt: null }), -1, now), false);
});
test('Star and pushed_at gates are inclusive UTC intervals', () => {
  const meta = { ...metadata, stars: 100, pushed_at: new Date(now - 180 * 86400000).toISOString() };
  assert.equal(thresholdFailure(meta, defaults, now), null);
  assert.match(thresholdFailure({ ...meta, stars: 99 }, defaults, now)!, /Star/);
  assert.match(
    thresholdFailure(
      { ...meta, pushed_at: new Date(now - 180 * 86400000 - 1).toISOString() },
      defaults,
      now,
    )!,
    /时间/,
  );
  assert.match(thresholdFailure({ ...meta, pushed_at: null }, defaults, now)!, /缺少/);
  assert.equal(
    thresholdFailure({ ...meta, pushed_at: null }, { minStars: 0, updatedWithinDays: null }, now),
    null,
  );
  assert.ok(compareCandidates(repository(), repository({ id: metadata.id + 1 })) < 0);
});
test('only blank README plus absent description and empty topics constitutes empty evidence', () => {
  const blank = {
    ...evidence,
    description: null,
    topics: [],
    readme: { ...evidence.readme, text: ' \t\n' },
  };
  assert.equal(emptyEvidence(blank), true);
  assert.equal(emptyEvidence({ ...blank, description: ' \t' }), true);
  assert.equal(emptyEvidence({ ...blank, description: 'Agent utility' }), false);
  assert.equal(emptyEvidence({ ...blank, topics: ['agent'] }), false);
  assert.equal(emptyEvidence({ ...blank, readme: { ...blank.readme, text: '#' } }), false);
});
test('Jev sends one README and 16 independent questions with shared evidence', () => {
  const body = buildJevBody(evidence, taxonomy);
  assert.equal(Object.keys(body.questions).length, 16);
  assert.deepEqual(Object.keys(body.state.repository), [
    'full_name',
    'description',
    'topics',
    'readme',
  ]);
  for (const facet of taxonomy.facets)
    for (const label of facet.labels)
      for (const text of [label.definition, label.exclusion])
        assert.equal(JSON.stringify(body).split(text).length - 1, 1);
});
test('current rules use literal questions with Noul relevance and binary labels', () => {
  const activeSpec = 'docs/comet/changes/agent-resource-discovery/specs/agent-catalog/spec.md';
  const spec = readFileSync(
    existsSync(activeSpec) ? activeSpec : 'docs/comet/specs/agent-catalog/spec.md',
    'utf8',
  );
  const approved = Object.fromEntries(
    spec
      .split('\n')
      .filter((line) => /^\| (form|purpose|capability)\./.test(line))
      .map((line) => {
        const cells = line.split('|').map((cell) => cell.trim());
        return [cells[1], [cells[4], cells[5]]];
      }),
  );
  assert.equal(Object.keys(approved).length, 15);
  for (const path of ['src/server/judgment/request.ts', 'src/server/judgment/examples.ts'])
    assert.ok(spec.includes('```typescript\n' + readFileSync(path, 'utf8').trimEnd() + '\n```'));
  assert.deepEqual(
    Object.fromEntries(
      taxonomy.facets.flatMap((facet) =>
        facet.labels.map((label) => [
          `${facet.id}.${label.id}`,
          [label.definition, label.exclusion],
        ]),
      ),
    ),
    approved,
  );
  const body = buildJevBody(evidence, taxonomy);
  assert.equal(body.state.rules.scope, spec.match(/scope:\s*"([^"]+)"/)?.[1]);
  assert.equal(RULE_VERSION, 'atlas-38');
  assert.equal(body.questions.relevance.type, 'noul');
  assert.deepEqual(Object.keys(body.questions.relevance.criteria ?? {}), ['true', 'false']);
  const tools = body.questions['label.form.tools'];
  assert.ok(tools.type === 'choice');
  assert.match(tools.instructions, /runnable agent-related program/);
  assert.ok(typeof tools.criteria.not_supported !== 'string');
  assert.match(
    tools.criteria.not_supported.definition,
    /documented as belonging to this repository/,
  );
  assert.match(body.questions.relevance.instructions, /curated collection/);
  assert.match(
    body.questions.relevance.instructions,
    /educational or reference materials specifically about AI agents/,
  );
  const catalog = body.questions['label.form.catalogs'];
  assert.ok(catalog.type === 'choice');
  assert.ok(typeof catalog.criteria.supported !== 'string');
  assert.match(catalog.criteria.supported.definition, /curated entries may be external/);
  for (const facet of taxonomy.facets)
    for (const label of facet.labels)
      assert.equal(
        body.questions[`label.${facet.id}.${label.id}`].instructions,
        spec.match(new RegExp(label.displayName + '比较问题：`([^`]+)`'))?.[1],
      );
  for (const [id, question] of Object.entries(body.questions))
    if (id.startsWith('label.'))
      assert.deepEqual(
        Object.keys(question.criteria ?? {}),
        question.type === 'noul' ? ['true', 'false'] : ['supported', 'not_supported'],
      );
});
test('classification applies labels only after confirmed relevance', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  assert.equal(interpretResponse(providerResponse(), questions).status, 'collected');
  const uncertain = providerResponse();
  uncertain.answers.relevance = { type: 'noul', noul: 0.54 };
  assert.equal(interpretResponse(uncertain, questions).status, 'review');
  assert.deepEqual(interpretResponse(uncertain, questions).labels, []);
  assert.equal(interpretResponse(providerResponse([], true), questions).status, 'review');
  assert.deepEqual(interpretResponse(providerResponse(undefined, false), questions).labels, []);
});
test('binary label review is derived from probabilities, including exact boundaries and ties', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  for (const [supported, confirmed] of [
    [0.52, true],
    [0.519, false],
    [0.5, false],
  ] as const) {
    const raw = providerResponse();
    const answer = raw.answers['label.form.tools'];
    assert.ok(answer.type === 'choice');
    answer.probabilities = {
      supported,
      not_supported: 1 - supported,
    };
    const result = interpretResponse(raw, questions);
    assert.equal(result.decisions['label.form.tools'].needsReview, !confirmed);
    assert.equal(result.labels.includes('form.tools'), confirmed);
    assert.equal(result.status, 'collected');
  }
});
test('Noul relevance uses inclusive yes/no boundaries and never fabricates confidence', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  for (const [noul, status] of [
    [0, 'unrelated'],
    [0.2, 'unrelated'],
    [0.201, 'review'],
    [0.799, 'review'],
    [0.8, 'collected'],
    [1, 'collected'],
  ] as const) {
    const raw = providerResponse();
    raw.answers.relevance = { type: 'noul', noul };
    const result = interpretResponse(raw, questions);
    assert.equal(result.status, status);
    assert.deepEqual(result.decisions.relevance, {
      type: 'noul',
      noul,
      needsReview: status === 'review',
    });
  }
});
test('missing answers, wrong choices, unknown candidates and invalid sums fail loudly', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  const missing = providerResponse();
  delete missing.answers.relevance;
  assert.throws(() => interpretResponse(missing, questions));
  const wrong = providerResponse();
  wrong.answers.relevance = {
    type: 'choice',
    choice: 'related',
    confidence: 1,
    probabilities: { related: 1, unrelated: 0 },
  };
  assert.throws(() => interpretResponse(wrong, questions));
  const sum = providerResponse();
  sum.answers.relevance = { type: 'noul', noul: 1.01 };
  assert.throws(() => interpretResponse(sum, questions));
  const bad = providerResponse();
  const badLabel = bad.answers['label.form.tools'];
  assert.ok(badLabel.type === 'choice');
  badLabel.probabilities.extra = 0;
  assert.throws(() => interpretResponse(bad, questions));
  const removed = providerResponse();
  const removedLabel = removed.answers['label.form.tools'];
  assert.ok(removedLabel.type === 'choice');
  removedLabel.choice = 'insufficient_evidence';
  removedLabel.probabilities = { supported: 0, not_supported: 0, insufficient_evidence: 1 };
  assert.throws(() => interpretResponse(removed, questions), /候选/);
});
test('GitHub bounded queries use one qualifier per interval and inclusive end dates', () => {
  const work: SearchWork = {
    kind: 'search',
    bucket: 'test',
    keyword: 'agent',
    page: 1,
    pushedDate: null,
    start: '2008-01-01',
    end: '2009-01-01',
    grain: 'year',
    starMin: 100,
    starMax: 200,
    done: false,
  };
  const q = queryFor(work);
  assert.match(q, /created:2008-01-01\.\.2008-12-31/);
  assert.match(q, /stars:100\.\.200/);
  assert.equal(q.match(/created:/g)?.length, 1);
  assert.equal(q.match(/stars:/g)?.length, 1);
  assert.match(
    queryFor({ ...work, start: '2024-02-01', end: '2024-03-01' }),
    /created:2024-02-01\.\.2024-02-29/,
  );
  assert.match(queryFor({ ...work, start: null, end: '2008-01-01' }), /created:<2008-01-01/);
});
test('search splits years, months, days, Stars and retains early repositories', () => {
  const root: SearchWork = {
    kind: 'search',
    bucket: 'test',
    keyword: 'skill',
    page: 1,
    pushedDate: '2026-04-17',
    start: null,
    end: null,
    grain: 'root',
    starMin: 100,
    starMax: null,
    done: false,
  };
  assert.deepEqual(keywords, ['agent', 'harness', 'skill', 'claude', 'codex']);
  const years = splitSearch(root, 1000, 2026);
  assert.equal(years[0].grain, 'early');
  assert.equal(years.length, 20);
  const months = splitSearch(years[1], 1000, 2026);
  assert.equal(months.length, 12);
  const days = splitSearch(months[1], 1000, 2026);
  assert.equal(days.length, 29);
  const stars = splitSearch(days[0], 1000, 2026);
  assert.equal(stars[0].starMax! + 1, stars[1].starMin);
  assert.equal(splitSearch({ ...days[0], starMax: 100 }, 100, 2026).length, 0);
  assert.match(queryFor(root), /skill in:name,description,readme/);
});

test('the upgraded classifier requests pinned Jev 1.14 with exactly sixteen questions in the same call', () => {
  const body = buildJevBody(evidence, taxonomy);
  assert.equal(body.model, 'typesafe/jev-1.14');
  assert.equal(Object.keys(body.questions).length, 16);
  assert.equal(Object.keys(body.questions).filter((id) => id.startsWith('witness.')).length, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpretResponse } from '../src/server/judgment/index.ts';
import { buildJevBody } from '../src/server/judgment/request.ts';
import {
  taxonomy,
  RULE_VERSION,
  labelIds,
  labelFacetStates,
  labelValue,
} from '../src/shared/taxonomy.ts';
import { evidence, providerResponse } from './fixtures.ts';

test('the complete classification request contains only relevance and fifteen label questions', () => {
  const body = buildJevBody(evidence, taxonomy);
  assert.deepEqual(Object.keys(body.questions), [
    'relevance',
    ...labelIds.map((id) => 'label.' + id),
  ]);
  assert.equal(body.questions.relevance.type, 'noul');
  for (const id of labelIds)
    assert.equal(body.questions['label.' + id].type, id === 'purpose.learning' ? 'noul' : 'choice');
});

test('removed functional answers are rejected rather than used to override a label', () => {
  const raw = providerResponse([]);
  raw.answers['witness.capability.memory.retrieval'] = { type: 'noul', noul: 1 };
  assert.throws(
    () => interpretResponse(raw, buildJevBody(evidence, taxonomy).questions),
    /答案数量或 ID/,
  );
});

test('positive and negative label decisions use the shared thresholds and preserve returned probabilities', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  for (const [choice, probability, expected] of [
    ['supported', 0.519, null],
    ['supported', 0.52, true],
    ['not_supported', 0.519, null],
    ['not_supported', 0.52, false],
  ] as const) {
    const raw = providerResponse([]);
    raw.answers['label.form.catalogs'] = {
      type: 'choice',
      choice,
      confidence: 0.2,
      probabilities:
        choice === 'supported'
          ? { supported: probability, not_supported: 1 - probability }
          : { supported: 1 - probability, not_supported: probability },
    };
    const result = interpretResponse(raw, questions);
    const answer = result.decisions['label.form.catalogs'];
    assert.equal(labelValue(answer), expected);
    assert.equal(result.labels.includes('form.catalogs'), expected === true);
    assert.ok(answer.type === 'choice');
    assert.deepEqual(answer.probabilities, raw.answers['label.form.catalogs'].probabilities);
    assert.equal('assessments' in result, false);
  }
});

test('Noul labels use the shared label boundary, preserve raw probability and obey relevance', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  assert.equal(questions['label.purpose.learning'].type, 'noul');
  for (const [noul, expected, facet] of [
    [0, false, 'none'],
    [0.48, false, 'none'],
    [0.481, null, 'pending'],
    [0.5, null, 'pending'],
    [0.519, null, 'pending'],
    [0.52, true, 'confirmed'],
    [1, true, 'confirmed'],
  ] as const) {
    const raw = providerResponse(['form.skills']);
    raw.answers['label.purpose.learning'] = { type: 'noul', noul };
    const result = interpretResponse(raw, questions);
    const answer = result.decisions['label.purpose.learning'];
    assert.equal(labelValue(answer), expected);
    assert.deepEqual(answer, { type: 'noul', noul, needsReview: expected === null });
    assert.equal(result.labels.includes('purpose.learning'), expected === true);
    assert.equal(labelFacetStates(result.decisions, result.labels, false).purpose, facet);
  }
  const unrelated = providerResponse(['purpose.learning'], false);
  assert.equal(unrelated.answers['label.purpose.learning'].type, 'noul');
  const result = interpretResponse(unrelated, questions);
  assert.equal(labelValue(result.decisions['label.purpose.learning']), true);
  assert.equal(result.status, 'unrelated');
  assert.deepEqual(result.labels, []);
});

test('Noul labels reject invalid probabilities and a former Choice response', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  for (const noul of [-0.01, 1.01, NaN, Infinity]) {
    const raw = providerResponse();
    raw.answers['label.purpose.learning'] = { type: 'noul', noul };
    assert.throws(() => interpretResponse(raw, questions));
  }
  const raw = providerResponse();
  raw.answers['label.purpose.learning'] = {
    type: 'choice',
    choice: 'supported',
    confidence: 1,
    probabilities: { supported: 1, not_supported: 0 },
  };
  assert.throws(() => interpretResponse(raw, questions), /判断类型不匹配/);
});

test('a confirmed negative label stays negative without a separate functional override', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  const raw = providerResponse(['form.skills']);
  const result = interpretResponse(raw, questions);
  assert.deepEqual(result.labels, ['form.skills']);
  assert.equal(labelValue(result.decisions['label.capability.memory']), false);
  assert.equal(labelFacetStates(result.decisions, result.labels, false).capability, 'none');
});

test('uncertain labels remain pending and confirmed labels are withheld until relevance is confirmed', () => {
  const questions = buildJevBody(evidence, taxonomy).questions;
  const raw = providerResponse(['capability.memory']);
  raw.answers['label.capability.memory'] = {
    type: 'choice',
    choice: 'supported',
    confidence: 0,
    probabilities: { supported: 0.5, not_supported: 0.5 },
  };
  const uncertain = interpretResponse(raw, questions);
  assert.equal(labelValue(uncertain.decisions['label.capability.memory']), null);
  assert.equal(labelFacetStates(uncertain.decisions, [], false).capability, 'pending');
  const related = providerResponse(['capability.memory']);
  related.answers.relevance = { type: 'noul', noul: 0.6 };
  const withheld = interpretResponse(related, questions);
  assert.equal(withheld.status, 'review');
  assert.deepEqual(withheld.labels, []);
  assert.equal(labelFacetStates(withheld.decisions, [], false).capability, 'withheld');
});

test('a provider returning the former pinned model is rejected', () => {
  const raw = providerResponse();
  raw.model = 'typesafe/jev-1.13';
  assert.throws(
    () => interpretResponse(raw, buildJevBody(evidence, taxonomy).questions),
    /未配置的模型/,
  );
});

test('the recorded Comet skill probability is accepted independently of historical question types', () => {
  const rows = JSON.parse(readFileSync('tests/live/results-14-final-1.json', 'utf8')).results;
  const row = rows.find((r: { name: string }) => r.name === 'rpamis/comet');
  const body = buildJevBody(row.result.request.state.repository, taxonomy);
  const raw = providerResponse([]);
  raw.answers['label.form.skills'] = row.result.response.answers['label.form.skills'];
  const result = interpretResponse(raw, body.questions);
  assert.equal(result.labels.includes('form.skills'), true);
  assert.equal(Object.keys(result.decisions).length, 16);
});

test('a real historical low-probability answer remains unconfirmed under current code without becoming a new model call', () => {
  const source = readFileSync('tests/live/results-30-former-fresh-1.json', 'utf8');
  const historical = JSON.parse(source).results.find(
    (row: { name: string }) => row.name === 'obra/superpowers',
  ).result;
  const id = 'label.capability.interaction';
  const current = buildJevBody(historical.request.state.repository, taxonomy);
  assert.notDeepEqual(current.questions[id], historical.request.questions[id]);
  const question = current.questions[id];
  assert.ok(question.type === 'choice');
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(question.criteria).map(([key, value]) => {
        assert.ok(typeof value !== 'string');
        return [key, value.definition];
      }),
    ),
    historical.request.questions[id].criteria,
  );
  assert.notDeepEqual(current, historical.request);
  assert.equal(historical.ruleVersion, 'atlas-30');
  assert.deepEqual(historical.response.answers[id], {
    type: 'choice',
    choice: 'supported',
    probabilities: { supported: 0.51, not_supported: 0.49 },
    confidence: 0.02,
  });
  const replay = interpretResponse(historical.response, historical.request.questions);
  assert.equal(replay.decisions[id].needsReview, true);
  assert.equal(labelValue(replay.decisions[id]), null);
  assert.ok(!replay.labels.includes('capability.interaction'));
  assert.equal(replay.status, 'collected');
  assert.equal(historical.decisions[id].needsReview, true);
  assert.equal(historical.status, 'collected');
  assert.equal(readFileSync('tests/live/results-30-former-fresh-1.json', 'utf8'), source);
});

test('unchanged contrastive label questions replay real pilot answers while applicability changes', () => {
  const source = readFileSync('tests/live/jev114-examples37-pilot-1.json', 'utf8');
  const pilot = JSON.parse(source);
  const frozen = JSON.parse(readFileSync('tests/live/frozen-request-38.json', 'utf8'));
  assert.deepEqual(buildJevBody(frozen.request.state.repository, taxonomy), frozen.request);
  assert.equal(pilot.hypothesisVersion, 'atlas-37-pilot');
  assert.equal(pilot.results.length, 8);
  for (const row of pilot.results) {
    assert.equal(row.state, 'complete');
    const actual = buildJevBody(row.request.state.repository, taxonomy);
    const question = actual.questions['label.form.tools'];
    assert.ok(question.type === 'choice');
    assert.equal(typeof question.criteria.supported, 'object');
    assert.deepEqual(actual.questions, row.request.questions);
    assert.notDeepEqual(actual, row.request);
    assert.deepEqual(actual.state.repository, row.request.state.repository);
    assert.deepEqual(actual.state.rules, frozen.request.state.rules);
    const { ruleVersion, ...replay } = interpretResponse(row.response, actual.questions);
    assert.equal(ruleVersion, RULE_VERSION);
    assert.deepEqual(replay, row.interpretation);
  }
  assert.equal(readFileSync('tests/live/jev114-examples37-pilot-1.json', 'utf8'), source);
});

import { loadGold } from './gold.ts';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createJudgment, JudgmentFailure } from '../src/server/judgment/index.ts';
import { type JudgmentResult, type JudgmentTrace } from '../src/shared/contracts.ts';
import { RULE_VERSION, RELEVANT_MIN, labelValue } from '../src/shared/taxonomy.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyEvidence } from '../src/shared/repository-rules.ts';

const { values } = parseArgs({
  options: {
    run: { type: 'boolean' },
    check: { type: 'boolean' },
    gold: {
      type: 'string',
      default: `tests/live/gold-${RULE_VERSION.replace('atlas-', '')}-final.json`,
    },
    output: { type: 'string', default: 'tests/live/results-1.json' },
  },
});
if (Boolean(values.run) === Boolean(values.check))
  throw new Error('Use exactly one of --check (offline) or --run (paid)');
const output = resolve(values.output!);
if (values.run && existsSync(output))
  throw new Error('Results already exist; never replay paid calls or overwrite prior results');
const gold = loadGold(values.gold!);
if (values.check) {
  console.log(
    `Validated ${gold.fixtures.length} pre-annotated ${RULE_VERSION} cases offline; no paid calls.`,
  );
} else {
  if (!process.env.JEV_OPENROUTER_KEY?.trim()) throw new Error('JEV_OPENROUTER_KEY is missing');
  const judge = createJudgment({ key: () => process.env.JEV_OPENROUTER_KEY });
  const results: {
    name: string;
    hash: string;
    state: 'prepared' | 'submitted' | 'complete' | 'filtered' | 'error';
    filterReason?: string;
    result?: JudgmentResult;
    trace?: JudgmentTrace;
    error?: string;
    mismatches: string[];
  }[] = [];
  const record = {
    createdAt: new Date().toISOString(),
    ruleVersion: RULE_VERSION,
    gold: values.gold,
    requests: 0,
    results,
  };
  writeFileSync(output, JSON.stringify(record, null, 2), { flag: 'wx' });
  const persist = () => {
    writeFileSync(output + '.partial', JSON.stringify(record, null, 2));
    renameSync(output + '.partial', output);
  };
  for (const f of gold.fixtures) {
    const row: (typeof results)[number] = {
      name: f.name,
      hash: f.hash,
      state: 'prepared',
      mismatches: [],
    };
    results.push(row);
    if (emptyEvidence(f.evidence)) {
      row.state = 'filtered';
      row.filterReason = '无有效分类证据';
      persist();
      console.log(
        JSON.stringify({
          name: row.name,
          state: row.state,
          filterReason: row.filterReason,
          jevCalled: false,
        }),
      );
      continue;
    }
    persist();
    await delay(15000 + Math.random() * 500);
    try {
      row.result = await judge.judge(f.evidence, new AbortController().signal, (request) => {
        row.state = 'submitted';
        row.trace = { request, response: null, httpStatus: null, providerRequestId: null };
        record.requests++;
        persist();
      });
      row.state = 'complete';
      delete row.trace;
      const relevance = row.result.decisions.relevance;
      if (
        relevance.type !== 'noul' ||
        (f.relevance === null
          ? !relevance.needsReview
          : relevance.noul >= RELEVANT_MIN !== f.relevance || relevance.needsReview)
      )
        row.mismatches.push('relevance: ' + JSON.stringify(relevance));
      for (const [ids, expected] of [
        [f.positive, true],
        [f.negative, false],
      ] as const)
        for (const id of ids) {
          const d = row.result.decisions['label.' + id];
          if (labelValue(d) !== expected) row.mismatches.push(id + ': ' + JSON.stringify(d));
        }
      for (const id of f.abstain)
        if (labelValue(row.result.decisions['label.' + id]) !== null)
          row.mismatches.push(id + ': expected abstention');
      const expectedStatus =
        f.relevance === null ? 'review' : f.relevance ? 'collected' : 'unrelated';
      if (row.result.status !== expectedStatus)
        row.mismatches.push('status: expected ' + expectedStatus + ', got ' + row.result.status);
    } catch (error) {
      row.state = 'error';
      row.error = error instanceof Error ? error.message : 'Unknown error';
      if (error instanceof JudgmentFailure) row.trace = error.trace;
      row.mismatches.push('Call failed');
    }
    persist();
    console.log(
      JSON.stringify({
        name: row.name,
        status: row.result?.status,
        cost: row.result?.usage.cost,
        mismatches: row.mismatches,
        error: row.error,
      }),
    );
    if (row.state === 'error') break;
  }
  if (results.length !== gold.fixtures.length || results.some((r) => r.mismatches.length))
    process.exitCode = 1;
}

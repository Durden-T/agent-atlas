import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { labelSchema } from '../src/shared/contracts.ts';
import { RULE_VERSION } from '../src/shared/taxonomy.ts';
import { evidenceHash } from '../src/server/github.ts';
import { emptyEvidence } from '../src/shared/repository-rules.ts';

const evidenceSchema = z.strictObject({
  full_name: z.string().min(1),
  description: z.string().nullable(),
  topics: z.array(z.string()),
  readme: z.strictObject({ path: z.string().min(1), text: z.string(), truncated: z.boolean() }),
});
const fixtureSchema = z
  .object({
    name: z.string().min(1),
    relevance: z.boolean().nullable(),
    disposition: z.enum(['judged', 'filtered']).default('judged'),
    positive: z.array(labelSchema),
    negative: z.array(labelSchema),
    abstain: z.array(labelSchema).default([]),
    boundary: z.array(labelSchema).default([]),
    reason: z.string().min(1),
    sha: z.string().min(1),
    hash: z.string().min(1),
    evidence: evidenceSchema,
  })
  .passthrough();
const goldSchema = z.object({
  annotatedBeforeCalls: z.literal(true),
  ruleVersion: z.literal(RULE_VERSION),
  preparedAt: z.iso.datetime(),
  fixtures: z.array(fixtureSchema).min(1).max(20),
});
export function loadGold(path: string, repositories = new Set<string>()) {
  const gold = goldSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const f of gold.fixtures) {
    const identity = f.name.toLowerCase();
    if (repositories.has(identity)) throw new Error('Duplicate fixture repository: ' + f.name);
    repositories.add(identity);
    const scored = [...f.positive, ...f.negative, ...f.abstain, ...f.boundary];
    if (new Set(scored).size !== scored.length)
      throw new Error('Conflicting or duplicate annotations: ' + f.name);
    if (f.name !== f.evidence.full_name || f.hash !== evidenceHash(f.evidence))
      throw new Error('Evidence identity or hash mismatch: ' + f.name);
    if (Buffer.byteLength(JSON.stringify(f.evidence)) > 48 * 1024)
      throw new Error('Fixture exceeds application evidence limit: ' + f.name);
    if (emptyEvidence(f.evidence) !== (f.disposition === 'filtered'))
      throw new Error('Empty-evidence disposition conflicts with application policy: ' + f.name);
  }
  return gold;
}

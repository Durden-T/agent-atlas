import { buildJevBody } from '../src/server/judgment/request.ts';
import { taxonomy, MODEL, type LabelId } from '../src/shared/taxonomy.ts';
import type {
  RepositoryEvidence,
  RepositoryMetadata,
  RepositoryRecord,
} from '../src/shared/contracts.ts';

export const now = Date.parse('2026-10-14T08:00:00Z');
export const metadata: RepositoryMetadata = {
  id: 1132001614,
  full_name: 'vercel-labs/agent-browser',
  description: 'Browser automation CLI for AI agents',
  topics: ['agent', 'browser'],
  stars: 43935,
  pushed_at: '2026-10-13T19:52:19Z',
  language: 'TypeScript',
  archived: false,
  owner: 'vercel-labs',
  ownerType: 'Organization',
};
export const evidence: RepositoryEvidence = {
  full_name: metadata.full_name,
  description: metadata.description,
  topics: metadata.topics,
  readme: {
    path: 'README.md',
    text: '# agent-browser\nBrowser automation CLI for AI agents. Fast native Rust CLI.',
    truncated: false,
  },
};
export const repository = (changes: Partial<RepositoryRecord> = {}): RepositoryRecord => ({
  id: metadata.id,
  metadata,
  state: 'collected',
  checkedAt: new Date(now).toISOString(),
  contentAt: new Date(now).toISOString(),
  evidenceId: null,
  judgmentId: null,
  filterReason: null,
  error: null,
  ...changes,
});
export function githubMetadata(meta: RepositoryMetadata = metadata) {
  return {
    id: meta.id,
    full_name: meta.full_name,
    description: meta.description,
    topics: meta.topics,
    private: false,
    stargazers_count: meta.stars,
    pushed_at: meta.pushed_at,
    language: meta.language,
    archived: meta.archived,
    owner: { login: meta.owner, type: meta.ownerType },
  };
}
export function providerResponse(
  selected: LabelId[] = ['form.tools', 'purpose.development', 'capability.interaction'],
  relevant = true,
) {
  const questions = buildJevBody(evidence, taxonomy).questions;
  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul')
        return [
          id,
          {
            type: 'noul' as const,
            noul: Number(id === 'relevance' ? relevant : selected.includes(id.slice(6) as LabelId)),
          },
        ];
      const choice = selected.includes(id.slice(6) as LabelId) ? 'supported' : 'not_supported';
      return [
        id,
        {
          type: 'choice',
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((c) => [c, c === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  ) as Record<
    string,
    | { type: 'noul'; noul: number }
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  >;
  return {
    model: MODEL,
    answers,
    usage: { input_tokens: 100, output_tokens: 20, cost: 0.0000042 },
  };
}

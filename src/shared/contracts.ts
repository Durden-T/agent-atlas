import { z } from 'zod';
import { labelIds, type LabelId, type FacetId, type FacetState } from './taxonomy.ts';

const integer = z.number().int().safe();
const requestLimit = z.union([z.literal(-1), integer.min(1).max(1000)]);
const days = integer
  .positive()
  .nullable()
  .refine(
    (n) => n === null || Math.abs(Date.now() - n * 86400000) <= 8.64e15,
    '更新时间范围超出支持范围',
  );
export const collectionSettingsSchema = z.strictObject({
  minStars: integer.nonnegative(),
  updatedWithinDays: days,
  refreshIntervalDays: integer.min(-1),
  judgmentLimit: requestLimit,
  discoveryRequestLimit: requestLimit,
});
export type CollectionSettings = z.infer<typeof collectionSettingsSchema>;
export const defaults: CollectionSettings = {
  minStars: 100,
  updatedWithinDays: 180,
  refreshIntervalDays: -1,
  judgmentLimit: 100,
  discoveryRequestLimit: 40,
};
export const resourceStates = [
  'all',
  'collected',
  'new',
  'pending',
  'review',
  'unrelated',
  'filtered',
  'error',
  'unknown',
  'ignored',
] as const;
export const labelSchema = z.enum(labelIds as [LabelId, ...LabelId[]]);
export const filterSchema = z.strictObject({
  query: z.string().max(200),
  minStars: integer.nonnegative(),
  updatedWithinDays: days,
  labels: z.array(labelSchema).max(15),
  state: z.enum(resourceStates),
  archived: z.enum(['all', 'active', 'archived']),
  sort: z.enum(['stars', 'updated']),
  folderId: integer.positive().nullable().default(null),
  viewed: z.enum(['all', 'viewed', 'unviewed']).default('all'),
});
export type ResourceFilter = z.infer<typeof filterSchema>;
export const defaultFilter: ResourceFilter = {
  query: '',
  minStars: 100,
  updatedWithinDays: 180,
  labels: [],
  state: 'collected',
  archived: 'all',
  sort: 'stars',
  folderId: null,
  viewed: 'all',
};
export const FOLDER_LIMIT = 100;
const folderName = z.string().trim().min(1).max(80);
export interface Folder {
  id: number;
  name: string;
}
export const folderCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), name: folderName }),
  z.strictObject({ kind: z.literal('rename'), id: integer.positive(), name: folderName }),
  z.strictObject({ kind: z.literal('delete'), id: integer.positive() }),
]);
export type FolderCommand = z.infer<typeof folderCommandSchema>;
export const personalSchema = z
  .strictObject({
    viewed: z.boolean().optional(),
    folderIds: z
      .array(integer.positive())
      .max(FOLDER_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .refine((value) => value.viewed !== undefined || value.folderIds !== undefined);
export type PersonalUpdate = z.infer<typeof personalSchema>;
export const overrideSchema = z.strictObject({
  decision: z.enum(['keep', 'ignore']).nullable(),
  labels: z.array(labelSchema).max(15).nullable(),
});
export type Override = z.infer<typeof overrideSchema>;
export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('collect'), settings: collectionSettingsSchema }),
  z.strictObject({
    kind: z.literal('continue'),
    settings: collectionSettingsSchema,
    retryErrors: z.boolean().default(false),
  }),
  z.strictObject({ kind: z.literal('rejudge'), repositoryId: integer.positive() }),
]);
export type StartCommand = z.infer<typeof commandSchema>;
export interface RepositoryMetadata {
  id: number;
  full_name: string;
  description: string | null;
  topics: string[];
  stars: number;
  pushed_at: string | null;
  language: string | null;
  archived: boolean;
  owner: string;
  ownerType: 'User' | 'Organization';
}
export interface RepositoryEvidence {
  full_name: string;
  description: string | null;
  topics: string[];
  readme: { path: string; text: string; truncated: boolean };
}
export interface EvidenceSnapshot {
  id: string;
  repositoryId: number;
  hash: string;
  evidence: RepositoryEvidence;
  sha: string;
  metadataEtag: string | null;
  readmeEtag: string | null;
  readAt: string;
}
type DecisionCriterion = string | { definition: string; example: string };
export type DecisionQuestion = {
  instructions: string;
} & (
  | { type: 'choice'; criteria: Record<string, DecisionCriterion> }
  | { type: 'noul'; criteria?: { true: DecisionCriterion; false: DecisionCriterion } }
);
export interface ChoiceDecision {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
  probability: number;
  margin: number;
  needsReview: boolean;
}
export interface NoulDecision {
  type: 'noul';
  noul: number;
  needsReview: boolean;
}
export interface JudgmentResult {
  model: string;
  ruleVersion: string;
  status: 'collected' | 'review' | 'unrelated';
  labels: LabelId[];
  decisions: Record<string, ChoiceDecision | NoulDecision>;
  usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null };
  request: unknown;
  response: unknown;
}
export const unknownUsage = { inputTokens: null, outputTokens: null, cost: null } as const;
export interface JudgmentTrace {
  request: unknown;
  response: unknown;
  httpStatus: number | null;
  providerRequestId: string | null;
  failure?: { name: string; causeCode: string | null };
}
export interface RepositoryRecord {
  id: number;
  metadata: RepositoryMetadata;
  state: string;
  checkedAt: string | null;
  contentAt: string | null;
  evidenceId: string | null;
  judgmentId: string | null;
  filterReason: string | null;
  error: string | null;
}
export interface CatalogResource extends RepositoryRecord {
  folders: Folder[];
  viewed: boolean;
  labels: LabelId[];
  facetStates: Record<FacetId, FacetState>;
  effectiveState: string;
  override: Override | null;
}
export interface ResourceDetail extends CatalogResource {
  evidence: EvidenceSnapshot | null;
  judgments: {
    id: string;
    state: string;
    at: string;
    result: JudgmentResult | null;
    error: string | null;
    trace?: JudgmentTrace | null;
  }[];
  sources: Page<{ key: string; label: string; parentId: number | null; discoveredAt: string }>;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export const runStates = [
  'queued',
  'running',
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RunState = (typeof runStates)[number];
export interface RunStats {
  discovered: number;
  updated: number;
  thresholdFiltered: number;
  noReadme: number;
  emptyEvidenceFiltered: number;
  skipped: number;
  cached: number;
  judged: number;
  review: number;
  unrelated: number;
  failed: number;
  requests: number;
  unknownRequests: number;
  pending: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}
export interface RunRecord {
  id: string;
  command: StartCommand & { settings: CollectionSettings };
  status: RunState;
  stage: string;
  startedAt: string;
  endedAt: string | null;
  stats: RunStats;
  errors: string[];
  gaps: string[];
}
export const emptyStats = (): RunStats => ({
  discovered: 0,
  updated: 0,
  thresholdFiltered: 0,
  noReadme: 0,
  emptyEvidenceFiltered: 0,
  skipped: 0,
  cached: 0,
  judged: 0,
  review: 0,
  unrelated: 0,
  failed: 0,
  requests: 0,
  unknownRequests: 0,
  pending: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
});
export const settingsSchema = z.strictObject({
  collection: collectionSettingsSchema,
  view: filterSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
export interface AppStatus {
  databasePath: string;
  jevConfigured: boolean;
  githubAuthentication: 'environment' | 'gh' | 'missing';
  activeRun: RunRecord | null;
}

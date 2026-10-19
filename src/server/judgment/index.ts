import { z } from 'zod';
import type {
  JudgmentResult,
  RepositoryEvidence,
  DecisionQuestion,
  JudgmentTrace,
} from '../../shared/contracts.ts';
import {
  taxonomy,
  RULE_VERSION,
  MODEL,
  RELEVANT_MIN,
  UNRELATED_MAX,
  LABEL_MIN,
  labelIds,
  labelValue,
} from '../../shared/taxonomy.ts';
import { emptyEvidence } from '../../shared/repository-rules.ts';
import { AppError } from '../errors.ts';
import { boundedText, limitConcurrency, type Fetch } from '../transport.ts';
import { buildJevBody } from './request.ts';

const probability = z.number().min(0).max(1);
const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability.optional(),
});
const answerSchema = z.discriminatedUnion('type', [
  choiceSchema,
  z.object({ type: z.literal('noul'), noul: probability }),
]);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});
export function interpretResponse(
  raw: unknown,
  questions: Record<string, DecisionQuestion>,
): Omit<JudgmentResult, 'request' | 'response'> {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('Jev 返回结构、概率或用量非法', 'invalid_jev', 502);
  const response = parsed.data,
    keys = Object.keys(questions);
  if (response.model !== MODEL && !response.model.startsWith(MODEL + '-'))
    throw new AppError('Jev 返回了未配置的模型', 'invalid_jev', 502);
  if (
    Object.keys(response.answers).length !== keys.length ||
    Object.keys(response.answers).some((id) => !questions[id])
  )
    throw new AppError('Jev 答案数量或 ID 不匹配', 'invalid_jev', 502);
  const decisions: JudgmentResult['decisions'] = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!answer) throw new AppError('Jev 缺少判断项：' + id, 'invalid_jev', 502);
    if (answer.type === 'noul' && question.type === 'noul') {
      decisions[id] = {
        ...answer,
        needsReview:
          id === 'relevance'
            ? answer.noul > UNRELATED_MAX && answer.noul < RELEVANT_MIN
            : Math.max(answer.noul, 1 - answer.noul) < LABEL_MIN,
      };
      continue;
    }
    if (answer.type !== 'choice' || question.type !== 'choice')
      throw new AppError('Jev 判断类型不匹配：' + id, 'invalid_jev', 502);
    const candidates = Object.keys(question.criteria),
      probs = answer.probabilities;
    if (
      Object.keys(probs).length !== candidates.length ||
      Object.keys(probs).some((k) => !candidates.includes(k))
    )
      throw new AppError('Jev 候选概率不匹配', 'invalid_jev', 502);
    const ranked = Object.values(probs).sort((a, b) => b - a),
      highest = ranked[0];
    if (
      Math.abs(ranked.reduce((a, b) => a + b, 0) - 1) >
        Math.min(0.05, 0.0051 * candidates.length) ||
      probs[answer.choice] !== highest
    )
      throw new AppError('Jev 概率总和或选择非法', 'invalid_jev', 502);
    const margin = highest - ranked[1];
    decisions[id] = {
      ...answer,
      confidence: answer.confidence ?? null,
      probability: highest,
      margin,
      needsReview: highest < LABEL_MIN,
    };
  }
  const relevance = decisions.relevance;
  if (relevance?.type !== 'noul')
    throw new AppError('Jev 缺少 Noul 相关性判断', 'invalid_jev', 502);
  const labels = labelIds.filter((id) => labelValue(decisions['label.' + id]) === true);
  let status: JudgmentResult['status'] = 'review';
  if (!relevance.needsReview && relevance.noul <= UNRELATED_MAX) status = 'unrelated';
  else if (!relevance.needsReview && labels.length) status = 'collected';
  return {
    model: response.model,
    ruleVersion: RULE_VERSION,
    status,
    labels: relevance.needsReview || status === 'unrelated' ? [] : labels,
    decisions,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      cost: response.usage?.cost ?? null,
    },
  };
}
export class JudgmentFailure extends AppError {
  trace: JudgmentTrace;
  constructor(error: AppError, trace: JudgmentTrace) {
    super(error.message, error.code, error.status);
    this.trace = trace;
  }
}
export function createJudgment(options: { key: () => string | undefined; fetch?: Fetch }) {
  const limited = limitConcurrency(2);
  let rejection = 0;
  return {
    async judge(
      evidence: RepositoryEvidence,
      signal: AbortSignal,
      onDispatch: (request: unknown) => void = () => {},
      onAccountRejection: () => void = () => {},
    ): Promise<JudgmentResult> {
      const generation = rejection,
        key = options.key();
      if (!key?.trim())
        throw new AppError('未配置 JEV_OPENROUTER_KEY，请在服务端环境设置后重启', 'jev_key', 400);
      const redact = (value: string) => value.split(key).join('[已隐藏]');
      if (
        !evidence.readme?.path ||
        typeof evidence.readme.text !== 'string' ||
        typeof evidence.readme.truncated !== 'boolean'
      )
        throw new AppError('缺少可判断的 README 证据');
      if (emptyEvidence(evidence)) throw new AppError('无有效分类证据', 'empty_evidence');
      const request = buildJevBody(evidence, taxonomy),
        body = JSON.stringify(request);
      if (
        Object.keys(request.questions).length !== 1 + labelIds.length ||
        Buffer.byteLength(body) > 256 * 1024
      )
        throw new AppError('Jev 问题数量或请求大小超过限制');
      return limited(signal, async () => {
        const trace: JudgmentTrace = {
          request,
          response: null,
          httpStatus: null,
          providerRequestId: null,
        };
        signal.throwIfAborted();
        if (generation !== rejection)
          throw new AppError('Jev 账户已拒绝请求；请明确重试', 'dispatch_stopped');
        onDispatch(request);
        let httpFailure: AppError | undefined;
        try {
          const response = await (options.fetch ?? globalThis.fetch)(
            'https://openrouter.ai/api/alpha/decisions',
            {
              method: 'POST',
              redirect: 'error',
              headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
              body,
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            },
          );
          trace.httpStatus = response.status;
          if (!response.ok) {
            httpFailure = new AppError(
              `Jev 请求失败：HTTP ${response.status}；本次请求不会自动重试`,
              (
                { 429: 'rate_limit', 401: 'jev_auth', 402: 'jev_payment' } as Record<number, string>
              )[response.status] ?? 'jev_http',
              502,
            );
            if ([401, 402, 429].includes(response.status)) {
              rejection++;
              onAccountRejection();
            }
          }
          const requestId =
            response.headers.get('x-request-id') ?? response.headers.get('request-id');
          trace.providerRequestId = requestId === null ? null : redact(requestId).slice(0, 200);
          const text = redact(await boundedText(response, 2 * 1024 * 1024));
          trace.response = text;
          let raw: unknown;
          try {
            raw = JSON.parse(text);
            trace.response = raw;
          } catch {
            if (response.ok) throw new AppError('Jev 返回非法 JSON', 'invalid_jev', 502);
          }
          if (httpFailure) throw httpFailure;
          return { ...interpretResponse(raw, request.questions), request, response: raw };
        } catch (error) {
          const failure =
            httpFailure ??
            (error instanceof AppError && trace.httpStatus !== null && !signal.aborted
              ? error
              : new AppError(
                  'Jev 请求失败或超时；可能已付费，请明确重新判断后重试',
                  'jev_unknown',
                  502,
                ));
          if (failure !== error) {
            const source = error instanceof Error ? error : null;
            const cause = source?.cause;
            let causeCode: string | null = null;
            if (error instanceof AppError) causeCode = error.code;
            else if (
              cause !== null &&
              typeof cause === 'object' &&
              'code' in cause &&
              typeof cause.code === 'string'
            )
              causeCode = redact(cause.code).slice(0, 100);
            trace.failure = {
              name: redact(source?.name ?? 'UnknownError').slice(0, 100),
              causeCode,
            };
          }
          throw new JudgmentFailure(failure, trace);
        }
      });
    },
  };
}
export type Judgment = ReturnType<typeof createJudgment>;
export const cacheKey = (repositoryId: number, hash: string) =>
  `${repositoryId}:${hash}:${RULE_VERSION}:${MODEL}`;

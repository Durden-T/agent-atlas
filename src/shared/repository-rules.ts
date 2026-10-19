import type {
  CollectionSettings,
  RepositoryMetadata,
  RepositoryRecord,
  RepositoryEvidence,
} from './contracts.ts';

export function emptyEvidence(evidence: RepositoryEvidence): boolean {
  return (
    !evidence.readme.text.trim() && !evidence.description?.trim() && evidence.topics.length === 0
  );
}

export function pushedSince(days: number | null, now: number): number | null {
  if (days === null) return null;
  const cutoff = now - days * 86400000;
  if (!Number.isFinite(cutoff) || Math.abs(cutoff) > 8.64e15)
    throw new Error('更新时间范围超出支持范围');
  return cutoff;
}
export function thresholdFailure(
  meta: RepositoryMetadata,
  settings: Pick<CollectionSettings, 'minStars' | 'updatedWithinDays'>,
  now: number,
): string | null {
  if (meta.stars < settings.minStars) return '低于最小 Star 门槛';
  const cutoff = pushedSince(settings.updatedWithinDays, now);
  if (cutoff === null) return null;
  if (!meta.pushed_at || !Number.isFinite(Date.parse(meta.pushed_at))) return '缺少有效推送时间';
  return Date.parse(meta.pushed_at) < cutoff ? '最近推送时间超出门槛' : null;
}
export function skipRefresh(record: RepositoryRecord, interval: number, now: number): boolean {
  if (!record.checkedAt || !['collected', 'review', 'unrelated', 'filtered'].includes(record.state))
    return false;
  if (interval === -1) return true;
  return interval > 0 && now - Date.parse(record.checkedAt) < interval * 86400000;
}
export function compareCandidates(a: RepositoryRecord, b: RepositoryRecord): number {
  return b.metadata.stars - a.metadata.stars || a.id - b.id;
}
export function remainingRequests(limit: number, used: number): number {
  return limit === -1 ? Infinity : Math.max(0, limit - used);
}

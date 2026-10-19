export async function api<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    ...(input === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `本机接口失败：HTTP ${response.status}`);
  return value as T;
}
export const stateNames: Record<string, string> = {
  all: '全部记录',
  collected: '已收录',
  new: '新发现',
  pending: '待判断',
  review: '待复核',
  unrelated: '模型未收录',
  filtered: '已过滤',
  error: '调用失败',
  unknown: '请求结果未知',
  ignored: '已忽略',
  queued: '排队',
  running: '运行中',
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
export const dateText = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
export const numberText = (value: number | null) =>
  value === null ? '未知' : value.toLocaleString('zh-CN');
import type { ZodError } from 'zod';
export const inputNumber = (value: number | null) =>
  value === null || !Number.isFinite(value) ? '' : value;
export function validationMessage(error: ZodError) {
  const names: Record<string, string> = {
    collection: '收集参数',
    view: '查看条件',
    minStars: '最小 Star（非负安全整数）',
    updatedWithinDays: '最近更新天数（正整数或留空）',
    refreshIntervalDays: '复查间隔（-1、0 或正整数）',
    judgmentLimit: 'Jev 上限（-1 或 1–1000）',
    discoveryRequestLimit: '发现预算（-1 或 1–1000）',
    query: '搜索内容（最多 200 字）',
    labels: '分类标签',
  };
  return error.issues
    .slice(0, 6)
    .map(
      (issue) =>
        issue.path.map((part) => names[String(part)] ?? String(part)).join(' / ') + '：输入无效',
    )
    .join('；');
}

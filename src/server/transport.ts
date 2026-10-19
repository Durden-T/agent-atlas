import { AppError } from './errors.ts';

export type Fetch = typeof globalThis.fetch;
export function limitConcurrency(limit: number) {
  let active = 0;
  const queue: {
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  return async function limited<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (active < limit) active++;
    else
      await new Promise<void>((resolve, reject) => {
        if (queue.length >= 64) {
          reject(new AppError('网络请求队列已满，请等待当前任务结束', 'queue_limit', 429));
          return;
        }
        const entry = {
          resolve,
          reject,
          signal,
          abort: () => {
            queue.splice(queue.indexOf(entry), 1);
            reject(signal.reason);
          },
        };
        queue.push(entry);
        signal.addEventListener('abort', entry.abort, { once: true });
      });
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      const next = queue.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        next.resolve();
      } else active--;
    }
  };
}
export async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AppError('远端响应超过大小上限', 'response_too_large', 502);
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel();
  }
}
export async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const text = await boundedText(response, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('远端返回非法 JSON', 'invalid_response', 502);
  }
}
export async function textPrefix(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '',
    size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      const remaining = limit - size;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      if (value.byteLength > remaining) return { text, truncated: true };
      size += value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
}
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

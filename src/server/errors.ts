export class AppError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'invalid_input', status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}
export function safeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : '未知错误';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏]');
  return message.slice(0, 1000);
}

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestLogContext {
  request_id: string;
  session_id: string;
}

export const requestLogContext = new AsyncLocalStorage<RequestLogContext | undefined>();

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function inputLogFields(input: string | undefined, enabled: boolean, secrets: readonly (string | undefined)[]) {
  if (!input) return {};
  if (!enabled) return { input_chars: input.length };
  let safe = input;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, '[已隐藏]');
  }
  safe = safe
    .replace(/\b(?:https?|feishu):\/\/[^\s<>"'，。；！？]+/gi, '[链接已隐藏]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[已隐藏]');
  return { input_text: safe.slice(0, 1000), input_chars: input.length, input_truncated: safe.length > 1000 };
}

export function logEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  console[level](JSON.stringify({ time: new Date().toISOString(), level, event, ...requestLogContext.getStore(), ...fields }));
}

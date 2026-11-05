import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestLogContext {
  request_id: string;
  session_id: string;
}

export const requestLogContext = new AsyncLocalStorage<RequestLogContext | undefined>();

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function logEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  console[level](JSON.stringify({ time: new Date().toISOString(), level, event, ...requestLogContext.getStore(), ...fields }));
}

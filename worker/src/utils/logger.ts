export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface LogContext {
  correlationId?: string;
  traceId?: string;
  spanId?: string;
  userId?: string;
  requestId?: string;
  [key: string]: any;
}

export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };
  if (level === 'ERROR' || level === 'FATAL') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => log('DEBUG', msg, ctx),
  info: (msg: string, ctx?: LogContext) => log('INFO', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log('WARN', msg, ctx),
  error: (msg: string, ctx?: LogContext) => log('ERROR', msg, ctx),
  fatal: (msg: string, ctx?: LogContext) => log('FATAL', msg, ctx),
};

export function generateTraceContext(): { traceparent: string } {
  const traceId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const spanId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

export function parseTraceContext(header?: string): { traceparent: string } | null {
  if (!header) return null;
  const parts = header.split('-');
  if (parts.length < 4) return null;
  return { traceparent: header };
}

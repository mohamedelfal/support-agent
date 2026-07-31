// worker/src/types.ts
export type Env = {
  DB: D1Database;
  AI: any;
  RATE_LIMITER: DurableObjectNamespace;
  JWT_SECRET: string;
  AI_GATEWAY_ID: string;
};

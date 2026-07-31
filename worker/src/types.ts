// worker/src/types.ts
export type Env = {
  DB: D1Database;
  AI_GATEWAY: any;
  AI: any;
  RATE_LIMITER: DurableObjectNamespace;
  JWT_SECRET: string;
  AI_GATEWAY_ID: string;
};

export type User = {
  id: string;
  email: string;
  created_at: string;
};

export type Ticket = {
  id: string;
  user_id: string;
  subject: string;
  description: string;
  status: 'open' | 'resolved' | 'pending';
  created_at: string;
  updated_at: string;
};

export type ChatLog = {
  id: string;
  user_id: string;
  message: string;
  response: string;
  created_at: string;
};

export type AuditLog = {
  id: string;
  user_id: string;
  action: string;
  object_id: string;
  ip_hash: string;
  created_at: string;
};

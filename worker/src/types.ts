import { z } from 'zod';

export type Environment = 'development' | 'staging' | 'production';

export type Env = {
  ENVIRONMENT: Environment;
  AUTH_MODE: Environment;
  DB: D1Database;
  CACHE_KV: KVNamespace;
  REFRESH_FAMILY: DurableObjectNamespace;
  CIRCUIT_BREAKER: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  AUDIT_QUEUE: Queue<any>;
  AUDIT_CONSUMER: Queue<any>;
  AI_GATEWAY: any;
  AI: any;
  JWT_SECRET_CURRENT: string;
  JWT_SECRET_PREVIOUS: string;
  OTP_SECRET: string;
  ENCRYPTION_KEY: string;
  AI_GATEWAY_ID: string;
  STAGING_MASTER_OTP?: string;
  AUTO_CREATE_USERS?: string;
  LOG_LEVEL?: string;
  SENTRY_DSN?: string;
};

export type User = {
  id: string;
  email: string;
  email_verified: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Ticket = {
  id: string;
  user_id: string;
  subject: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: string | null;
  correlation_id: string;
  created_at: string;
};

export type TokenPayload = {
  sub: string;
  email: string;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  session_id: string;
  family_id: string;
};

export const LoginSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const VerifyOTPSchema = z.object({
  email: z.string().email('Invalid email address'),
  code: z.string().length(6, 'OTP must be 6 digits'),
  challengeId: z.string().optional(),
});

export const RefreshSchema = z.object({
  refreshToken: z.string(),
  familyId: z.string(),
});

export const TicketSchema = z.object({
  subject: z.string().min(3, 'Subject must be at least 3 characters'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
});

export const ChatSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  conversation_id: z.string().optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type VerifyOTPInput = z.infer<typeof VerifyOTPSchema>;
export type RefreshInput = z.infer<typeof RefreshSchema>;
export type TicketInput = z.infer<typeof TicketSchema>;
export type ChatInput = z.infer<typeof ChatSchema>;

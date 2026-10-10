import { z } from 'zod';
export const agentConfig = z.object({
  systemPrompt: z.string().min(1).max(20000),
  greeting: z.string().max(1000).optional(),
  language: z.string().min(2).max(10).default('en'),
  voice: z.object({ provider: z.string().max(40).default('11labs'), voiceId: z.string().max(100) }).optional(),
  model: z.object({ name: z.string().max(100).default('gpt-4o-mini'), temperature: z.number().min(0).max(2).default(0.3), maxTokens: z.number().int().min(50).max(4000).default(500) }).default({}),
  interruptionSensitivity: z.number().min(0).max(1).default(0.5),
  silenceTimeoutSeconds: z.number().int().min(5).max(120).default(20),
  maxCallDurationSeconds: z.number().int().min(30).max(7200).default(900),
  transferRules: z.array(z.object({ phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/), condition: z.string().max(300) })).max(10).default([]),
  extraction: z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/), description: z.string().max(300), type: z.enum(['string', 'number', 'boolean']) })).max(20).default([]),
  retentionDays: z.number().int().min(1).max(3650).optional(),
}).strict();
export const createAgentBody = z.object({ name: z.string().min(1).max(100), config: agentConfig, knowledgeBaseIds: z.array(z.string().max(40)).max(20).default([]), toolIds: z.array(z.string().max(40)).max(30).default([]) });
export const updateAgentBody = z.object({ name: z.string().min(1).max(100).optional(), config: agentConfig.optional(), note: z.string().max(200).optional(), knowledgeBaseIds: z.array(z.string().max(40)).max(20).optional(), toolIds: z.array(z.string().max(40)).max(30).optional() }).strict();
export const agentParams = z.object({ orgId: z.string().max(40), agentId: z.string().max(40) });

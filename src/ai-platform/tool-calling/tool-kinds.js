import { z } from 'zod';
// Built-in tool kinds. Each fixes the argument schema and HTTP method, so the model can never choose
// URLs, methods, SQL or code. `config.url` is set by an authorised org member and SSRF-checked on save AND on every call.
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/);
const iso = z.string().datetime();
export const TOOL_KINDS = {
  customer_lookup: { method: 'GET', idempotent: true, args: z.object({ phone: phone.optional(), email: z.string().email().optional() }).strict().refine((a) => a.phone || a.email, 'phone or email required') },
  order_lookup: { method: 'GET', idempotent: true, args: z.object({ orderId: z.string().regex(/^[\w-]{1,64}$/) }).strict() },
  appointment_availability: { method: 'GET', idempotent: true, args: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), serviceId: z.string().max(64).optional() }).strict() },
  appointment_book: { method: 'POST', idempotent: false, args: z.object({ start: iso, name: z.string().min(1).max(100), phone, serviceId: z.string().max(64).optional() }).strict() },
  lead_create: { method: 'POST', idempotent: false, args: z.object({ name: z.string().min(1).max(100), phone: phone.optional(), email: z.string().email().optional(), notes: z.string().max(1000).optional() }).strict() },
  ticket_create: { method: 'POST', idempotent: false, args: z.object({ subject: z.string().min(1).max(200), description: z.string().max(4000), priority: z.enum(['low', 'normal', 'high']).default('normal') }).strict() },
};
export const toolKindEnum = z.enum(Object.keys(TOOL_KINDS));
// Result must be a plain JSON object of bounded size.
export const toolResultSchema = z.record(z.any());

// JSON-schema (OpenAI/Vapi function format) for each kind, so the model sees exactly the validated shape.
const P = { type: 'string', description: 'E.164 phone number, e.g. +14155550100' };
export const TOOL_JSON_SCHEMAS = {
  customer_lookup: { type: 'object', properties: { phone: P, email: { type: 'string' } }, additionalProperties: false },
  order_lookup: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false },
  appointment_availability: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, serviceId: { type: 'string' } }, required: ['date'], additionalProperties: false },
  appointment_book: { type: 'object', properties: { start: { type: 'string', description: 'ISO-8601 datetime' }, name: { type: 'string' }, phone: P, serviceId: { type: 'string' } }, required: ['start', 'name', 'phone'], additionalProperties: false },
  lead_create: { type: 'object', properties: { name: { type: 'string' }, phone: P, email: { type: 'string' }, notes: { type: 'string' } }, required: ['name'], additionalProperties: false },
  ticket_create: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] } }, required: ['subject', 'description'], additionalProperties: false },
};
export const SEARCH_KNOWLEDGE_TOOL = { name: 'search_knowledge', description: 'Search the company knowledge base for facts needed to answer the caller. Use before answering factual questions.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
export const toFunctionDefs = (tools, { withKnowledge }) => [
  ...tools.map((t) => ({ name: t.name, description: t.description, parameters: TOOL_JSON_SCHEMAS[t.kind] })),
  ...(withKnowledge ? [SEARCH_KNOWLEDGE_TOOL] : []),
];

import { z } from 'zod';
import { prisma } from '../../core/database/prisma.js';
import { safeFetch } from '../../core/security/ssrf.js';
import { encryptJson, decryptJson } from '../../core/security/encryption.js';
import { logger } from '../../core/logging/logger.js';

// Provider registry. Only integrations with a real, documented API are listed; everything else is intentionally absent.
export const PROVIDERS = {
  slack: {
    configSchema: z.object({ webhookUrl: z.string().url().max(300).refine((u) => new URL(u).hostname === 'hooks.slack.com' && u.startsWith('https://hooks.slack.com/services/'), 'Must be a Slack incoming-webhook URL') }).strict(),
    events: ['call.analyzed'],
    format: (type, p) => ({ text: `*Call analyzed* — ${p.analysis?.outcome ?? 'n/a'} · intent: ${p.analysis?.customerIntent ?? 'n/a'}\n${p.analysis?.summary ?? ''}`.slice(0, 2900) }),
    send: (cfg, body) => safeFetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), allowedHosts: ['hooks.slack.com'], timeoutMs: 8000 }),
  },
};

export async function dispatchIntegrations(orgId, eventType, payload) {
  const rows = await prisma.integration.findMany({ where: { orgId, enabled: true } });
  for (const row of rows) {
    const p = PROVIDERS[row.provider];
    if (!p || !p.events.includes(eventType) || !row.credentialsEnc) continue;
    try { const r = await p.send(decryptJson(row.credentialsEnc), p.format(eventType, payload)); if (!r.ok) throw new Error(`status_${r.status}`); }
    catch (err) { logger.warn({ orgId, provider: row.provider, err: err.message }, 'integration delivery failed'); } // best-effort; never fails the job
  }
}
export const saveIntegration = (orgId, provider, config, enabled = true) => prisma.integration.upsert({ where: { orgId_provider: { orgId, provider } }, create: { orgId, provider, enabled, credentialsEnc: encryptJson(config) }, update: { enabled, credentialsEnc: encryptJson(config) } });

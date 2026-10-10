import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { authRouter } from '../saas-platform/auth/auth.routes.js';
import { usersRouter } from '../saas-platform/users/users.routes.js';
import { organizationsRouter } from '../saas-platform/organizations/organizations.routes.js';
import { apiKeysRouter } from '../saas-platform/api-keys/api-keys.routes.js';
import { billingRouter, plansRouter } from '../saas-platform/billing/billing.routes.js';
import { usageRouter } from '../saas-platform/usage-metering/usage.routes.js';
import { analyticsRouter } from '../saas-platform/analytics/analytics.routes.js';
import { notificationsRouter } from '../saas-platform/notifications/notifications.routes.js';
import { agentsRouter } from '../ai-platform/agents/agents.routes.js';
import { callsRouter } from '../ai-platform/calls/calls.routes.js';
import { knowledgeBaseRouter } from '../ai-platform/knowledge-base/knowledge-base.routes.js';
import { toolsRouter } from '../ai-platform/tool-calling/tools.routes.js';
import { recordingsRouter } from '../ai-platform/recording/recording.routes.js';
import { creditsRouter } from '../saas-platform/credits/credits.routes.js';
import { integrationsRouter } from '../saas-platform/integrations/integrations.routes.js';
import { adminRouter } from '../saas-platform/admin/admin.routes.js';
import { phoneNumbersRouter } from '../ai-platform/telephony/phone-numbers.routes.js';
import { conversationRouter } from '../ai-platform/conversation-engine/conversation.routes.js';
import { registerOrgHook } from '../core/middleware/auth.js';
import { apiMeter } from '../saas-platform/usage-metering/api-meter.js';
import { outgoingWebhooksRouter } from '../platform-services/webhooks/outgoing/outgoing.routes.js';
import { vapiWebhookRouter } from '../platform-services/webhooks/voice-provider/vapi.webhook.js';

registerOrgHook(apiMeter); // count + enforce monthly API quota on every tenant-scoped request

// Single source of truth for route mounting; also used by the OpenAPI generator.
const org = '/orgs/:orgId';
export const MOUNTS = [
  ['/auth', authRouter], ['/users', usersRouter], ['/plans', plansRouter], ['/webhooks/vapi', vapiWebhookRouter],
  ['/admin', adminRouter], ['/orgs', organizationsRouter],
  [`${org}/api-keys`, apiKeysRouter], [`${org}/billing`, billingRouter], [`${org}/credits`, creditsRouter], [`${org}/usage`, usageRouter],
  [`${org}/analytics`, analyticsRouter], [`${org}/notifications`, notificationsRouter], [`${org}/integrations`, integrationsRouter],
  [`${org}/phone-numbers`, phoneNumbersRouter], [`${org}/agents`, conversationRouter], [`${org}/agents`, agentsRouter],
  [`${org}/calls`, callsRouter], [`${org}/knowledge-bases`, knowledgeBaseRouter], [`${org}/tools`, toolsRouter],
  [`${org}/recordings`, recordingsRouter], [`${org}/webhook-endpoints`, outgoingWebhooksRouter],
];
export const apiV1Router = Router();
for (const [prefix, router] of MOUNTS) apiV1Router.use(prefix, router);

try { apiV1Router.use('/docs', swaggerUi.serve, swaggerUi.setup(parse(readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8')))); } catch { /* docs optional */ }

import Stripe from 'stripe';
import { env } from '../../../core/config/env.js';
import { fail } from '../../../core/response/respond.js';
import { receiveWebhook } from '../webhook-inbox.js';
import { billingService } from '../../../saas-platform/billing/billing.service.js';

// Mounted with express.raw() in app.js: the signature must be checked against the exact raw bytes.
export async function stripeWebhookHandler(req, res, next) {
  if (!env.STRIPE_WEBHOOK_SECRET) return fail(res, 503, 'PROVIDER_NOT_CONFIGURED', 'Billing webhooks are not configured');
  let event;
  try { event = Stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); }
  catch { return fail(res, 400, 'INVALID_SIGNATURE', 'Invalid webhook signature'); }
  try {
    await receiveWebhook({ source: 'stripe', externalId: event.id, type: event.type, payload: event }, () => billingService.handleStripeEvent(event));
    res.json({ received: true });
  } catch (e) { next(e); }
}

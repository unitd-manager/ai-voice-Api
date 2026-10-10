import Stripe from 'stripe';
import { env } from '../../core/config/env.js';
import { AppError } from '../../core/errors/app-error.js';

let client;
export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Payments are not configured');
  if (!client) {
    const o = env.STRIPE_API_URL ? new URL(env.STRIPE_API_URL) : null; // STRIPE_API_URL is for stripe-mock in tests only
    client = new Stripe(env.STRIPE_SECRET_KEY, o ? { host: o.hostname, port: o.port, protocol: o.protocol.replace(':', '') } : {});
  }
  return client;
}

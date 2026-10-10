import Stripe from 'stripe';
import { env } from '../../core/config/env.js';
import { AppError } from '../../core/errors/app-error.js';
let client;
export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Payments are not configured');
  return (client ??= new Stripe(env.STRIPE_SECRET_KEY));
}

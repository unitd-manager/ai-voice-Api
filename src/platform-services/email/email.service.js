import nodemailer from 'nodemailer';
import { logger } from '../../core/logging/logger.js';
import { env } from '../../core/config/env.js';

let transport;
const getTransport = () => (transport ??= nodemailer.createTransport(env.SMTP_URL));
export const setTransportForTests = (t) => { transport = t; };

// SMTP_URL example: smtps://user:pass@smtp.example.com:465 ; sender via EMAIL_FROM.
// Without SMTP_URL: messages are logged in dev/test, and reported as undelivered in production.
export async function sendEmail({ to, subject, text, html }) {
  if (!env.SMTP_URL && !transport) {
    if (env.NODE_ENV === 'production') logger.error({ to, subject }, 'SMTP_URL not configured; email not sent');
    else logger.info({ to, subject, text }, 'DEV email (not sent)');
    return { delivered: false };
  }
  try {
    await getTransport().sendMail({ from: process.env.EMAIL_FROM ?? 'no-reply@localhost', to, subject, text, html });
    return { delivered: true };
  } catch (err) {
    logger.error({ err: err.message, to, subject }, 'email send failed');
    return { delivered: false };
  }
}

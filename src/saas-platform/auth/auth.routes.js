import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler as h } from '../../core/middleware/async-handler.js';
import { validate } from '../../core/middleware/validate.js';
import { fail } from '../../core/response/respond.js';
import { authController as c } from './auth.controller.js';
import * as v from './auth.validation.js';

// Stricter limiter on credential endpoints (brute-force protection).
const strict = rateLimit({ windowMs: 15 * 60e3, limit: process.env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: true, legacyHeaders: false,
  handler: (_q, res) => fail(res, 429, 'RATE_LIMITED', 'Too many attempts, try again later') });

export const authRouter = Router();
authRouter.post('/register', strict, validate({ body: v.registerBody }), h(c.register));
authRouter.post('/login', strict, validate({ body: v.loginBody }), h(c.login));
authRouter.post('/refresh', validate({ body: v.refreshBody }), h(c.refresh));
authRouter.post('/logout', validate({ body: v.refreshBody }), h(c.logout));
authRouter.post('/verify-email', validate({ body: v.tokenBody }), h(c.verifyEmail));
authRouter.post('/forgot-password', strict, validate({ body: v.forgotBody }), h(c.forgot));
authRouter.post('/reset-password', strict, validate({ body: v.resetBody }), h(c.reset));

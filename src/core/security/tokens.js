import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

export const signAccessToken = (userId) =>
  jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, { expiresIn: '15m', algorithm: 'HS256' });

export function verifyAccessToken(token) {
  try { return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }); }
  catch { throw AppError.unauthorized('Invalid or expired token'); }
}

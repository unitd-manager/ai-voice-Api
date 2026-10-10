import { z } from 'zod';
const password = z.string().min(10).max(128);
export const registerBody = z.object({ email: z.string().email().max(254).transform((s) => s.toLowerCase()), password, name: z.string().min(1).max(100).optional(), organizationName: z.string().min(2).max(100).optional() });
export const loginBody = z.object({ email: z.string().email().transform((s) => s.toLowerCase()), password: z.string().min(1).max(128) });
export const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
export const tokenBody = z.object({ token: z.string().min(20).max(200) });
export const forgotBody = z.object({ email: z.string().email().transform((s) => s.toLowerCase()) });
export const resetBody = z.object({ token: z.string().min(20).max(200), password });

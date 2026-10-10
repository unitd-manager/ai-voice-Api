import { authService } from './auth.service.js';
import { ok, created } from '../../core/response/respond.js';
const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
export const authController = {
  register: async (req, res) => created(res, await authService.register(req.body, meta(req))),
  login: async (req, res) => ok(res, await authService.login(req.body, meta(req))),
  refresh: async (req, res) => ok(res, await authService.refresh(req.body, meta(req))),
  logout: async (req, res) => { await authService.logout(req.body); ok(res, {}); },
  verifyEmail: async (req, res) => { await authService.verifyEmail(req.body); ok(res, {}); },
  forgot: async (req, res) => { await authService.forgotPassword(req.body); ok(res, { message: 'If the account exists, an email was sent' }); },
  reset: async (req, res) => { await authService.resetPassword(req.body); ok(res, {}); },
};

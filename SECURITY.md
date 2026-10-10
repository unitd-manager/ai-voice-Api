# Security checklist

| Control | Status | Where |
|---|---|---|
| Passwords hashed with bcrypt (cost 12); constant-ish login timing for unknown emails | Implemented, tested | `auth.service.js` |
| Short-lived JWT access tokens (HS256 pinned, `alg=none` rejected) | Implemented, tested | `core/security/tokens.js` |
| Refresh-token rotation with reuse detection (family revocation), hashed at rest | Implemented, tested | `auth.service.js` |
| Reset/verify tokens hashed, single-use, expiring; reset revokes all sessions | Implemented, tested | `auth.service.js` |
| Tenant isolation: access derived from DB membership, never client input; non-members get 404 | Implemented, tested (mocked DB) | `core/middleware/auth.js` |
| RBAC permission matrix, role-escalation checks, last-owner protection | Implemented, partly tested | `permissions.js`, `organizations.service.js` |
| API keys: random, SHA-256 hashed, shown once, org-bound, revocable | Implemented, tested | `api-keys.routes.js` |
| Zod validation on every route; strict schemas reject unknown keys | Implemented | `*.validation.js`, route files |
| Standard error envelope; no stack/DB/provider detail leaks | Implemented, tested | `error-handler.js` |
| Rate limiting (global + strict on credential endpoints) | Implemented | `app.js`, `auth.routes.js` |
| Webhook verification: Vapi secret (timing-safe), Stripe signature on raw body | Implemented, tested | `vapi.adapter.js`, `stripe.webhook.js` |
| Inbound webhook idempotency + durable inbox + reconciliation sweep | Implemented, tested | `webhook-inbox.js`, `workers/maintenance.js` |
| Usage/billing idempotency via unique (orgId, idempotencyKey) | Implemented, tested | `usage.service.js` |
| SSRF: https-only, private-range block, DNS re-checked at connect time, no redirects, size/time caps | Implemented, unit-tested (not against live network) | `core/security/ssrf.js` |
| Tool calling: fixed kinds, strict args, per-agent allow-list, retries only for reads, execution log | Implemented, tested | `tool-calling/` |
| Upload validation: size cap, MIME allow-list, magic-byte check, server-generated storage keys | Implemented, tested | `extract.js`, KB routes |
| Log redaction of auth headers/secrets; PII redaction before LLM | Implemented | `logger.js`, `guardrails.js` |
| Recording access via authenticated, audited, no-store endpoint | Implemented | `recording.routes.js` |
| Retention sweep (recordings/transcripts per org window) | Implemented, untested | `workers/maintenance.js` |
| CSV export formula-injection guard | Implemented | `usage.routes.js` |
| Security headers (helmet), CORS allow-list, `x-powered-by` off | Implemented, tested | `app.js` |
| Graceful shutdown | Implemented | `server.js`, `workers/index.js` |
| Dependency audit in CI (advisory) | Configured | `.github/workflows/ci.yml` |
| Field encryption (AES-256-GCM) for webhook secrets, tool headers, integration credentials | Implemented, tested | `core/security/encryption.js` |
| Atomic webhook claim (no double processing on concurrent redelivery) | Implemented, tested on real MySQL | `webhook-inbox.js` |
| Race-free usage ledger/aggregate, credit consumption, reservation row-locking | Implemented, tested on real MySQL | `usage.service.js`, `credits.service.js`, `reservations.service.js` |
| Platform-admin flag re-read from DB per request; admin actions audited | Implemented, tested | `admin.routes.js` |
| Organization suspension enforced for users and API keys | Implemented, tested | `core/middleware/auth.js` |
| Idempotency-Key for call start / checkout; monthly API quota | Implemented, tested | `idempotency.js`, `api-meter.js` |
| Caller memory keyed by HMAC of the number, PII-redacted, expiring, erasable | Implemented, tested | `memory.service.js` |

## Known gaps (do before production)
- `ENCRYPTION_KEY` has no rotation mechanism (ciphertext is versioned `v1.` to allow it later); losing the key loses the secrets.
- Access tokens cannot be revoked before expiry (15 min); sessions can.
- No account lockout / CAPTCHA beyond IP rate limiting; no MFA. Rate limits are per-process memory (use a Redis store behind multiple instances).
- Provider webhooks authenticate with a shared secret (Vapi) — rotate it periodically; no IP allow-listing.
- `npm audit --omit=dev` reports 6 advisories (3 high, 3 moderate): `deepmerge-ts` (stack exhaustion; reached only through the Prisma **CLI** config loader, not request handling) and `sprintf-js` → `argparse` → `mammoth` (DoS via unbounded precision specifiers; `mammoth` uses it for CLI help, our code only calls `extractRawText`). The suggested `npm audit fix` would downgrade Prisma/mammoth to old majors, so they are accepted for now; re-check on upgrades. Enforce the 10 MB upload cap and run ingestion in the worker (already the case).
- Uploaded documents are not virus-scanned.
- No penetration test or external review has been done.

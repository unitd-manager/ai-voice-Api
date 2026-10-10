import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '../errors/app-error.js';

export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7)); // IPv4-mapped
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
  }
  if (!net.isIPv4(ip)) return true;
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

// Static URL checks (no network): https only, no credentials, no IP-literal private hosts.
export function assertSafeUrlSyntax(raw, { allowedHosts } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw AppError.badRequest('Invalid URL'); }
  if (u.protocol !== 'https:') throw AppError.badRequest('Only https URLs are allowed');
  if (u.username || u.password) throw AppError.badRequest('URL credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw AppError.badRequest('URL host not allowed');
  if (net.isIP(host) && isPrivateIp(host)) throw AppError.badRequest('URL host not allowed');
  if (allowedHosts?.length && !allowedHosts.includes(u.hostname)) throw AppError.badRequest('URL host is not in the allowlist');
  return u;
}

// DNS is re-checked at CONNECT time, closing the DNS-rebinding window between validation and use.
const safeAgent = new Agent({
  connect: {
    lookup(hostname, opts, cb) {
      dns.lookup(hostname, { all: true }).then((addrs) => {
        if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('Blocked address'));
        const first = addrs[0];
        return opts?.all ? cb(null, addrs) : cb(null, first.address, first.family);
      }).catch(cb);
    },
  },
});

export async function safeFetch(url, { timeoutMs = 8000, maxBytes = 64 * 1024, allowedHosts, ...init } = {}) {
  assertSafeUrlSyntax(url, { allowedHosts });
  const res = await undiciFetch(url, { ...init, dispatcher: safeAgent, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const reader = res.body?.getReader(); const chunks = []; let size = 0;
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(value); }
  return { status: res.status, ok: res.ok, text: Buffer.concat(chunks).toString('utf8') };
}

// Binary variant (recordings). Same protections; larger cap; returns a Buffer and the content type.
export async function safeFetchBuffer(url, { timeoutMs = 60000, maxBytes = 100 * 1024 * 1024, allowedHosts, ...init } = {}) {
  assertSafeUrlSyntax(url, { allowedHosts });
  const res = await undiciFetch(url, { ...init, dispatcher: safeAgent, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(value); }
  return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

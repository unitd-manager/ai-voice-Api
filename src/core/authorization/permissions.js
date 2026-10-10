// Role → permission matrix. Authorization is always evaluated against the caller's membership
// in the target organization, never against client-supplied role/org claims.
export const PERMISSIONS = {
  OWNER: ['*'],
  ADMIN: ['org:read', 'org:update', 'members:manage', 'apikeys:manage', 'agents:read', 'agents:write', 'calls:read', 'calls:write',
    'kb:read', 'kb:write', 'tools:read', 'tools:write', 'billing:read', 'billing:manage', 'usage:read', 'analytics:read',
    'audit:read', 'webhooks:manage', 'integrations:manage', 'recordings:read'],
  DEVELOPER: ['org:read', 'apikeys:manage', 'agents:read', 'agents:write', 'calls:read', 'calls:write', 'kb:read', 'kb:write',
    'tools:read', 'tools:write', 'usage:read', 'analytics:read', 'webhooks:manage', 'recordings:read'],
  ANALYST: ['org:read', 'agents:read', 'calls:read', 'kb:read', 'tools:read', 'usage:read', 'analytics:read', 'recordings:read'],
  VIEWER: ['org:read', 'agents:read', 'calls:read', 'kb:read', 'tools:read'],
};
export const can = (role, perm) => {
  const p = PERMISSIONS[role] ?? [];
  return p.includes('*') || p.includes(perm);
};
export const ROLE_RANK = { VIEWER: 1, ANALYST: 2, DEVELOPER: 3, ADMIN: 4, OWNER: 5 };

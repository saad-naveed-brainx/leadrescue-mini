import type { Role } from '@lr/shared';

/**
 * What each tenant role may do. The server enforces this on every route; the web app only uses it
 * to hide buttons. Platform admin is not a role here: it is a separate, audited path.
 */
const ROLE_PERMISSIONS = {
  owner: ['leads:read', 'leads:write', 'leads:delete', 'conversations:mode', 'audit:read'],
  manager: ['leads:read', 'leads:write', 'leads:delete', 'conversations:mode'],
  member: ['leads:read', 'leads:write', 'conversations:mode'],
} as const satisfies Record<Role, readonly string[]>;

export type Permission = (typeof ROLE_PERMISSIONS)[Role][number];

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return (permissionsFor(role) as readonly string[]).includes(permission);
}

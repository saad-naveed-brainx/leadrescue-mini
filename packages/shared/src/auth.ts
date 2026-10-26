export const ROLES = ['owner', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

export interface MeDto {
  user: { id: string; name: string; email: string };
  org: { id: string; name: string };
  role: Role;
  permissions: string[];
}

export interface DevIdentityDto {
  userId: string;
  name: string;
  email: string;
  memberships: { orgId: string; orgName: string; role: Role }[];
}

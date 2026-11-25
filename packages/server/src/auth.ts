import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '@dgi/core';

export interface Principal {
  id: string;
  name: string;
  kind: 'user' | 'service';
  platformAdmin: boolean;
  /** tenantId -> roles. "*" = every tenant (services and platform admins). */
  memberships: Record<string, Role[]>;
}

export interface AccessConfig {
  tenants: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string; platformAdmin?: boolean; memberships: Record<string, Role[]> }>;
  services: Array<{ id: string; name: string; apiKeyEnv: string; devKey?: string; roles: Role[]; tenants: '*' | string[] }>;
}

export const loadAccess = (file: string): AccessConfig => JSON.parse(readFileSync(file, 'utf8'));

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}

/** Roles a principal holds in a tenant. Platform admins hold admin everywhere. */
export function rolesIn(p: Principal, tenantId: string): Role[] {
  const r = [...(p.memberships[tenantId] ?? []), ...(p.memberships['*'] ?? [])];
  if (p.platformAdmin) r.push('admin');
  return [...new Set(r)];
}

/** Client segregation check: throws unless the principal belongs to the tenant. */
export function requireTenant(p: Principal, tenantId: string): Role[] {
  const roles = rolesIn(p, tenantId);
  if (!roles.length) throw new AuthError(`No access to client "${tenantId}"`, 403);
  return roles;
}

export interface Authenticator {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal>;
}

const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k];
  return Array.isArray(v) ? v[0] : v;
};

function safeEq(a: string, b: string) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function serviceFromKey(access: AccessConfig, key: string, allowDevKeys: boolean): Principal | null {
  for (const s of access.services) {
    const expected = process.env[s.apiKeyEnv] || (allowDevKeys ? s.devKey : undefined);
    if (expected && safeEq(key, expected)) {
      const memberships: Record<string, Role[]> = s.tenants === '*' ? { '*': s.roles } : Object.fromEntries(s.tenants.map((t) => [t, s.roles]));
      return { id: s.id, name: s.name, kind: 'service', platformAdmin: false, memberships };
    }
  }
  return null;
}

function userPrincipal(access: AccessConfig, id: string, fallbackName?: string, extraAdmin = false): Principal {
  const u = access.users.find((x) => x.id.toLowerCase() === id.toLowerCase());
  return {
    id: u?.id ?? id,
    name: u?.name ?? fallbackName ?? id,
    kind: 'user',
    platformAdmin: !!u?.platformAdmin || extraAdmin,
    memberships: u?.memberships ?? {},
  };
}

/**
 * Development: pick a user from config/access.json with the `x-dgi-user` header
 * (the UI has a switcher). Never enable in production.
 */
export function devAuthenticator(access: AccessConfig): Authenticator {
  return {
    async authenticate(h) {
      const key = header(h, 'x-dgi-api-key');
      if (key) {
        const svc = serviceFromKey(access, key, true);
        if (!svc) throw new AuthError('Invalid API key');
        return svc;
      }
      const id = header(h, 'x-dgi-user');
      if (!id) throw new AuthError('Set the x-dgi-user header (dev auth)');
      if (!access.users.some((u) => u.id === id)) throw new AuthError(`Unknown dev user "${id}"`);
      return userPrincipal(access, id);
    },
  };
}

/**
 * Production: Microsoft Entra ID bearer tokens, validated against the tenant's
 * JWKS. The token's oid / preferred_username is matched to config/access.json
 * for client memberships; the app role "Studio.Admin" grants platform admin.
 */
export function entraAuthenticator(access: AccessConfig, opts: { tenantId: string; audience: string }): Authenticator {
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`));
  return {
    async authenticate(h) {
      const key = header(h, 'x-dgi-api-key');
      if (key) {
        const svc = serviceFromKey(access, key, false);
        if (!svc) throw new AuthError('Invalid API key');
        return svc;
      }
      const auth = header(h, 'authorization');
      if (!auth?.startsWith('Bearer ')) throw new AuthError('Bearer token required');
      let claims: JWTPayload & { oid?: string; preferred_username?: string; name?: string; roles?: string[] };
      try {
        ({ payload: claims } = await jwtVerify(auth.slice(7), jwks, {
          audience: opts.audience,
          issuer: `https://login.microsoftonline.com/${opts.tenantId}/v2.0`,
        }));
      } catch (e) {
        throw new AuthError(`Invalid token: ${(e as Error).message}`);
      }
      const id = claims.preferred_username ?? claims.oid;
      if (!id) throw new AuthError('Token has no user identity');
      const byOid = claims.oid && access.users.find((u) => u.id === claims.oid);
      return userPrincipal(access, byOid ? claims.oid! : id, claims.name, claims.roles?.includes('Studio.Admin'));
    },
  };
}

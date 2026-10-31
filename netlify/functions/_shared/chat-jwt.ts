import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

// Verifies a Supabase Auth JWT issued by your central login app (project
// YOUR-PROJECT), the canonical Team identity provider. Auth-only
// delegation: we trust WHO the token says the person is; what they can see
// still comes from our own otc.user_roles.
//
// Pinned per the owner's spec: ES256, issuer + JWKS below, audience "authenticated".
// The `sub` claim is the person's chat user id; phone/email map them to our
// employee row.

const ISSUER = `${process.env.CENTRAL_AUTH_URL ?? process.env.SUPABASE_URL ?? 'https://YOUR-PROJECT.supabase.co'}/auth/v1`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const AUDIENCE = 'authenticated';

// Cached across warm invocations; jose refreshes keys on unknown-kid / rotation.
const jwks = createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 30_000 });

export interface ChatClaims {
  sub: string;
  phone: string | null;
  email: string | null;
  raw: JWTPayload;
}

/**
 * Verify a chat-issued JWT. Returns claims on success, or null if the token is
 * not a valid chat token (wrong issuer/aud/alg/signature/expired) — callers
 * then fall back to the legacy path. Only ES256 is accepted.
 */
export async function verifyChatJwt(token: string): Promise<ChatClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['ES256'],
    });
    if (!payload.sub) return null;
    const phone = typeof payload.phone === 'string' && payload.phone ? payload.phone : null;
    const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
    return { sub: payload.sub, phone, email, raw: payload };
  } catch {
    return null;
  }
}

// Last-10-digit normalization — the canonical shared identifier form.
export function last10(raw: string | null | undefined): string {
  const d = (raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

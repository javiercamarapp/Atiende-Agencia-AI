// Token de invitación de staff (Fase 10 — ver `@atiende/db::CoreStaffRepository`
// para el resto del flujo) — mismo patrón EXACTO que
// `domain-rentas/src/owner-portal/invite-token.ts` (token de un solo uso, aleatorio,
// del que solo se persiste el hash), generalizado aquí a `core-auth` porque el
// mecanismo de invitar/dar de alta staff es compartido por las 6 verticales (a
// diferencia del portal de propietario, que es específico de rentas) — ver el
// comentario de diseño en `packages/db/migrations/0002_staff_invite_schema.sql`.
//
// Nunca se guarda el token en texto plano (`core.staff_invite.token_hash` guarda
// solo el hash, igual criterio que un password) — se devuelve UNA vez a quien lo
// genera (la ruta de invitación), nunca se puede recuperar de nuevo después.
import { randomBytes, createHash } from "node:crypto";

export interface GeneratedInviteToken {
  readonly tokenPlain: string;
  readonly tokenHash: string;
}

export function generateInviteToken(): GeneratedInviteToken {
  const tokenPlain = randomBytes(32).toString("base64url");
  return { tokenPlain, tokenHash: hashInviteToken(tokenPlain) };
}

export function hashInviteToken(tokenPlain: string): string {
  return createHash("sha256").update(tokenPlain).digest("hex");
}

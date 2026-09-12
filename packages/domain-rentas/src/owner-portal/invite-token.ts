// Token de invitación/activación del portal de propietario (diseño Fase 3 §5) --
// generación + hash del token de un solo uso que STAFF emite y que el propietario
// consume en `POST /rentas/owner-portal/auth/set-password`. Nunca se guarda el token
// en texto plano (`rentas.owner_credential.password_reset_token_hash` guarda solo el
// hash, igual criterio que un password) -- se devuelve UNA vez a quien lo genera.
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

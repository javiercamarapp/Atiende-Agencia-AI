// Gestion de la cuenta de staff (L-02, paridad de auth): cambio de contrasena, "olvide mi
// contrasena" (solicitar + confirmar) y verificacion de correo (enviar + confirmar). Mismas
// rutas para las 6 verticales (el JWT propio es el unico mecanismo de sesion).
//
// Principios:
//  - Anti-enumeracion: solicitar un reset responde SIEMPRE el mismo 200, exista o no el
//    correo, este configurado o no Resend, o este o no aplicada la migracion (mismo criterio
//    que `auth-magic-link.ts`).
//  - Tokens de un solo uso, solo se persiste su hash (`core.password_reset_token`,
//    `core.email_verification_token`); el correo lleva el token en el ENLACE del frontend
//    (`/<vertical>/restablecer-contrasena?token=`), y el canje es un POST (un escaner de correo
//    que abre el enlace con GET no lo consume).
//  - Cambiar o restablecer la contrasena corta TODAS las sesiones previas
//    (`sessions_revoked_at`, ver la migracion); el cambio autenticado devuelve una sesion
//    nueva para que el dispositivo actual siga dentro.
//  - Un reset NO desactiva el segundo factor (quien roba el correo no se salta el 2FA).
import { Hono, type Context } from "hono";
import { authMiddleware, generateInviteToken, hashInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { botonPildoraHtml, escapeHtml, renderCorreo } from "@atiende/core-email";
import { hashPassword, StaffSecurityUnavailableError, verifyPassword } from "@atiende/db";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import { issueSession } from "./auth.ts";
import { orUnavailable, requireSecurityRepo } from "../second-factor.ts";
import type { AppDeps } from "../deps.ts";

const RESET_TTL_MS = 60 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const SOLICITAR_RATE_LIMIT = { max: 5, windowMs: 5 * 60_000 } as const;
const CANJE_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 } as const;
const VERTICALS = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
type Vertical = (typeof VERTICALS)[number];
const NOMBRE_VERTICAL: Record<Vertical, string> = {
  hoteles: "atiende hoteles",
  restaurantes: "atiende restaurantes",
  rentas: "atiende rentas",
  licitaciones: "atiende licitaciones",
  citas: "atiende citas",
  despachos: "atiende despachos",
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseVertical(v: unknown): Vertical {
  if (typeof v !== "string" || !(VERTICALS as readonly string[]).includes(v)) throw Errors.validation("vertical inválida o ausente.");
  return v as Vertical;
}

function parseNewPassword(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length < 8) throw Errors.validation(`${field}: mínimo 8 caracteres.`);
  if (v.length > 200) throw Errors.validation(`${field}: máximo 200 caracteres.`);
  return v;
}

/** Resend por fetch directo (sin SDK, mismo criterio que magic-link). Nunca lanza. */
async function enviarCorreo(
  deps: AppDeps,
  c: Context<CoreAuthHonoEnv>,
  evento: string,
  msg: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  if (!deps.env.resend.apiKey) {
    logEvent(c, "warn", `${evento}_resend_no_configurado`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.env.resend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: deps.env.resend.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) logEvent(c, "error", `${evento}_resend_fallo`, { status: res.status, body: (await res.text().catch(() => "")).slice(0, 300) });
  } catch (err) {
    logEvent(c, "error", `${evento}_resend_error_red`, { message: err instanceof Error ? err.message : String(err) });
  }
}

function enlace(deps: AppDeps, vertical: Vertical, ruta: string, token: string): string {
  const url = new URL(`/${vertical}/${ruta}`, deps.env.appBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export function authAccountRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  /** Cambio de contrasena autenticado: exige la actual; corta las demas sesiones y devuelve una nueva. */
  app.use("/auth/change-password", authMiddleware(deps.env));
  app.post("/auth/change-password", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<{ currentPassword?: unknown; newPassword?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof body.currentPassword !== "string" || body.currentPassword.length === 0) throw Errors.validation("currentPassword requerido.");
    const newPassword = parseNewPassword(body.newPassword, "newPassword");
    if (newPassword === body.currentPassword) throw Errors.validation("La contraseña nueva debe ser distinta de la actual.");

    const userId = c.get("userId");
    const allowed = await rateLimit(`auth:change-password:${requestActor(c.req.raw, userId)}`, CANJE_RATE_LIMIT.max, CANJE_RATE_LIMIT.windowMs, { category: "auth:login" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff || !(await verifyPassword(body.currentPassword, staff.passwordHash))) throw Errors.currentPasswordInvalid();
    const newHash = await hashPassword(newPassword);
    await orUnavailable(() => repo.changePassword(userId, newHash));
    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName), 200);
  });

  /** "Olvide mi contrasena": SIEMPRE el mismo 200 generico (anti-enumeracion). */
  app.post("/auth/password-reset/solicitar", async (c) => {
    const body = await readJsonCapped<{ email?: unknown; vertical?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) throw Errors.validation("email inválido");
    const email = body.email.trim().toLowerCase();
    const vertical = parseVertical(body.vertical);
    const allowed = await rateLimit(`auth:password-reset:${requestActor(c.req.raw, email)}`, SOLICITAR_RATE_LIMIT.max, SOLICITAR_RATE_LIMIT.windowMs, { category: "auth:password-reset" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const staff = await deps.coreRepo.findStaffByEmail(email);
    if (staff && deps.staffSecurityRepo) {
      try {
        const { tokenPlain, tokenHash } = generateInviteToken();
        await deps.staffSecurityRepo.createPasswordResetToken({ staffId: staff.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString() });
        const url = enlace(deps, vertical, "restablecer-contrasena", tokenPlain);
        const nombre = NOMBRE_VERTICAL[vertical];
        await enviarCorreo(deps, c, "password_reset", {
          to: staff.email,
          subject: `Restablece tu contraseña de ${nombre}`,
          html: renderCorreo({
            titulo: "Restablece tu contraseña",
            preheader: "El enlace expira en 1 hora y solo funciona una vez.",
            etiqueta: { texto: "Seguridad de la cuenta", color: "#1D4ED8" },
            parrafosHtml: [
              `Pediste restablecer tu contraseña de <strong>${escapeHtml(nombre)}</strong>. El enlace expira en 1 hora y solo funciona una vez.`,
              botonPildoraHtml(url, "Elegir una contraseña nueva"),
              `Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all;color:#1D4ED8;">${escapeHtml(url)}</span>`,
            ],
            nota: "Si tú no lo pediste, ignora este correo: tu contraseña no cambia mientras no abras el enlace. Al restablecerla se cierran todas tus sesiones.",
            piePorQueLlego: `Recibes este correo porque alguien pidió restablecer la contraseña de ${nombre} para ${staff.email}.`,
          }),
          text: `Restablece tu contraseña de ${nombre} (expira en 1 hora, un solo uso):\n${url}\n\nSi tú no lo pediste, ignora este correo.`,
        });
      } catch (err) {
        // Migración pendiente o fallo transitorio: igual el 200 genérico (nunca se revela cuál fue).
        logEvent(c, err instanceof StaffSecurityUnavailableError ? "warn" : "error", "password_reset_no_emitido", { message: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({ ok: true }, 200);
  });

  /** Canje del enlace: fija la contrasena nueva, corta todas las sesiones. No inicia sesion. */
  app.post("/auth/password-reset/confirmar", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<{ token?: unknown; newPassword?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 200) throw Errors.validation("token requerido");
    const newPassword = parseNewPassword(body.newPassword, "newPassword");
    const allowed = await rateLimit(`auth:password-reset-confirm:${requestActor(c.req.raw, body.token)}`, CANJE_RATE_LIMIT.max, CANJE_RATE_LIMIT.windowMs, { category: "auth:token-issue" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const passwordHash = await hashPassword(newPassword);
    const staffId = await orUnavailable(() => repo.consumePasswordResetToken(hashInviteToken(body.token as string), passwordHash));
    if (!staffId) throw Errors.validation("El enlace es inválido, ya se usó o expiró. Pide uno nuevo desde «Olvidé mi contraseña».");
    return c.json({ ok: true }, 200);
  });

  /** Reenvia el correo de verificacion al propio usuario autenticado. */
  app.use("/auth/email-verification/enviar", authMiddleware(deps.env));
  app.post("/auth/email-verification/enviar", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<{ vertical?: unknown }>(c.req.raw, 1024);
    const vertical = parseVertical(body.vertical ?? c.get("vertical"));
    const userId = c.get("userId");
    const allowed = await rateLimit(`auth:email-verification:${requestActor(c.req.raw, userId)}`, SOLICITAR_RATE_LIMIT.max, SOLICITAR_RATE_LIMIT.windowMs, { category: "auth:password-reset" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff) throw Errors.unauthorized();
    if (staff.emailVerifiedAt) return c.json({ ok: true, alreadyVerified: true }, 200);

    const { tokenPlain, tokenHash } = generateInviteToken();
    await orUnavailable(() => repo.createEmailVerificationToken({ staffId: staff.id, tokenHash, expiresAt: new Date(Date.now() + VERIFY_TTL_MS).toISOString() }));
    const url = enlace(deps, vertical, "verificar-correo", tokenPlain);
    const nombre = NOMBRE_VERTICAL[vertical];
    await enviarCorreo(deps, c, "email_verification", {
      to: staff.email,
      subject: `Confirma tu correo en ${nombre}`,
      html: renderCorreo({
        titulo: "Confirma tu correo",
        preheader: "El enlace expira en 24 horas.",
        etiqueta: { texto: "Verificación de correo", color: "#1D4ED8" },
        parrafosHtml: [
          `Confirma que <strong>${escapeHtml(staff.email)}</strong> es tu correo en <strong>${escapeHtml(nombre)}</strong>. El enlace expira en 24 horas y solo funciona una vez.`,
          botonPildoraHtml(url, "Confirmar mi correo"),
          `Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all;color:#1D4ED8;">${escapeHtml(url)}</span>`,
        ],
        nota: "Si no reconoces esta cuenta, ignora este correo.",
        piePorQueLlego: `Recibes este correo porque se pidió verificar ${staff.email} en ${nombre}.`,
      }),
      text: `Confirma tu correo en ${nombre} (expira en 24 horas, un solo uso):\n${url}`,
    });
    return c.json({ ok: true, alreadyVerified: false }, 200);
  });

  /** Canje del enlace de verificacion (POST, para que un escaner de correo no lo consuma). */
  app.post("/auth/email-verification/confirmar", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<{ token?: unknown }>(c.req.raw, 1024);
    if (typeof body.token !== "string" || body.token.length === 0 || body.token.length > 200) throw Errors.validation("token requerido");
    const allowed = await rateLimit(`auth:email-verification-confirm:${requestActor(c.req.raw, body.token)}`, CANJE_RATE_LIMIT.max, CANJE_RATE_LIMIT.windowMs, { category: "auth:token-issue" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    const staffId = await orUnavailable(() => repo.consumeEmailVerificationToken(hashInviteToken(body.token as string)));
    if (!staffId) throw Errors.validation("El enlace es inválido, ya se usó o expiró. Pide uno nuevo desde Seguridad de tu cuenta.");
    return c.json({ ok: true }, 200);
  });

  return app;
}

// "Continuar con correo" sin contraseña — las 6 verticales comparten esta ruta
// (mismo criterio que `routes/auth.ts`/`routes/auth-google.ts`: el JWT propio es
// el único mecanismo de sesión real). Dos rutas:
//   - POST /auth/magic-link/iniciar  -- genera un token de un solo uso (mismo
//     mecanismo que `core.staff_invite`, ver la migración), lo envía por correo
//     real (Resend, fetch directo, mismo criterio "sin SDK" que
//     StripeHotelesPaymentsPort) y SIEMPRE responde el mismo 200 genérico,
//     exista o no ese correo (anti-enumeración, mismo criterio que
//     POST /auth/login).
//   - GET /auth/magic-link/verify     -- consume el token atómicamente y emite
//     la MISMA sesión que /auth/login (issueSession). Redirige al mismo puente
//     de frontend que ya usa Google (`/:vertical/auth/google/callback`,
//     ver `shell/GoogleCallback.tsx`) -- ese puente es genérico (solo lee
//     token/refreshToken de la query y resuelve /auth/me), no le importa qué
//     proveedor emitió la sesión.
//
// Sin RESEND_API_KEY configurada (`deps.env.resend.apiKey === null`), el correo
// simplemente no sale -- la ruta IGUAL responde el 200 genérico (nunca revela
// si el fallo fue "no existe el correo" o "Resend no está configurado", mismo
// criterio anti-enumeración) pero lo registra como error de servidor.
import { Hono, type Context } from "hono";
import { generateInviteToken, hashInviteToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { botonPildoraHtml, escapeHtml, renderCorreo } from "@atiende/core-email";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import { issueSession } from "./auth.ts";
import type { AppDeps } from "../deps.ts";

const MAGIC_LINK_TTL_MS = 15 * 60_000;
const MAGIC_LINK_RATE_LIMIT = { max: 5, windowMs: 5 * 60_000 } as const;
const VERTICALS = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
type Vertical = (typeof VERTICALS)[number];
function isVertical(v: unknown): v is Vertical {
  return typeof v === "string" && (VERTICALS as readonly string[]).includes(v);
}

const NOMBRE_VERTICAL: Record<Vertical, string> = {
  hoteles: "atiende hoteles",
  restaurantes: "atiende restaurantes",
  rentas: "atiende rentas",
  licitaciones: "atiende licitaciones",
  citas: "atiende citas",
  despachos: "atiende despachos",
};

interface MagicLinkIniciarBody {
  readonly email?: unknown;
  readonly vertical?: unknown;
}

function validateIniciarBody(body: MagicLinkIniciarBody): { email: string; vertical: Vertical } {
  if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    throw Errors.validation("email inválido");
  }
  if (!isVertical(body.vertical)) throw Errors.validation("vertical inválida o ausente.");
  return { email: body.email.trim().toLowerCase(), vertical: body.vertical };
}

/** Envío real por Resend (fetch directo, sin SDK — mismo criterio que
 *  `StripeHotelesPaymentsPort`). Nunca lanza: un fallo de envío se registra y
 *  se trata como "no se pudo entregar" del lado del servidor, la ruta que
 *  llama sigue respondiendo el 200 genérico de todas formas. */
async function enviarCorreoMagicLink(deps: AppDeps, c: Context<CoreAuthHonoEnv>, to: string, verifyUrl: string, vertical: Vertical): Promise<void> {
  if (!deps.env.resend.apiKey) {
    logEvent(c, "warn", "magic_link_resend_no_configurado", { vertical });
    return;
  }
  const nombre = NOMBRE_VERTICAL[vertical];
  const html = renderCorreo({
    titulo: `Tu enlace para entrar a ${nombre}`,
    preheader: "Expira en 15 minutos y solo funciona una vez.",
    etiqueta: { texto: "Acceso sin contraseña", color: "#1D4ED8" },
    parrafosHtml: [
      `Toca el botón para entrar a <strong>${escapeHtml(nombre)}</strong>. El enlace expira en 15 minutos y solo funciona una vez.`,
      botonPildoraHtml(verifyUrl, `Entrar a ${nombre}`),
      `Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all;color:#1D4ED8;">${escapeHtml(verifyUrl)}</span>`,
    ],
    nota: "Si tú no pediste este enlace, ignora este correo — nadie puede entrar a tu cuenta sin darle clic.",
    piePorQueLlego: `Recibes este correo porque pediste un enlace de acceso a ${nombre} con la dirección ${to}.`,
  });
  const text = `Toca este enlace para entrar a ${nombre} (expira en 15 minutos, un solo uso):\n${verifyUrl}\n\nSi tú no pediste este enlace, ignora este correo.`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.env.resend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: deps.env.resend.from,
        to: [to],
        subject: `Tu enlace para entrar a ${nombre}`,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      logEvent(c, "error", "magic_link_resend_fallo", { status: res.status, body: bodyText.slice(0, 300) });
    }
  } catch (err) {
    logEvent(c, "error", "magic_link_resend_error_red", { message: err instanceof Error ? err.message : String(err) });
  }
}

export function authMagicLinkRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.post("/auth/magic-link/iniciar", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as MagicLinkIniciarBody;
    const { email, vertical } = validateIniciarBody(raw);

    // Mismo criterio que POST /auth/login (rubro 2 de auditoría): freno ANTES
    // de tocar la base de datos/Resend, llave IP+correo.
    const allowed = await rateLimit(`auth:magic-link:${requestActor(c.req.raw, email)}`, MAGIC_LINK_RATE_LIMIT.max, MAGIC_LINK_RATE_LIMIT.windowMs, {
      category: "auth:password-reset",
    });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const staff = await deps.coreRepo.findStaffByEmail(email);
    if (staff) {
      const { tokenPlain, tokenHash } = generateInviteToken();
      const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString();
      await deps.coreRepo.createMagicLinkToken({ staffId: staff.id, tokenHash, expiresAt });
      const verifyUrl = new URL(`/auth/magic-link/verify`, deps.env.appBaseUrl);
      verifyUrl.searchParams.set("token", tokenPlain);
      verifyUrl.searchParams.set("vertical", vertical);
      await enviarCorreoMagicLink(deps, c, staff.email, verifyUrl.toString(), vertical);
    }

    // SIEMPRE el mismo 200 genérico, exista o no ese correo — anti-enumeración,
    // mismo criterio que /auth/login (401 idéntico para ambos casos).
    return c.json({ ok: true }, 200);
  });

  app.get("/auth/magic-link/verify", async (c) => {
    const tokenPlain = c.req.query("token");
    const vertical = c.req.query("vertical");
    if (!tokenPlain || !isVertical(vertical)) {
      const url = new URL("/", deps.env.appBaseUrl);
      url.searchParams.set("magic_link_error", "invalido");
      return c.redirect(url.toString(), 302);
    }

    const rateOk = await rateLimit(`auth:magic-link-verify:${requestActor(c.req.raw)}`, MAGIC_LINK_RATE_LIMIT.max * 2, MAGIC_LINK_RATE_LIMIT.windowMs, {
      category: "auth:token-issue",
    });
    if (!rateOk) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");

    const staff = await deps.coreRepo.consumeMagicLinkToken(hashInviteToken(tokenPlain));
    if (!staff) {
      const url = new URL(`/${vertical}/login`, deps.env.appBaseUrl);
      url.searchParams.set("magic_link_error", "invalido_o_expirado");
      return c.redirect(url.toString(), 302);
    }

    const session = await issueSession(deps, staff.id, staff.email);
    const url = new URL(`/${vertical}/auth/google/callback`, deps.env.appBaseUrl);
    url.searchParams.set("token", session.token);
    url.searchParams.set("refreshToken", session.refreshToken);
    return c.redirect(url.toString(), 302);
  });

  return app;
}

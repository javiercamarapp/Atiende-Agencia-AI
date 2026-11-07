// Alta autoservicio de restaurantes (sin superadmin): el dueño se registra con su correo (enlace de un solo uso) o con Google, y nace
// una organizacion en prueba de 14 dias con su primera sucursal INACTIVA (no recibe pedidos hasta tener menu, horario y cobertura;
// se activa con POST /v1/restaurantes/:orgSlug/admin/alta-sucursal/:propertyId/activar, 0071). Base: 0077_registro_autoservicio_restaurantes.
//
// Rutas (bajo /auth/*: heredan el guard de Origin/Host y el sin-cache de app.ts):
//   - POST /auth/registro/restaurantes/iniciar    PUBLICA. metodo 'correo': guarda la solicitud y manda el enlace; SIEMPRE responde el
//                                                  mismo 202 generico (anti-enumeracion: si el correo ya tiene cuenta, le llega un correo
//                                                  de "ya tienes cuenta" en vez del enlace). metodo 'google': guarda la solicitud y
//                                                  devuelve la URL de Google con el token dentro del `state` firmado.
//   - POST /auth/registro/restaurantes/confirmar  PUBLICA. Canjea el token del correo: crea todo y devuelve un codigo de intercambio de
//                                                  60 s (el mismo puente que magic link y Google: /restaurantes/auth/google/callback).
//                                                  Es POST a proposito: un escaner de enlaces del correo (GET) no puede consumir el token.
//   - Google vuelve por GET /auth/google/callback (auth-google.ts, purpose 'signup') que llama `completarRegistroConGoogle`.
//
// Anti-abuso sin captcha (heuristicas baratas, en capas):
//   1) topes en memoria compartida (core-ratelimit) por IP (5/h) y por IP+correo (3/h) ANTES de validar o tocar la base;
//   2) trampa de bots: el campo oculto `sitioWeb` debe venir vacio y el formulario debe haber tardado >= 3 s en llenarse; si no, se
//      responde el MISMO 202 generico sin crear nada (el bot no aprende que lo detectaron);
//   3) dominios de correo desechable rechazados con mensaje honesto;
//   4) nombres sin enlaces (spam) y con longitud acotada;
//   5) topes en la base (0077): 3 enlaces vigentes por correo, 10 solicitudes y 3 organizaciones por origen en 24 h, 300 por hora en
//      toda la plataforma. El origen es un HMAC de la IP con el secreto del servidor: la IP cruda nunca se guarda.
// La cuenta nace con el correo YA verificado (el enlace o Google lo prueban) y sin contraseña: entra por enlace o Google.
import { createHmac } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  ApiError,
  buildAuthorizationUrl,
  computeCodeChallenge,
  generateCodeVerifier,
  generateInviteToken,
  generateNonce,
  hashInviteToken,
  signOAuthState,
} from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { botonPildoraHtml, escapeHtml, renderCorreo } from "@atiende/core-email";
import { rateLimit } from "@atiende/core-ratelimit";
import { correoConFormaValida, emitirNotificacion, RegistroAutoservicioError, RegistroAutoservicioNoDisponibleError } from "@atiende/db";
import type { RegistroCompletado } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";
import { EXCHANGE_CODE_TTL_MS } from "./auth.ts";
import type { AppDeps } from "../deps.ts";

export const REGISTRO_RESTAURANTES_LIMITES = {
  porIp: { max: 5, windowMs: 60 * 60_000 },
  porCorreo: { max: 3, windowMs: 60 * 60_000 },
  confirmarPorIp: { max: 20, windowMs: 15 * 60_000 },
  /** Minimo de milisegundos entre que se pinta el formulario y se envia (un humano no llena 4 campos en menos). */
  llenadoMinimoMs: 3_000,
  ttlCorreoMin: 30,
  /** El `state` de Google vive 10 min (signOAuthState); la solicitud un poco mas para cubrir el viaje de ida y vuelta. */
  ttlGoogleMin: 15,
} as const;

/** Dominios de correo desechable mas comunes (lista corta y estable; no pretende ser exhaustiva: los topes cubren el resto). */
export const DOMINIOS_DESECHABLES: ReadonlySet<string> = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "sharklasers.com",
  "throwawaymail.com",
  "fakeinbox.com",
  "mintemail.com",
  "emailondeck.com",
  "mohmal.com",
  "tempail.com",
]);

const ENLACE_RE = /(https?:\/\/|www\.|\.(com|net|org|ru|xyz|top)\b)/i;

interface IniciarBody {
  readonly metodo?: unknown;
  readonly correo?: unknown;
  readonly nombreNegocio?: unknown;
  readonly nombreSucursal?: unknown;
  readonly nombreCompleto?: unknown;
  readonly zonaHoraria?: unknown;
  /** Trampa: campo oculto que un humano nunca llena. */
  readonly sitioWeb?: unknown;
  /** Milisegundos que tardo el formulario en llenarse (lo mide el navegador). */
  readonly msLlenado?: unknown;
}

export interface CapturaRegistroValidada {
  readonly metodo: "correo" | "google";
  readonly correo: string | null;
  readonly nombreNegocio: string;
  readonly nombreSucursal: string;
  readonly nombreCompleto: string;
  readonly zonaHoraria: string | null;
}

function texto(v: unknown, campo: string): string {
  if (typeof v !== "string") throw Errors.validation(`${campo} es obligatorio.`);
  const t = v.trim().replace(/\s+/g, " ");
  if (t.length < 2 || t.length > 120) throw Errors.validation(`${campo} debe tener entre 2 y 120 caracteres.`);
  if (ENLACE_RE.test(t)) throw Errors.validation(`${campo} no puede llevar enlaces.`);
  return t;
}

export function validarCapturaRegistro(body: IniciarBody): CapturaRegistroValidada {
  const metodo = body.metodo === "google" ? "google" : body.metodo === "correo" ? "correo" : null;
  if (!metodo) throw Errors.validation("metodo debe ser 'correo' o 'google'.");
  let correo: string | null = null;
  if (metodo === "correo") {
    if (typeof body.correo !== "string" || !correoConFormaValida(body.correo.trim())) throw Errors.validation("Escribe un correo válido.");
    correo = body.correo.trim().toLowerCase();
    const dominio = correo.slice(correo.lastIndexOf("@") + 1);
    if (DOMINIOS_DESECHABLES.has(dominio)) throw Errors.validation("Usa un correo permanente de tu negocio o personal: los correos temporales no se aceptan.");
  }
  let zonaHoraria: string | null = null;
  if (body.zonaHoraria !== undefined && body.zonaHoraria !== null && body.zonaHoraria !== "") {
    if (typeof body.zonaHoraria !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(body.zonaHoraria)) throw Errors.validation("Zona horaria inválida.");
    zonaHoraria = body.zonaHoraria;
  }
  return {
    metodo,
    correo,
    nombreNegocio: texto(body.nombreNegocio, "El nombre del restaurante"),
    nombreSucursal: texto(body.nombreSucursal, "El nombre de la sucursal"),
    nombreCompleto: texto(body.nombreCompleto, "Tu nombre"),
    zonaHoraria,
  };
}

/** true = parece bot (trampa llena o formulario llenado en menos de 3 s). */
export function pareceBot(body: IniciarBody): boolean {
  if (typeof body.sitioWeb === "string" && body.sitioWeb.trim() !== "") return true;
  const ms = typeof body.msLlenado === "number" && Number.isFinite(body.msLlenado) ? body.msLlenado : 0;
  return ms < REGISTRO_RESTAURANTES_LIMITES.llenadoMinimoMs;
}

/** HMAC de la IP con el secreto del servidor: permite topar por origen sin guardar la IP. */
export function origenHash(secreto: string, req: Request): string {
  return createHmac("sha256", secreto).update(`registro-autoservicio:${requestActor(req)}`).digest("hex");
}

function noDisponible() {
  return Errors.serviceUnavailable("El registro de restaurantes no está disponible aún en este despliegue.");
}

function mapearError(err: unknown): never {
  if (err instanceof RegistroAutoservicioNoDisponibleError) throw noDisponible();
  if (err instanceof RegistroAutoservicioError) {
    switch (err.codigo) {
      case "tope":
        throw Errors.tooManyRequests("Demasiados registros. Intenta de nuevo más tarde.");
      case "validation":
        throw Errors.validation("Revisa los datos del registro.");
      case "enlace_invalido":
        throw Errors.notFound("El enlace no es válido o ya venció. Vuelve a registrarte para recibir uno nuevo.");
      case "cuenta_existente":
        throw Errors.conflict("Ya existe una cuenta con ese correo: inicia sesión.");
      case "forbidden":
        throw Errors.forbidden();
    }
  }
  throw err;
}

async function enviarCorreo(deps: AppDeps, c: Context, to: string, subject: string, html: string, text: string): Promise<void> {
  if (!deps.env.resend.apiKey) {
    logEvent(c, "warn", "registro_restaurantes_resend_no_configurado", {});
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.env.resend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: deps.env.resend.from, to: [to], subject, html, text }),
    });
    if (!res.ok) logEvent(c, "error", "registro_restaurantes_resend_fallo", { status: res.status });
  } catch (err) {
    logEvent(c, "error", "registro_restaurantes_resend_error_red", { message: err instanceof Error ? err.message : String(err) });
  }
}

function correoEnlaceRegistro(to: string, nombreNegocio: string, url: string): { subject: string; html: string; text: string } {
  const subject = "Confirma tu correo para crear tu restaurante en atiende";
  const html = renderCorreo({
    titulo: "Confirma tu correo y crea tu restaurante",
    preheader: "El enlace expira en 30 minutos y solo funciona una vez.",
    etiqueta: { texto: "Registro", color: "#1D4ED8" },
    parrafosHtml: [
      `Toca el botón para confirmar tu correo y crear <strong>${escapeHtml(nombreNegocio)}</strong> en atiende restaurantes. Empiezas con 14 días de prueba.`,
      botonPildoraHtml(url, "Crear mi restaurante"),
      `Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all;color:#1D4ED8;">${escapeHtml(url)}</span>`,
    ],
    nota: "Si tú no pediste este registro, ignora este correo: no se crea nada sin tu clic.",
    piePorQueLlego: `Recibes este correo porque alguien pidió registrar un restaurante en atiende con la dirección ${to}.`,
  });
  const text = `Confirma tu correo y crea ${nombreNegocio} en atiende restaurantes (expira en 30 minutos, un solo uso):\n${url}\n\nSi tú no pediste este registro, ignora este correo.`;
  return { subject, html, text };
}

function correoYaTienesCuenta(to: string, loginUrl: string): { subject: string; html: string; text: string } {
  const subject = "Ya tienes una cuenta en atiende";
  const html = renderCorreo({
    titulo: "Ya tienes una cuenta en atiende",
    preheader: "Entra con tu correo o con Google.",
    etiqueta: { texto: "Registro", color: "#1D4ED8" },
    parrafosHtml: [
      "Alguien pidió registrar un restaurante con este correo, pero ya tienes una cuenta. Entra con tu correo o con Google:",
      botonPildoraHtml(loginUrl, "Iniciar sesión"),
    ],
    nota: "Si tú no lo pediste, ignora este correo: tu cuenta no cambió.",
    piePorQueLlego: `Recibes este correo porque se intentó registrar la dirección ${to} en atiende restaurantes.`,
  });
  return { subject, html, text: `Ya tienes una cuenta en atiende. Inicia sesión aquí: ${loginUrl}` };
}

/** Emite el codigo de intercambio de 60 s para el puente del navegador (mismo mecanismo que magic link y Google). */
async function codigoDeIntercambio(deps: AppDeps, staffId: string): Promise<string> {
  const { tokenPlain, tokenHash } = generateInviteToken();
  await deps.coreRepo.createAuthExchangeCode({ staffId, codeHash: tokenHash, expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS).toISOString() });
  return tokenPlain;
}

/** Aviso al superadmin (sin PII: solo el slug). Nunca lanza. */
async function avisarSuperadmin(deps: AppDeps, c: Context, registro: RegistroCompletado): Promise<void> {
  try {
    await deps.engine.withAppSession({ userId: null }, (db) =>
      emitirNotificacion(db, {
        evento: "superadmin.alta.registro_autoservicio",
        organizationId: null,
        clave: `registro-autoservicio:${registro.organizationId}`,
        entidadId: registro.organizationId,
        parametros: { organizacion: registro.orgSlug.slice(0, 40) },
      }),
    );
  } catch (err) {
    logEvent(c, "warn", "registro_restaurantes_aviso_superadmin_fallo", { message: err instanceof Error ? err.message : String(err) });
  }
}

async function completar(deps: AppDeps, c: Context, tokenPlain: string, correoVerificado: string | null): Promise<RegistroCompletado> {
  const repo = deps.registroAutoservicioRepo;
  if (!repo) throw noDisponible();
  try {
    const registro = await deps.engine.withAppSession({ userId: null }, (db) => repo(db).completar({ tokenHash: hashInviteToken(tokenPlain), correoVerificado }));
    logEvent(c, "info", "registro_restaurantes_completado", { organizationId: registro.organizationId });
    await avisarSuperadmin(deps, c, registro);
    return registro;
  } catch (err) {
    return mapearError(err);
  }
}

/** Llamado por GET /auth/google/callback con purpose 'signup' (claims ya verificados con email_verified). Devuelve la URL a la que
 *  redirigir: el puente con codigo de intercambio, o el login con un error legible. Nunca lanza. */
export async function completarRegistroConGoogle(
  deps: AppDeps,
  c: Context,
  input: { readonly registroNonce: string; readonly correo: string; readonly sub: string },
): Promise<URL> {
  const login = (error: string) => {
    const url = new URL("/restaurantes/registro", deps.env.appBaseUrl);
    url.searchParams.set("registro_error", error);
    return url;
  };
  try {
    const correo = input.correo.toLowerCase();
    // Ya tiene cuenta (por correo o por Google): no se crea otra; entra a la suya.
    const existente = (await deps.coreRepo.findStaffByGoogleSub(input.sub)) ?? (await deps.coreRepo.findStaffByEmail(correo));
    if (existente) return login("cuenta_existente");
    const registro = await completar(deps, c, input.registroNonce, correo);
    await deps.coreRepo.linkGoogleIdentity({ staffId: registro.staffId, sub: input.sub, email: correo });
    const url = new URL("/restaurantes/auth/google/callback", deps.env.appBaseUrl);
    url.searchParams.set("code", await codigoDeIntercambio(deps, registro.staffId));
    return url;
  } catch (err) {
    if (err instanceof ApiError) {
      const status = err.status;
      return login(status === 409 ? "cuenta_existente" : status === 404 ? "enlace_vencido" : status === 503 ? "no_disponible" : status === 429 ? "demasiados" : "error");
    }
    logEvent(c, "error", "registro_restaurantes_google_error", { message: err instanceof Error ? err.message : String(err) });
    return login("error");
  }
}

export function registroRestaurantesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/auth/registro/restaurantes/estado", (c) => c.json({ disponible: deps.registroAutoservicioRepo !== undefined, google: deps.env.googleOAuth !== null, correo: deps.env.resend.apiKey !== null }));

  app.post("/auth/registro/restaurantes/iniciar", async (c) => {
    const L = REGISTRO_RESTAURANTES_LIMITES;
    if (!(await rateLimit(`auth:registro-restaurantes:${requestActor(c.req.raw, "ip")}`, L.porIp.max, L.porIp.windowMs, { category: "auth:password-reset" }))) {
      throw Errors.tooManyRequests("Demasiados registros desde esta conexión. Intenta de nuevo más tarde.");
    }
    const body = await readJsonCapped<IniciarBody>(c.req.raw, 8 * 1024);
    if (pareceBot(body)) {
      logEvent(c, "warn", "registro_restaurantes_trampa", {});
      return c.json({ ok: true, metodo: "correo" }, 202);
    }
    const captura = validarCapturaRegistro(body);
    if (captura.correo && !(await rateLimit(`auth:registro-restaurantes-correo:${requestActor(c.req.raw, captura.correo)}`, L.porCorreo.max, L.porCorreo.windowMs, { category: "auth:password-reset" }))) {
      throw Errors.tooManyRequests("Demasiados intentos con este correo. Intenta de nuevo más tarde.");
    }
    const repo = deps.registroAutoservicioRepo;
    if (!repo) throw noDisponible();

    if (captura.metodo === "google") {
      const google = deps.env.googleOAuth;
      if (!google) throw Errors.serviceUnavailable("El registro con Google no está disponible aún: usa tu correo.");
      const { tokenPlain, tokenHash } = generateInviteToken();
      try {
        await deps.engine.withAppSession({ userId: null }, (db) =>
          repo(db).solicitar({ vertical: "restaurantes", ...captura, correo: null, tokenHash, origenHash: origenHash(deps.env.jwtSecret, c.req.raw), ttlMinutos: L.ttlGoogleMin }),
        );
      } catch (err) {
        mapearError(err);
      }
      const codeVerifier = generateCodeVerifier();
      const nonce = generateNonce();
      const redirectUri = `${google.redirectBaseUrl}/auth/google/callback`;
      const state = await signOAuthState({ purpose: "signup", vertical: "restaurantes", nonce, codeVerifier, redirectUri, registroNonce: tokenPlain }, deps.env.jwtSecret);
      const url = buildAuthorizationUrl({ authBaseUrl: deps.env.googleStaffAuth.authBaseUrl, clientId: google.clientId, redirectUri, state, nonce, codeChallenge: computeCodeChallenge(codeVerifier) });
      return c.json({ ok: true, metodo: "google", url }, 200);
    }

    const correo = captura.correo as string;
    const existente = await deps.coreRepo.findStaffByEmail(correo);
    if (existente) {
      const loginUrl = new URL("/restaurantes/login", deps.env.appBaseUrl).toString();
      const m = correoYaTienesCuenta(correo, loginUrl);
      await enviarCorreo(deps, c, correo, m.subject, m.html, m.text);
      return c.json({ ok: true, metodo: "correo" }, 202);
    }
    const { tokenPlain, tokenHash } = generateInviteToken();
    try {
      await deps.engine.withAppSession({ userId: null }, (db) =>
        repo(db).solicitar({ vertical: "restaurantes", ...captura, tokenHash, origenHash: origenHash(deps.env.jwtSecret, c.req.raw), ttlMinutos: L.ttlCorreoMin }),
      );
    } catch (err) {
      mapearError(err);
    }
    const url = new URL("/restaurantes/registro/confirmar", deps.env.appBaseUrl);
    url.hash = `token=${tokenPlain}`;
    const m = correoEnlaceRegistro(correo, captura.nombreNegocio, url.toString());
    await enviarCorreo(deps, c, correo, m.subject, m.html, m.text);
    return c.json({ ok: true, metodo: "correo" }, 202);
  });

  app.post("/auth/registro/restaurantes/confirmar", async (c) => {
    const L = REGISTRO_RESTAURANTES_LIMITES;
    if (!(await rateLimit(`auth:registro-restaurantes-confirmar:${requestActor(c.req.raw)}`, L.confirmarPorIp.max, L.confirmarPorIp.windowMs, { category: "auth:token-issue" }))) {
      throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    }
    const body = await readJsonCapped<{ token?: unknown }>(c.req.raw, 1024);
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(body.token)) throw Errors.validation("Enlace inválido.");
    const registro = await completar(deps, c, body.token, null);
    const code = await codigoDeIntercambio(deps, registro.staffId);
    return c.json({ code, orgSlug: registro.orgSlug, trialEndsAt: registro.trialEndsAt, sucursal: { propertyId: registro.propertyId, slug: registro.branchSlug, status: "inactive" } }, 201);
  });

  return app;
}

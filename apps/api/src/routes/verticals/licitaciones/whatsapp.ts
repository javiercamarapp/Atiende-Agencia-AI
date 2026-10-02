// L-05 -- WhatsApp de licitaciones: webhook entrante (opt-in/opt-out por mensaje y
// decision go / no-go por boton), configuracion del contacto del propio usuario y
// solicitud de decision por WhatsApp para una convocatoria.
//
// SEGURIDAD DEL WEBHOOK (mismo criterio que citas/hoteles/restaurantes): sin
// authMiddleware; verificacion HMAC (X-Hub-Signature-256) sobre los BYTES CRUDOS del body
// -- por eso esta ruta nunca usa `c.req.json()`/`.text()` -- y tope de tamano y de
// ritmo. Solo se atienden mensajes del numero remitente configurado de la plataforma
// (`LICITACIONES_WHATSAPP_PHONE_NUMBER_ID`).
//
// DECISION POR BOTON: el `id` del boton trae un token de un solo uso. Flujo:
//   1. sesion de SISTEMA: a quien pertenece el hash del token (sin consumirlo);
//   2. UNA transaccion con la sesion DE ESE USUARIO (`withAppSession({ userId })`): la base
//      consume el token (revalida usuario, telefono remitente, expiracion, contacto activo
//      y rol vigente) Y se inserta `go_no_go_decision` con RLS de ese usuario
//      (`can_go_no_go_org`). Si el insert falla, TODO se revierte: el token queda sin usar.
//   3. sesion de SISTEMA: respuesta al usuario en el outbox (best-effort).
// El MatchResult que sustenta la decision se recalcula en vivo (`computeLiveGoNoGoMatch`).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (migracion 030 pendiente): el repositorio lanza
// `WhatsAppNotAvailableError` dentro de SAVEPOINT. Webhook -> acuse 200 sin procesar;
// lecturas del panel -> `available: false`; escrituras -> 503. Nunca un 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { extractMetaInboundMessages, extractMetaPhoneNumberId, verifyMetaSignature } from "@atiende/domain-citas";
import {
  DECISION_ROLES,
  GO_NO_GO_ROLES,
  GoNoGoRejectedError,
  MEXICO_CITY_TZ,
  OPT_IN_CONFIRMED_BODY,
  OPT_OUT_CONFIRMED_BODY,
  WhatsAppNotAvailableError,
  WhatsAppValidationError,
  buildDecisionReplyBody,
  computeLiveGoNoGoMatch,
  normalizePhoneE164,
  parseActionButtonId,
  parseOptKeyword,
  phoneFromMeta,
  requestGoNoGoDecisionsByWhatsApp,
  sha256TokenHash,
} from "@atiende/domain-licitaciones";
import type { LicitacionesRole, TokenConsumeOutcome, WhatsAppRepository } from "@atiende/domain-licitaciones";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../../../errors.ts";
import { constantTimeEqual, readJsonCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { dispatchWhatsAppVertical } from "../../internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

const MAX_BODY_BYTES = 256 * 1024;
const INBOUND_WEBHOOK_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;
const INLINE_DISPATCH_LIMIT = 5;
const WEBHOOK_PATH = "/v1/licitaciones/whatsapp/webhook";
const UUID_PARAM = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

function formatDeadline(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString("es-MX", { timeZone: MEXICO_CITY_TZ, dateStyle: "medium", timeStyle: "short" });
}

function unavailableError(): Error {
  return Errors.serviceUnavailable("Los avisos por WhatsApp aun no estan disponibles en este ambiente.");
}

export function licitacionesWhatsAppRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const waRepoFactory = deps.licitacionesWhatsAppRepo;
  const senderPhoneNumberId = deps.env.licitacionesWhatsappPhoneNumberId ?? null;

  // ---------------------------------------------------------------------
  // Webhook (publico, firmado por Meta)
  // ---------------------------------------------------------------------
  app.get(WEBHOOK_PATH, (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && constantTimeEqual(token ?? null, deps.env.whatsappVerifyToken)) return c.text(challenge ?? "");
    return c.text("Forbidden", 403);
  });

  /** Respuesta al usuario por el outbox, en SU propia sesion de sistema (best-effort: nunca rompe el webhook). */
  async function enqueueReply(organizationId: string, dedupeKey: string, to: string, body: string): Promise<void> {
    if (!waRepoFactory) return;
    try {
      await deps.engine.withAppSession({ userId: null }, (db) => waRepoFactory(db).enqueueOutbox(organizationId, "reply", dedupeKey, { to, body, transaccional: true }));
    } catch (err) {
      console.error("licitaciones whatsapp: no se pudo encolar la respuesta (best-effort):", err instanceof Error ? err.message : err);
    }
  }

  /** Devuelve `retryable` para que Meta reintente el lote si algo transitorio fallo. */
  async function handleButton(messageId: string, senderPhone: string, buttonId: string): Promise<{ retryable: boolean }> {
    const token = parseActionButtonId(buttonId);
    if (!token || !waRepoFactory) return { retryable: false }; // boton de otro flujo / mal formado: se ignora
    const tokenHash = sha256TokenHash(token);

    // 1) duenno del token (sesion de sistema). Sin duenno: no hay organizacion a la que responder.
    const owner = await deps.engine.withAppSession({ userId: null }, (db) => waRepoFactory(db).tokenOwner(tokenHash));
    if (!owner) return { retryable: false };

    // 2) consumo + decision en UNA transaccion, con la sesion del usuario del token.
    let outcome: TokenConsumeOutcome;
    try {
      outcome = await deps.engine.withAppSession({ userId: owner.userId }, async (db) => {
        const consumed = await waRepoFactory(db).consumeActionToken(tokenHash, senderPhone, messageId);
        if (consumed.result !== "ok") return consumed; // rechazo: el token NO se consumio; las filas de bitacora si se conservan
        const lrepo = deps.licitacionesRepo(db);
        const tender = consumed.tenderId ? await lrepo.findTender(owner.organizationId, consumed.tenderId) : null;
        if (!tender || !consumed.action || !consumed.role) throw new Error("convocatoria no encontrada al registrar la decision por WhatsApp");
        const match = await computeLiveGoNoGoMatch(lrepo, owner.organizationId, tender);
        await lrepo.createGoNoGoDecision(owner.organizationId, tender.id, {
          decision: consumed.action,
          reasons: ["Decision registrada por boton de WhatsApp."],
          matchScore: match.matchScore,
          matchEligibilityStatus: match.matchEligibilityStatus,
          matchInputsHash: match.matchInputsHash,
          actorId: owner.userId,
          actorRole: consumed.role as LicitacionesRole,
        });
        return consumed;
      });
    } catch (err) {
      if (err instanceof WhatsAppNotAvailableError) return { retryable: false };
      if (err instanceof GoNoGoRejectedError) {
        await enqueueReply(owner.organizationId, `reply:${messageId}`, senderPhone, buildDecisionReplyBody("rol_insuficiente"));
        return { retryable: false };
      }
      // Fallo transitorio: la transaccion se revirtio (token sin usar). Aviso al usuario y Meta reintenta el lote.
      console.error("licitaciones whatsapp: fallo registrando la decision:", err instanceof Error ? err.message : err);
      await enqueueReply(owner.organizationId, `reply-error:${messageId}`, senderPhone, buildDecisionReplyBody("error"));
      return { retryable: true };
    }

    // 3) respuesta (el duplicado de un reintento de Meta no repite el mensaje: mismo dedupe por messageId)
    if (outcome.result !== "duplicado") {
      await enqueueReply(owner.organizationId, `reply:${messageId}`, senderPhone, buildDecisionReplyBody(outcome.result, outcome.action));
    }
    return { retryable: false };
  }

  async function handleKeyword(messageId: string, senderPhone: string, keyword: "opt_in" | "opt_out"): Promise<void> {
    if (!waRepoFactory) return;
    const orgs = await deps.engine.withAppSession({ userId: null }, (db) => {
      const repo = waRepoFactory(db);
      return keyword === "opt_in" ? repo.confirmOptIn(senderPhone) : repo.optOutByPhone(senderPhone);
    });
    // Un solo mensaje de confirmacion por numero (aunque este registrado en varias organizaciones).
    if (orgs[0]) await enqueueReply(orgs[0], `${keyword}:${messageId}`, senderPhone, keyword === "opt_in" ? OPT_IN_CONFIRMED_BODY : OPT_OUT_CONFIRMED_BODY);
  }

  app.post(WEBHOOK_PATH, async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) return c.text("Payload too large", 413);
    const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return c.text("Payload too large", 413);

    if (!deps.env.whatsappAppSecret) return c.text("Webhook not configured", 503);
    if (!(await verifyMetaSignature(rawBody, c.req.header("x-hub-signature-256") ?? null, deps.env.whatsappAppSecret))) return c.text("Invalid signature", 401);

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.text("Invalid JSON", 400);
    }

    const phoneNumberId = extractMetaPhoneNumberId(payload);
    const allowed = await rateLimit(
      `conversation:inbound-webhook:${requestActor(c.req.raw, phoneNumberId ?? "sin-numero")}`,
      INBOUND_WEBHOOK_RATE_LIMIT.max,
      INBOUND_WEBHOOK_RATE_LIMIT.windowMs,
      { category: "conversation:inbound-webhook" },
    );
    if (!allowed) return c.text("Too Many Requests", 429);

    // Numero no configurado / de otro flujo: acuse silencioso (Meta no debe reintentar).
    if (!waRepoFactory || !senderPhoneNumberId || phoneNumberId !== senderPhoneNumberId) return c.json({ ok: true });

    let retryable = false;
    for (const message of extractMetaInboundMessages(payload)) {
      const senderPhone = phoneFromMeta(message.from);
      if (!senderPhone) continue;
      try {
        if (message.interactive?.kind === "button_reply") {
          const r = await handleButton(message.id, senderPhone, message.interactive.id);
          if (r.retryable) retryable = true;
        } else if (!message.interactive) {
          const keyword = parseOptKeyword(message.body);
          if (keyword) await handleKeyword(message.id, senderPhone, keyword);
        }
      } catch (err) {
        if (err instanceof WhatsAppNotAvailableError) continue; // base sin migrar: nada que procesar
        console.error("licitaciones whatsapp: fallo procesando un mensaje entrante:", err instanceof Error ? err.message : err);
        retryable = true;
      }
    }

    // Envio inmediato (best-effort) de lo recien encolado, en una sesion de sistema aparte DESPUES de los commits.
    await dispatchWhatsAppVertical(deps, "licitaciones", INLINE_DISPATCH_LIMIT);
    return c.json({ ok: !retryable }, retryable ? 500 : 200);
  });

  // ---------------------------------------------------------------------
  // Configuracion del propio contacto (panel)
  // ---------------------------------------------------------------------
  const settingsPath = "/licitaciones/:propertyId/whatsapp/settings";
  app.use(settingsPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/licitaciones/:propertyId/whatsapp/opt-out", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`/licitaciones/:propertyId/tenders/:tenderId{${UUID_PARAM}}/whatsapp/request-decision`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(settingsPath, async (c) => {
    const base = { configured: Boolean(senderPhoneNumberId) };
    if (!waRepoFactory) return c.json({ ...base, available: false, contact: null, events: [] });
    const repo = waRepoFactory(c.get("db"));
    const organizationId = c.get("organizationId");
    try {
      const contact = await repo.getContact(organizationId, c.get("userId"));
      // La bitacora solo la ven los roles de decision (RLS lo refuerza); el resto recibe lista vacia.
      const role = c.get("verticalRole") as LicitacionesRole | undefined;
      const events = role && DECISION_ROLES.includes(role) ? await repo.listEvents(organizationId, 30) : [];
      return c.json({ ...base, available: true, contact, events });
    } catch (err) {
      if (err instanceof WhatsAppNotAvailableError) return c.json({ ...base, available: false, contact: null, events: [] });
      throw err;
    }
  });

  app.put(settingsPath, async (c) => {
    if (!waRepoFactory) throw unavailableError();
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    let phoneE164: string;
    try {
      phoneE164 = normalizePhoneE164(typeof raw.phone === "string" ? raw.phone : "");
    } catch (err) {
      if (err instanceof WhatsAppValidationError) throw Errors.validation(err.message);
      throw err;
    }
    const flag = (name: string): boolean => {
      const v = raw[name];
      if (v === undefined) return true;
      if (typeof v !== "boolean") throw Errors.validation(`${name}: se esperaba true o false.`);
      return v;
    };
    const input = { phoneE164, notifyPlazos: flag("notifyPlazos"), notifyConvocatorias: flag("notifyConvocatorias"), notifyFallos: flag("notifyFallos"), notifyDecisiones: flag("notifyDecisiones") };
    const repo = waRepoFactory(c.get("db"));
    const organizationId = c.get("organizationId");
    try {
      let contact = await repo.upsertContact(organizationId, c.get("userId"), input);
      // Telefono nuevo o aun sin verificar: pide el mensaje de confirmacion (responder SI activa los avisos).
      if (contact.status === "pendiente" && senderPhoneNumberId) {
        await repo.requestConsent(organizationId);
        contact = (await repo.getContact(organizationId, c.get("userId"))) ?? contact;
      }
      return c.json({ contact, configured: Boolean(senderPhoneNumberId) });
    } catch (err) {
      if (err instanceof WhatsAppNotAvailableError) throw unavailableError();
      throw err;
    }
  });

  app.post("/licitaciones/:propertyId/whatsapp/opt-out", async (c) => {
    if (!waRepoFactory) throw unavailableError();
    try {
      const changed = await waRepoFactory(c.get("db")).optOutSelf(c.get("organizationId"));
      return c.json({ ok: true, changed });
    } catch (err) {
      if (err instanceof WhatsAppNotAvailableError) throw unavailableError();
      throw err;
    }
  });

  // ---------------------------------------------------------------------
  // Pedir la decision go / no-go de una convocatoria por WhatsApp
  // ---------------------------------------------------------------------
  app.post(`/licitaciones/:propertyId/tenders/:tenderId{${UUID_PARAM}}/whatsapp/request-decision`, async (c) => {
    assertVerticalRole(c, GO_NO_GO_ROLES);
    if (!waRepoFactory) throw unavailableError();
    if (!senderPhoneNumberId) throw Errors.serviceUnavailable("El numero de WhatsApp de la plataforma no esta configurado en este ambiente.");
    const organizationId = c.get("organizationId");
    const tender = await deps.licitacionesRepo(c.get("db")).findTender(organizationId, c.req.param("tenderId"));
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    try {
      // Autorizacion ya resuelta arriba (rol + pertenencia). La emision de tokens y el encolado son funciones de
      // SISTEMA en la base (guard `auth.uid() is null`), asi que corren en su propia sesion de sistema.
      const result = await deps.engine.withAppSession({ userId: null }, (db) =>
        requestGoNoGoDecisionsByWhatsApp(waRepoFactory(db) as WhatsAppRepository, {
          organizationId,
          tender: { id: tender.id, title: tender.title, deadlineLabel: formatDeadline(tender.submissionDeadline) },
        }),
      );
      if (result.requested > 0) await dispatchWhatsAppVertical(deps, "licitaciones", INLINE_DISPATCH_LIMIT);
      logEvent(c, "info", "licitaciones_whatsapp_decision_solicitada", { requested: result.requested, eligible: result.eligible });
      return c.json(result, 202);
    } catch (err) {
      if (err instanceof WhatsAppNotAvailableError) throw unavailableError();
      throw err;
    }
  });

  return app;
}

// Fase 2 §1 — Server Tools HTTP reales para el agente de voz de restaurantes (Gemini Live; ya sin ElevenLabs, ver docs/VOZ-PM.md)
// (`buscar_sucursal_cercana`/`buscar_producto`/`cotizar_pedido`). Port del
// envoltorio HTTP delgado de
// restaurantes/supabase/functions/{buscar-sucursal-cercana,buscar-producto,cotizar-pedido}/index.ts
// — la lógica real de negocio ya vive en @atiende/domain-restaurantes
// (Fase 1 + Fase 2 §1.1.1/§1.3), este archivo solo la expone por HTTP.
//
// Mismo patrón de auth que create-order/customer-lookup (public.ts): NI
// `authMiddleware` NI `originAllowed` — el servicio de voz (servidor de confianza) no manda `Origin` ni
// `Authorization`: presenta el token por llamada (`x-atiende-call-token`) o, en el camino de compatibilidad,
// el secreto `x-atiende-tool-secret`. La nota real de `verify_jwt=false` del origen es un detalle de plataforma
// de Supabase Edge Functions sin equivalente aquí.
//
// Se monta como su propio sub-Hono (en vez de extender public.ts) para que
// el árbol de archivos deje claro qué endpoints son Server Tools de voz.
//
// NO DUPLICAR buscar_cliente NI crear_pedido AQUÍ: las otras 2 de las 3 tools
// documentadas en docs/agente-voz/system-prompt.md §3 del repo original
// (§3.1 buscar_cliente, §3.3 crear_pedido) YA existen como Server Tools HTTP
// reales, protegidas con el MISMO `x-atiende-tool-secret`, desde Fase 1
// (commit e9d9d33, anterior a este archivo) — ver public.ts:
//   - POST /v1/restaurantes/:orgSlug/customers/lookup  (buscar_cliente,
//     `lookupCustomer` — memoria real de cliente por teléfono)
//   - POST /v1/restaurantes/:orgSlug/orders  (crear_pedido, `createOrder` —
//     con `x-atiende-tool-secret` presente, la fuente del pedido se fuerza a
//     "voice" sin importar lo que mande el body, y exige customer_address +
//     payment_method + teléfono mexicano de 10 dígitos, igual que WhatsApp)
// Volver a montarlas aquí con el mismo path chocaría con public.ts (ambos se
// montan en "/" en app.ts) y quedarían muertas. El flujo cerrado de punta a
// punta (reconocer al cliente recurrente -> cotizar -> cerrar el pedido antes
// de colgar), los 3 vía x-atiende-tool-secret, está probado explícitamente en
// apps/api/tests/voice-order-closed-loop.spec.ts.
import { Hono } from "hono";
import type { Context } from "hono";
import { canonicalizeMexicanPhone, consumeRateLimit, invokeAgentTool, OrderValidationError } from "@atiende/domain-restaurantes";
import type { AgentToolContext, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { CALL_ID_RE, signVoiceCallToken, VOICE_CALL_TOKEN_DEFAULT_TTL_SECONDS, VOICE_CALL_TOKEN_MAX_TTL_SECONDS, voiceCallTokenKey } from "../../../voice-call-token.ts";
import { auditVoice, authenticateVoiceTool, enforceVoiceLimits, hasVoiceCredentials, type VoiceCaller } from "./voice-auth.ts";

async function resolveOrganizationOrNotFound(repo: RestaurantesRepository, orgSlug: string) {
  const org = await repo.findOrganizationBySlug(orgSlug);
  if (!org) throw Errors.notFound(`Restaurante "${orgSlug}" no encontrado.`);
  return org;
}

/** Cabecera con el turno del CLIENTE que pone el worker de la llamada (no el modelo): numero de hablas inteligibles hasta ese momento. */
export const VOICE_TURN_HEADER = "x-atiende-call-turn";

/** Turno del cliente informado por el worker; `null` si falta o no es un entero corto (se conserva el comportamiento sin turno). */
export function voiceTurnFromRequest(c: Context): string | null {
  const raw = c.req.header(VOICE_TURN_HEADER);
  return raw !== undefined && /^\d{1,6}$/.test(raw) ? String(Number(raw)) : null;
}

/** Contexto del registro unico para una llamada de voz: telefono y sucursal salen del TOKEN; el turno, de la cabecera del worker. */
export function voiceToolContext(orgId: string, caller: VoiceCaller, turn: string | null = null): AgentToolContext {
  return {
    organizationId: orgId,
    channel: "voz",
    phone: caller.phone,
    ...(caller.phoneDeclared ? { phoneDeclared: true } : {}),
    lockedPropertyId: caller.propertyId,
    // Maquina de estados del pedido: solo con llamada identificada (token). Sin token (camino legado)
    // no hay callId confiable sobre el que llevar estado.
    ...(caller.callId ? { flow: { key: `call:${caller.callId}`, turn }, sourceEventId: `call:${caller.callId}` } : {}),
  };
}

export interface VoiceToolRouteOptions {
  readonly tool: string;
  readonly accept: "required" | "legacy_ok";
  /** Limite por IP del camino legado (la IP es la del proveedor, por eso solo aplica sin token/sucursal). */
  readonly legacyLimit?: { readonly scope: string; readonly secondary: string; readonly max: number };
}

/**
 * Esqueleto comun de una herramienta de voz: sesion de sistema -> organizacion -> autenticacion
 * (token / secreto de sucursal / secreto legado) -> limites por llamada y sucursal -> ejecucion en un
 * SAVEPOINT (un rechazo de negocio revierte solo los efectos de la herramienta, y su bitacora si se
 * confirma) -> bitacora.
 */
export async function runVoiceToolRoute(
  deps: AppDeps,
  c: Context,
  orgSlug: string,
  options: VoiceToolRouteOptions,
  exec: (args: { repo: RestaurantesRepository; org: { id: string }; caller: VoiceCaller; toolCtx: AgentToolContext }) => Promise<Response>,
): Promise<Response> {
  return deps.engine.withAppSession({ userId: null }, async (db) => {
    const repo = deps.restaurantesRepo(db);
    const org = await resolveOrganizationOrNotFound(repo, orgSlug);
    const auth = await authenticateVoiceTool(deps, c, repo, org, { tool: options.tool, accept: options.accept });
    if (!auth.ok) return auth.response;
    const { caller } = auth;

    if (caller.kind === "legacy_secret" && options.legacyLimit) {
      const limited = await consumeRateLimit(repo, options.legacyLimit.scope, requestActor(c.req.raw, options.legacyLimit.secondary), options.legacyLimit.max, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();
    } else {
      const limitedResponse = await enforceVoiceLimits(c, repo, org, caller, options.tool);
      if (limitedResponse) return limitedResponse;
    }

    try {
      const response = await repo.runWithRowSavepoint(() => exec({ repo, org, caller, toolCtx: voiceToolContext(org.id, caller, voiceTurnFromRequest(c)) }));
      await auditVoice(repo, org, caller, options.tool, "ok", null);
      return response;
    } catch (err) {
      if (err instanceof OrderValidationError) {
        const code = (err as { code?: unknown }).code;
        await auditVoice(repo, org, caller, options.tool, "denied", typeof code === "string" ? code : "validacion");
        return c.json({ code: "validation_error", message: err.message }, 400);
      }
      throw err;
    }
  });
}

export function restaurantesVoiceToolsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // §1.1 — POST /v1/restaurantes/:orgSlug/branches/nearest (buscar_sucursal_cercana).
  // matching de colonia contra `restaurantes.known_zone` de ESTA organización + distancia Haversine
  // real. Cero-match real -> encontrada:false, NUNCA se inventa/adivina una sucursal.
  app.post("/v1/restaurantes/:orgSlug/branches/nearest", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ colonia?: unknown; lat?: unknown; lng?: unknown; max_km?: unknown }>(c.req.raw, 4 * 1024);
    const colonia = body.colonia;
    const hasPoint = body.lat !== undefined || body.lng !== undefined;
    if (colonia !== undefined && (typeof colonia !== "string" || colonia.length > 160)) throw Errors.validation("colonia inválida");
    if (hasPoint && (typeof body.lat !== "number" || typeof body.lng !== "number" || !Number.isFinite(body.lat) || !Number.isFinite(body.lng))) {
      throw Errors.validation("lat y lng deben venir juntas y ser números");
    }
    if (body.max_km !== undefined && (typeof body.max_km !== "number" || !Number.isFinite(body.max_km))) throw Errors.validation("max_km inválido");
    if (!hasPoint && (typeof colonia !== "string" || !colonia.trim())) throw Errors.validation("colonia es requerido (o lat y lng)");
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "buscar_sucursal_cercana", accept: "legacy_ok", legacyLimit: { scope: "voice-branches-nearest", secondary: typeof colonia === "string" && colonia.trim() ? colonia : `${body.lat},${body.lng}`, max: 60 } }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "buscar_sucursal_cercana", { ...(typeof colonia === "string" ? { colonia } : {}), ...(hasPoint ? { lat: body.lat, lng: body.lng } : {}), ...(body.max_km !== undefined ? { max_km: body.max_km } : {}) });
      return c.json(outcome.result as object);
    });
  });

  // POST /v1/restaurantes/:orgSlug/branches/info (consultar_sucursal): direccion, horario, si abre ahora.
  app.post("/v1/restaurantes/:orgSlug/branches/info", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const { branch_slug: branchSlug } = await readJsonCapped<{ branch_slug?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof branchSlug !== "string" || !branchSlug.trim() || branchSlug.length > 100) throw Errors.validation("branch_slug es requerido");
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "consultar_sucursal", accept: "legacy_ok", legacyLimit: { scope: "voice-branches-info", secondary: branchSlug, max: 120 } }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "consultar_sucursal", { branch_slug: branchSlug });
      return c.json(outcome.result as object);
    });
  });

  // §1.2 — POST /v1/restaurantes/:orgSlug/products/search (buscar_producto). branch_slug sigue siendo
  // obligatorio: si falta o no existe, error explícito 400, nunca cae en silencio a una sucursal default.
  app.post("/v1/restaurantes/:orgSlug/products/search", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const { query, branch_slug: branchSlug } = await readJsonCapped<{ query?: unknown; branch_slug?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof query !== "string" || !query.trim() || query.length > 160) throw Errors.validation("query es requerido");
    if (typeof branchSlug !== "string" || !branchSlug.trim() || branchSlug.length > 100) {
      throw Errors.validation("branch_slug es requerido — confirma la sucursal antes de buscar productos");
    }
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "buscar_producto", accept: "legacy_ok", legacyLimit: { scope: "voice-products-search", secondary: branchSlug, max: 120 } }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "buscar_producto", { query, branch_slug: branchSlug });
      return c.json({ productos: outcome.result });
    });
  });

  // §1.3 — POST /v1/restaurantes/:orgSlug/orders/quote (cotizar_pedido). La guardia anti-alucinación de
  // precio/pack_size/tortilla/mayoría-de-edad vive en `quoteOrder`. Respuesta: el `OrderQuote` real tal
  // cual; con llamada identificada (token) agrega `quote_hash` y avanza la máquina de estados.
  app.post("/v1/restaurantes/:orgSlug/orders/quote", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ branch_slug?: unknown; items?: unknown; adult_confirmed?: unknown; canal?: unknown; colonia_entrega?: unknown; payment_method?: unknown; doble_salsas?: unknown; programado_para?: unknown; hora_recogida?: unknown }>(c.req.raw, 24 * 1024);
    const branchSlug = typeof body.branch_slug === "string" ? body.branch_slug : "";
    if (!branchSlug.trim()) throw Errors.validation("branch_slug es requerido");
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "cotizar_pedido", accept: "legacy_ok", legacyLimit: { scope: "voice-orders-quote", secondary: branchSlug, max: 120 } }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "cotizar_pedido", {
        branch_slug: branchSlug,
        items: body.items,
        adult_confirmed: body.adult_confirmed,
        // Modelo PM: canal (default domicilio), colonia de entrega y forma de pago (solo para saber si
        // corresponde preguntar propina). Las reglas las aplica quoteOrder.
        canal: body.canal,
        colonia_entrega: body.colonia_entrega,
        payment_method: body.payment_method,
        doble_salsas: body.doble_salsas,
        // La misma hora que luego llega a crear_pedido: sin ella la huella de cotizar y la de crear diferian y el pedido
        // programado nunca cerraba por voz (QA-PM-R2-voz-01 / reglas-03).
        programado_para: body.programado_para,
        hora_recogida: body.hora_recogida,
      });
      // Contrato historico de voz: `quote` es el OrderQuote de dominio sin transformar (+ quote_hash aditivo).
      // PM PR-4: `total` es el TOTAL A PAGAR (ya con la promocion automatica del dia, si aplica);
      // `subtotal`, `descuento`, `promocionAplicada` y `promocionesSugeridas` son campos aditivos.
      return c.json({ quote: outcome.raw, ...(outcome.quoteHash ? { quote_hash: outcome.quoteHash } : {}) });
    });
  });

  // Cliente 360 — POST /v1/restaurantes/:orgSlug/customers/orders (historial_pedidos): ultimos pedidos del MISMO numero.
  // Exige token de llamada: el telefono sale del token (nunca del cuerpo), asi que un modelo no puede pedir el historial de otro numero.
  app.post("/v1/restaurantes/:orgSlug/customers/orders", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    await readJsonCapped<Record<string, unknown>>(c.req.raw, 2 * 1024);
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "historial_pedidos", accept: "required" }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "historial_pedidos", {});
      return c.json(outcome.result as object);
    });
  });

  // Cliente 360 — POST /v1/restaurantes/:orgSlug/orders/repeat (repetir_pedido): re-cotiza un pedido anterior del mismo
  // numero con los precios de HOY y entra a la misma maquina de estados que cotizar_pedido (quote_hash).
  app.post("/v1/restaurantes/:orgSlug/orders/repeat", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ branch_slug?: unknown; pedido_numero?: unknown; canal?: unknown; colonia_entrega?: unknown; payment_method?: unknown; adult_confirmed?: unknown }>(c.req.raw, 4 * 1024);
    const branchSlug = typeof body.branch_slug === "string" ? body.branch_slug : "";
    if (!branchSlug.trim()) throw Errors.validation("branch_slug es requerido");
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "repetir_pedido", accept: "required" }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "repetir_pedido", {
        branch_slug: branchSlug,
        pedido_numero: body.pedido_numero,
        canal: body.canal,
        colonia_entrega: body.colonia_entrega,
        payment_method: body.payment_method,
        adult_confirmed: body.adult_confirmed,
      });
      return c.json(outcome.result as object);
    });
  });

  // POST /v1/restaurantes/:orgSlug/orders/confirm (confirmar_resumen): registra que el cliente dijo si al
  // resumen. Exige token de llamada: el estado vive por llamada.
  app.post("/v1/restaurantes/:orgSlug/orders/confirm", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ quote_hash?: unknown }>(c.req.raw, 2 * 1024);
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: "confirmar_resumen", accept: "required" }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, "confirmar_resumen", { quote_hash: typeof body.quote_hash === "string" ? body.quote_hash : undefined });
      return c.json(outcome.result as object);
    });
  });

  // POST /v1/restaurantes/:orgSlug/callbacks (escalar_a_humano / registrar_contacto): deja un aviso para
  // una persona del restaurante. El telefono sale del token de llamada.
  app.post("/v1/restaurantes/:orgSlug/callbacks", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ customer_name?: unknown; motivo?: unknown; resumen?: unknown; reason?: unknown; message?: unknown }>(c.req.raw, 4 * 1024);
    const escalada = typeof body.motivo === "string";
    return runVoiceToolRoute(deps, c, c.req.param("orgSlug"), { tool: escalada ? "escalar_a_humano" : "registrar_contacto", accept: "required" }, async ({ repo, toolCtx }) => {
      const outcome = await invokeAgentTool(repo, toolCtx, escalada ? "escalar_a_humano" : "registrar_contacto", {
        customer_name: body.customer_name,
        motivo: body.motivo,
        resumen: body.resumen,
        reason: body.reason,
        message: body.message,
      });
      return c.json(outcome.result as object);
    });
  });

  // POST /v1/restaurantes/:orgSlug/voice/call-token — alta de llamada. Lo invoca la telefonia/puente de voz
  // (servidor de confianza) con el secreto de la sucursal y el telefono que reporta la linea (caller ID);
  // devuelve el token por llamada que las herramientas presentan despues. El telefono NUNCA lo decide el modelo.
  app.post("/v1/restaurantes/:orgSlug/voice/call-token", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();
    const body = await readJsonCapped<{ call_id?: unknown; caller_phone?: unknown; telefono_declarado?: unknown; branch_slug?: unknown; ttl_seconds?: unknown }>(c.req.raw, 2 * 1024);
    if (typeof body.call_id !== "string" || !CALL_ID_RE.test(body.call_id)) throw Errors.validation("call_id es requerido (1-128 caracteres: letras, números, . _ : -)");
    const phone = typeof body.caller_phone === "string" ? canonicalizeMexicanPhone(body.caller_phone) : null;
    if (!phone) throw Errors.validation("caller_phone inválido: se esperan 10 dígitos (con o sin +52/521)");
    const ttl = Math.min(
      VOICE_CALL_TOKEN_MAX_TTL_SECONDS,
      Math.max(60, typeof body.ttl_seconds === "number" && Number.isFinite(body.ttl_seconds) ? Math.floor(body.ttl_seconds) : VOICE_CALL_TOKEN_DEFAULT_TTL_SECONDS),
    );
    if (body.telefono_declarado !== undefined && typeof body.telefono_declarado !== "boolean") throw Errors.validation("telefono_declarado debe ser booleano");
    const declarado = body.telefono_declarado === true;
    const callId = body.call_id;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));
      const auth = await authenticateVoiceTool(deps, c, repo, org, { tool: "emitir_token_de_llamada", accept: "legacy_ok", secretOnly: true });
      if (!auth.ok) return auth.response;
      const { caller } = auth;

      if (caller.kind === "legacy_secret") {
        const limited = await consumeRateLimit(repo, "voice-call-token", requestActor(c.req.raw, callId), 60, 60);
        if (!limited.allowed) throw Errors.tooManyRequests();
      } else {
        const limitedResponse = await enforceVoiceLimits(c, repo, org, { ...caller, callId: null }, "emitir_token_de_llamada");
        if (limitedResponse) return limitedResponse;
      }

      // Sucursal de la llamada: la del secreto de sucursal; con el secreto legado (sin sucursal) debe venir en el body.
      const requestedSlug = typeof body.branch_slug === "string" ? body.branch_slug : null;
      const branch = requestedSlug ? await repo.findBranch(org.id, { slug: requestedSlug }) : caller.propertyId ? await repo.findBranchById(org.id, caller.propertyId) : null;
      if (!branch || branch.status !== "active") {
        await auditVoice(repo, org, { propertyId: caller.propertyId, callId, phone }, "emitir_token_de_llamada", "denied", "sucursal_no_encontrada");
        return c.json({ code: "validation_error", message: "branch_slug es requerido y debe ser una sucursal activa de este restaurante" }, 400);
      }
      // Un secreto de OTRA sucursal no emite tokens para esta (aislamiento entre sucursales).
      if (caller.propertyId && caller.propertyId !== branch.propertyId) {
        await auditVoice(repo, org, { propertyId: caller.propertyId, callId, phone }, "emitir_token_de_llamada", "denied", "secreto_de_otra_sucursal");
        return c.json({ code: "forbidden", message: "El secreto presentado no pertenece a esa sucursal." }, 403);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const token = signVoiceCallToken(voiceCallTokenKey(deps.env.internalSecret), { org: org.id, prop: branch.propertyId, call: callId, ph: phone, ...(declarado ? { decl: true } : {}), iat: nowSec, exp: nowSec + ttl });
      await auditVoice(repo, org, { propertyId: branch.propertyId, callId, phone }, "emitir_token_de_llamada", "token_issued", null);
      return c.json({ call_token: token, expires_at: new Date((nowSec + ttl) * 1000).toISOString(), branch_slug: branch.slug, call_id: callId });
    });
  });

  return app;
}

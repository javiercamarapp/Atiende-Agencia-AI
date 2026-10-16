// Rutas públicas/de sistema de restaurantes — port de
// restaurantes/supabase/functions/{create-order,customer-lookup}/index.ts. NINGUNA de
// las dos usa Supabase Auth de usuario (ver diseño Fase 1 §3): ambas son Server
// Tools de voz. El checkout web público (pedido sin cuenta, canal `web`) YA NO
// EXISTE: los pedidos entran por WhatsApp o por llamada. Por eso este grupo se
// monta SIN `authMiddleware`/`requirePropertyMembership` de core-auth, con su
// propia verificación por ruta (header `x-atiende-tool-secret`/token de llamada).
import { Hono } from "hono";
import {
  canonicalizeMexicanPhone,
  consumeRateLimit,
  crearHookPedidoGrande,
  invokeAgentTool,
  OrderConflictError,
  OrderValidationError,
  esGuardaSqlDeNegocioDePedido,
  redondearACentavos,
} from "@atiende/domain-restaurantes";
import type { CreateOrderInput, Order, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { encolarComandaParaPedido } from "@atiende/domain-restaurantes/softrestaurant";
import { avisarPedidoRecibido } from "./autopiloto-recibido.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";
import { auditVoice, authenticateVoiceTool, enforceVoiceLimits, hasVoiceCredentials } from "./voice-auth.ts";
import { runVoiceToolRoute, voiceToolContext, voiceTurnFromRequest } from "./voice-tools.ts";
import type { AppDeps } from "../../../deps.ts";

interface CreateOrderItemBody {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly quantity?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

interface CreateOrderBody {
  readonly branch_slug?: unknown;
  readonly branch_name?: unknown;
  readonly customer_name?: unknown;
  readonly customer_phone?: unknown;
  readonly customer_address?: unknown;
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql: solo el
   * canal `web` (este handler) puede capturarlo hoy; la Server Tool de voz
   * (más abajo) no expone este campo todavía. */
  readonly customer_email?: unknown;
  readonly items?: readonly CreateOrderItemBody[];
  readonly source?: unknown;
  readonly notes?: unknown;
  readonly payment_method?: unknown;
  readonly idempotency_key?: unknown;
  readonly adult_confirmed?: unknown;
  readonly requested_complements?: unknown;
  readonly omit_default_complements?: unknown;
  readonly call_transcript?: unknown;
  readonly call_recording_url?: unknown;
  readonly promo_code?: unknown;
  /** Modelo PM (migración 023): canal del pedido ("domicilio" | "recoger"), colonia de entrega
   * y propina en pesos — las reglas por sucursal las aplica `createOrder`, nunca esta ruta. */
  readonly canal?: unknown;
  readonly colonia_entrega?: unknown;
  readonly propina?: unknown;
  /** PM PR-3: hora prometida de recogida (ISO 8601 con zona, solo canal "recoger") y doble porcion de salsas. */
  readonly hora_recogida?: unknown;
  readonly doble_salsas?: unknown;
  /** R-11: pedido PROGRAMADO -- fecha y hora (ISO 8601 con zona) para la que se quiere el pedido. */
  readonly programado_para?: unknown;
}

function mapCreateOrderBody(organizationId: string, body: CreateOrderBody, source: "web" | "voice"): CreateOrderInput {
  return {
    organizationId,
    branchSlug: typeof body.branch_slug === "string" ? body.branch_slug : undefined,
    branchName: typeof body.branch_name === "string" ? body.branch_name : undefined,
    customerName: typeof body.customer_name === "string" ? body.customer_name : "",
    customerPhone: typeof body.customer_phone === "string" ? body.customer_phone : "",
    customerAddress: typeof body.customer_address === "string" ? body.customer_address : undefined,
    customerEmail: typeof body.customer_email === "string" ? body.customer_email : undefined,
    items: Array.isArray(body.items)
      ? body.items.map((item) => ({
          productId: typeof item.product_id === "string" ? item.product_id : undefined,
          productName: typeof item.product_name === "string" ? item.product_name : undefined,
          quantity: typeof item.quantity === "number" ? item.quantity : undefined,
          requestedQuantity: typeof item.requested_quantity === "number" ? item.requested_quantity : undefined,
          tortilla: item.tortilla === "maiz" || item.tortilla === "harina" || item.tortilla === "mixta" ? item.tortilla : undefined,
        }))
      : [],
    source,
    notes: typeof body.notes === "string" ? body.notes : undefined,
    paymentMethod: body.payment_method === "efectivo" || body.payment_method === "tarjeta" ? body.payment_method : undefined,
    idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
    adultConfirmed: typeof body.adult_confirmed === "boolean" ? body.adult_confirmed : undefined,
    requestedComplements: Array.isArray(body.requested_complements) ? (body.requested_complements as CreateOrderInput["requestedComplements"]) : undefined,
    omitDefaultComplements: Array.isArray(body.omit_default_complements) ? (body.omit_default_complements as CreateOrderInput["omitDefaultComplements"]) : undefined,
    callTranscript: typeof body.call_transcript === "string" ? body.call_transcript : undefined,
    callRecordingUrl: typeof body.call_recording_url === "string" ? body.call_recording_url : undefined,
    // Fase 11 — código de promoción opcional (ver domain-restaurantes/src/
    // promotions.ts); createOrder lo valida/aplica al total real, nunca aquí.
    promoCode: typeof body.promo_code === "string" ? body.promo_code : undefined,
    canal: typeof body.canal === "string" ? (body.canal as CreateOrderInput["canal"]) : undefined,
    colonia: typeof body.colonia_entrega === "string" ? body.colonia_entrega : undefined,
    propina: typeof body.propina === "number" && Number.isFinite(body.propina) ? redondearACentavos(body.propina) : typeof body.propina === "number" ? body.propina : undefined,
    horaRecogida: typeof body.hora_recogida === "string" && body.hora_recogida.trim() !== "" ? body.hora_recogida : undefined,
    doubleSalsas: Array.isArray(body.doble_salsas) ? (body.doble_salsas as CreateOrderInput["doubleSalsas"]) : undefined,
    // Un valor no-string se manda tal cual: `createOrder` lo rechaza con un 400 claro (nunca se ignora en silencio).
    programadoPara: body.programado_para === undefined || body.programado_para === null || (typeof body.programado_para === "string" && body.programado_para.trim() === "") ? undefined : (body.programado_para as string),
  };
}

async function resolveOrganizationOrNotFound(repo: RestaurantesRepository, orgSlug: string) {
  const org = await repo.findOrganizationBySlug(orgSlug);
  if (!org) throw Errors.notFound(`Restaurante "${orgSlug}" no encontrado.`);
  return org;
}

/** Espera maxima en linea de la comanda al POS en el camino de voz (la tool de voz expira a los 4000 ms). */
export const VOICE_COMANDA_INLINE_MS = 1500;

export function restaurantesPublicRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // §4.1 — POST /v1/restaurantes/:orgSlug/orders (== create-order del origen).
  // Ruta pública/de sistema, sin authMiddleware/dbSession -- abre su propia sesión
  // de sistema (`userId: null`), igual que documenta postgres-repository.ts de este
  // paquete.
  app.post("/v1/restaurantes/:orgSlug/orders", async (c) => {
    const incoming = await readJsonCapped<CreateOrderBody>(c.req.raw, 32 * 1024);
    // Sin credenciales de voz no hay checkout web: este pedido solo lo crea la llamada.
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db): Promise<Response> => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      // Token de llamada / secreto de sucursal / secreto legado (ver voice-auth.ts). Un token vencido o invalido
      // responde 401 claro para que el agente escale (QA-PM-R2-reglas-16); nunca se trata como checkout web.
      const voiceAuth = await authenticateVoiceTool(deps, c, repo, org, { tool: "crear_pedido", accept: "legacy_ok" });
      if (!voiceAuth.ok) return voiceAuth.response;

      {
        const { caller } = voiceAuth;
        // Pedido grande: con el autopiloto disponible el pedido se crea `por_aprobar` (la sucursal lo aprueba con un clic); sin el, el aviso de siempre.
        const toolCtx = { ...voiceToolContext(org.id, caller, voiceTurnFromRequest(c)), ...(deps.autopilotoRepo ? { pedidoGrande: crearHookPedidoGrande({ auto: deps.autopilotoRepo(db), repo, db }) } : {}) };
        if (caller.kind === "legacy_secret") {
          const limited = await consumeRateLimit(repo, "create-order", requestActor(c.req.raw, typeof incoming.customer_phone === "string" ? incoming.customer_phone : ""), 120, 60);
          if (!limited.allowed) throw Errors.tooManyRequests();
        } else {
          const limitedResponse = await enforceVoiceLimits(c, repo, org, caller, "crear_pedido");
          if (limitedResponse) return limitedResponse;
        }
        try {
          // Registro único de tools + máquina de estados (cotizado -> confirmado -> creado) y, con token de
          // llamada, teléfono y sucursal tomados del token (nunca del body que escribe el modelo).
          const outcome = await repo.runWithRowSavepoint(() => invokeAgentTool(repo, toolCtx, "crear_pedido", incoming as Record<string, unknown>));
          // Reintento tras un intento incierto: el pedido YA existe (con su comanda y correo encolados la primera vez). Se devuelve con su id
          // para que la llamada cuente el objetivo; no se vuelve a encolar nada.
          if (outcome.yaRegistrado) {
            await auditVoice(repo, org, caller, "crear_pedido", "ok", "ya_registrado");
            return c.json({ order: outcome.raw, ya_registrado: true });
          }
          // Cluster #3 (CRÍTICO) de la auditoría final — `createOrder` ya encoló internamente
          // (best-effort) la confirmación por correo al cliente si dejó correo; disparo inline del
          // drenado, mismo `repo`/transacción, en vez de esperar al cron diario.
          // El correo NO se drena en linea por voz: la tool de voz tiene ~4 s de presupuesto y Resend lento no debe hacer expirar un pedido ya
          // creado. Queda en el outbox y lo envia el cron de correo (red de seguridad).
          // Pedido grande (decision de PM): el servidor NO lo creo, dejo el aviso `pedido_grande` para que la sucursal lo
          // confirme. No hay pedido que correo-notificar ni comanda que encolar; el agente de voz recibe el resultado tal cual.
          if (outcome.orderId === null) {
            await auditVoice(repo, org, caller, "crear_pedido", "ok", "pedido_grande_retenido");
            return c.json(outcome.result);
          }
          // Pedido grande con autopiloto: el pedido SI existe (`por_aprobar`) y su solicitud ya notifico a la sucursal. No hay comanda que encolar ni "recibido" que
          // avisar: ambos salen al aprobarlo con un clic (resolverSolicitudAprobacion).
          if (outcome.pedidoRetenido) {
            await auditVoice(repo, org, caller, "crear_pedido", "ok", "pedido_grande_por_aprobar");
            return c.json(outcome.result);
          }
          await auditVoice(repo, org, caller, "crear_pedido", "ok", null);
          // SoftRestaurant (POS): los pedidos de voz tambien encolan su comanda (igual que antes de
          // fusionar el registro unico de tools). Bandera apagada o sin migracion 024: respuesta identica.
          // OJO (conocido, anterior a R5): `voiceInput.propina` es la propina del BODY (en pesos; 0 si el modelo mando propina_porcentaje); el pedido guarda la propina calculada
          // con el porcentaje. El `Order` del repositorio no expone la propina guardada, asi que la comanda POS puede llevar 0 mientras el pedido guarda el 15 %. Pendiente: exponerla.
          const voiceInput = mapCreateOrderBody(org.id, incoming, "voice");
          // Presupuesto de voz: el POS lento no puede consumir toda la espera de la tool (4 s). Pasado el tope la comanda queda pendiente y
          // el cron del outbox la reintenta (misma ruta que cualquier caida del POS).
          const comanda = await encolarComandaParaPedido({ ...softRestaurantComandaDeps(deps, db, repo), timeoutInlineMs: VOICE_COMANDA_INLINE_MS }, {
            order: outcome.raw as unknown as Parameters<typeof encolarComandaParaPedido>[1]["order"],
            tipo: voiceInput.canal,
            colonia: voiceInput.colonia,
            propina: voiceInput.propina,
          });
          // Autopiloto: confirmacion inmediata al cliente de voz (solo con plantilla aprobada; idempotente por pedido).
          await avisarPedidoRecibido(deps, db, repo, outcome.raw as Order);
          if (comanda.modo === "activo") {
            return c.json({ order: outcome.raw, comanda: { estado: comanda.agente.estado, folio: comanda.agente.folio, mensaje: comanda.agente.mensaje } });
          }
          return c.json({ order: outcome.raw });
        } catch (err) {
          if (err instanceof OrderConflictError) throw Errors.conflict(err.message);
          // QA-PM-R5-reglas-10: una guarda SQL `raise exception ... using errcode = '22023'` (p. ej. "programado_para debe ser una hora futura" por una carrera de segundos
          // con "en 31 minutos") es una regla de negocio con mensaje accionable: 400 de validacion, no 500 "Error interno".
          const reglaSql = esGuardaSqlDeNegocioDePedido(err);
          if (err instanceof OrderValidationError || reglaSql) {
            const code = (err as { code?: unknown }).code;
            await auditVoice(repo, org, caller, "crear_pedido", "denied", typeof code === "string" ? code : "validacion");
            return c.json({ code: "validation_error", message: (err as Error).message }, 400);
          }
          throw err;
        }
      }
    });
  });

  // §4.2 — POST /v1/restaurantes/:orgSlug/customers/lookup (== customer-lookup del
  // origen). Ruta interna, protegida SOLO por x-atiende-tool-secret — es la pieza
  // donde vive la "memoria de cliente" (frequentItems/"lo de siempre"/tier).
  app.post("/v1/restaurantes/:orgSlug/customers/lookup", async (c) => {
    if (!hasVoiceCredentials(c)) throw Errors.unauthorized();

    const { phone } = await readJsonCapped<{ phone?: unknown }>(c.req.raw, 4 * 1024);
    return runVoiceToolRoute(
      deps,
      c,
      c.req.param("orgSlug"),
      { tool: "buscar_cliente", accept: "legacy_ok", legacyLimit: { scope: "customer-lookup", secondary: typeof phone === "string" ? phone : "", max: 30 } },
      async ({ repo, toolCtx, caller, org }) => {
        // Aislamiento entre números: con token de llamada el teléfono sale del TOKEN y se ignora el body
        // (el modelo no puede pedir el historial de otro número). Un secreto de sucursal sin token no
        // identifica a ningún cliente, así que no puede consultar historial por teléfono.
        let lookupPhone = caller.phone;
        if (!lookupPhone) {
          if (caller.kind === "branch_secret") {
            await auditVoice(repo, org, caller, "buscar_cliente", "denied", "historial_requiere_token_de_llamada");
            return c.json({ code: "unauthorized", message: "Consultar el historial requiere el token de la llamada." }, 401);
          }
          // Camino legado (secreto global sin token): teléfono del body, como siempre.
          if (typeof phone !== "string" || !phone.trim() || phone.length > 64) throw Errors.validation("phone es requerido");
          lookupPhone = canonicalizeMexicanPhone(phone);
          if (!lookupPhone) {
            throw Errors.validation("Número inválido. Pide exactamente 10 dígitos, léelos en grupos 3-3-4 y obtén una confirmación explícita antes de volver a buscar.");
          }
        }
        const outcome = await invokeAgentTool(repo, { ...toolCtx, phone: lookupPhone }, "buscar_cliente", {});
        return c.json(outcome.result as object);
      },
    );
  });

  return app;
}

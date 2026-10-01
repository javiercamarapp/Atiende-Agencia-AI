// Rutas públicas/de sistema de restaurantes — port de
// restaurantes/supabase/functions/{create-order,customer-lookup}/index.ts. NINGUNA de
// las dos usa Supabase Auth de usuario (ver diseño Fase 1 §3): create-order es
// checkout web público (sin cuenta) + Server Tool de ElevenLabs; customer-lookup es
// Server Tool de ElevenLabs únicamente. Por eso este grupo se monta SIN
// `authMiddleware`/`requirePropertyMembership` de core-auth, con su propia
// verificación por ruta (CORS + rate limit para web, header
// `x-atiende-tool-secret` para voz) — exactamente como en el origen.
import { Hono } from "hono";
import {
  canonicalizeMexicanPhone,
  consumeRateLimit,
  createOrder,
  invokeAgentTool,
  OrderConflictError,
  OrderValidationError,
} from "@atiende/domain-restaurantes";
import type { CreateOrderInput, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import { encolarComandaParaPedido } from "@atiende/domain-restaurantes/softrestaurant";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";
import { auditVoice, authenticateVoiceTool, enforceVoiceLimits, hasVoiceCredentials } from "./voice-auth.ts";
import { runVoiceToolRoute, voiceToolContext } from "./voice-tools.ts";
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
          tortilla: item.tortilla === "maiz" || item.tortilla === "harina" ? item.tortilla : undefined,
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
    propina: typeof body.propina === "number" ? body.propina : undefined,
  };
}

async function resolveOrganizationOrNotFound(repo: RestaurantesRepository, orgSlug: string) {
  const org = await repo.findOrganizationBySlug(orgSlug);
  if (!org) throw Errors.notFound(`Restaurante "${orgSlug}" no encontrado.`);
  return org;
}

export function restaurantesPublicRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // §4.1 — POST /v1/restaurantes/:orgSlug/orders (== create-order del origen).
  // Ruta pública/de sistema, sin authMiddleware/dbSession -- abre su propia sesión
  // de sistema (`userId: null`), igual que documenta postgres-repository.ts de este
  // paquete.
  app.post("/v1/restaurantes/:orgSlug/orders", async (c) => {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");

    const incoming = await readJsonCapped<CreateOrderBody>(c.req.raw, 32 * 1024);
    const credentialsPresent = hasVoiceCredentials(c);

    // Fase 1: source="voice" queda MODELADO pero INACTIVO en la práctica — el agente
    // de voz ElevenLabs completo está fuera de alcance de esta fase (ver diseño §6).
    // El guard se conserva por paridad de contrato: sin credenciales de voz, un
    // caller no puede declararse "voice" ni recibir el trato de mayor rate limit.
    if (incoming.source === "voice" && !credentialsPresent) throw Errors.unauthorized();
    if (!credentialsPresent && incoming.source && incoming.source !== "web") throw Errors.validation("source inválido");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      // Credenciales de voz presentes: token de llamada / secreto de sucursal / secreto legado
      // (ver voice-auth.ts). Un checkout web sin credenciales sigue el camino web de siempre.
      let voiceAuth: Awaited<ReturnType<typeof authenticateVoiceTool>> | null = null;
      if (credentialsPresent) {
        voiceAuth = await authenticateVoiceTool(deps, c, repo, org, { tool: "crear_pedido", accept: "legacy_ok" });
        if (!voiceAuth.ok) {
          if (incoming.source === "voice") return voiceAuth.response;
          if (incoming.source && incoming.source !== "web") throw Errors.validation("source inválido");
          voiceAuth = null; // credencial inválida en un checkout web: se trata como web, igual que antes.
        }
      }

      if (voiceAuth?.ok) {
        const { caller } = voiceAuth;
        const toolCtx = voiceToolContext(org.id, caller);
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
          // Cluster #3 (CRÍTICO) de la auditoría final — `createOrder` ya encoló internamente
          // (best-effort) la confirmación por correo al cliente si dejó correo; disparo inline del
          // drenado, mismo `repo`/transacción, en vez de esperar al cron diario.
          await triggerRestaurantesEmailDispatchInline(deps, db, repo);
          await auditVoice(repo, org, caller, "crear_pedido", "ok", null);
          // SoftRestaurant (POS): los pedidos de voz tambien encolan su comanda (igual que antes de
          // fusionar el registro unico de tools). Bandera apagada o sin migracion 024: respuesta identica.
          const voiceInput = mapCreateOrderBody(org.id, incoming, "voice");
          const comanda = await encolarComandaParaPedido(softRestaurantComandaDeps(deps, db, repo), {
            order: outcome.raw as unknown as Parameters<typeof encolarComandaParaPedido>[1]["order"],
            tipo: voiceInput.canal,
            colonia: voiceInput.colonia,
            propina: voiceInput.propina,
          });
          if (comanda.modo === "activo") {
            return c.json({ order: outcome.raw, comanda: { estado: comanda.agente.estado, folio: comanda.agente.folio, mensaje: comanda.agente.mensaje } });
          }
          return c.json({ order: outcome.raw });
        } catch (err) {
          if (err instanceof OrderConflictError) throw Errors.conflict(err.message);
          if (err instanceof OrderValidationError) {
            const code = (err as { code?: unknown }).code;
            await auditVoice(repo, org, caller, "crear_pedido", "denied", typeof code === "string" ? code : "validacion");
            return c.json({ code: "validation_error", message: err.message }, 400);
          }
          throw err;
        }
      }

      const input = mapCreateOrderBody(org.id, incoming, "web");
      const limited = await consumeRateLimit(repo, "create-order", requestActor(c.req.raw, ""), 10, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const order = await createOrder(repo, input);
        await triggerRestaurantesEmailDispatchInline(deps, db, repo);
        // SoftRestaurant (POS): punto de enganche. Con la bandera APAGADA (default) o sin la
        // migracion 024 no hace nada y la respuesta es EXACTAMENTE la de antes. Nunca lanza
        // ni cambia el resultado del pedido (ver softrestaurant/outbox-service.ts).
        const comanda = await encolarComandaParaPedido(softRestaurantComandaDeps(deps, db, repo), { order, tipo: input.canal, colonia: input.colonia, propina: input.propina });
        if (comanda.modo === "activo") {
          // El agente solo puede decir un folio si el POS lo devolvio; si no, "pendiente de confirmar".
          return c.json({ order, comanda: { estado: comanda.agente.estado, folio: comanda.agente.folio, mensaje: comanda.agente.mensaje } });
        }
        return c.json({ order });
      } catch (err) {
        if (err instanceof OrderConflictError) throw Errors.conflict(err.message);
        if (err instanceof OrderValidationError) throw Errors.validation(err.message);
        throw err;
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

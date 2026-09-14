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
  lookupCustomer,
  OrderConflictError,
  OrderValidationError,
} from "@atiende/domain-restaurantes";
import type { CreateOrderInput, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
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
}

function mapCreateOrderBody(organizationId: string, body: CreateOrderBody, source: "web" | "voice"): CreateOrderInput {
  return {
    organizationId,
    branchSlug: typeof body.branch_slug === "string" ? body.branch_slug : undefined,
    branchName: typeof body.branch_name === "string" ? body.branch_name : undefined,
    customerName: typeof body.customer_name === "string" ? body.customer_name : "",
    customerPhone: typeof body.customer_phone === "string" ? body.customer_phone : "",
    customerAddress: typeof body.customer_address === "string" ? body.customer_address : undefined,
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
    const toolAuthorized = secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret);

    // Fase 1: source="voice" queda MODELADO pero INACTIVO en la práctica — el agente
    // de voz ElevenLabs completo está fuera de alcance de esta fase (ver diseño §6).
    // El guard se conserva por paridad de contrato: sin el secreto del tool, un
    // caller no puede declararse "voice" ni recibir el trato de mayor rate limit.
    if (incoming.source === "voice" && !toolAuthorized) throw Errors.unauthorized();
    if (!toolAuthorized && incoming.source && incoming.source !== "web") throw Errors.validation("source inválido");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));
      const input = mapCreateOrderBody(org.id, incoming, toolAuthorized ? "voice" : "web");

      const limited = await consumeRateLimit(repo, "create-order", requestActor(c.req.raw, toolAuthorized ? input.customerPhone : ""), toolAuthorized ? 120 : 10, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const order = await createOrder(repo, input);
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
    if (!secretMatches(c.req.raw, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();

    const { phone } = await readJsonCapped<{ phone?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof phone !== "string" || !phone.trim() || phone.length > 64) throw Errors.validation("phone es requerido");

    const canonicalPhone = canonicalizeMexicanPhone(phone);
    if (!canonicalPhone) {
      throw Errors.validation("Número inválido. Pide exactamente 10 dígitos, léelos en grupos 3-3-4 y obtén una confirmación explícita antes de volver a buscar.");
    }

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(repo, "customer-lookup", requestActor(c.req.raw, phone), 30, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const result = await lookupCustomer(repo, org.id, canonicalPhone);
      return c.json(result);
    });
  });

  return app;
}

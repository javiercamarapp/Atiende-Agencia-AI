// Fase 2 §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs
// (`buscar_sucursal_cercana`/`buscar_producto`/`cotizar_pedido`). Port del
// envoltorio HTTP delgado de
// restaurantes/supabase/functions/{buscar-sucursal-cercana,buscar-producto,cotizar-pedido}/index.ts
// — la lógica real de negocio ya vive en @atiende/domain-restaurantes
// (Fase 1 + Fase 2 §1.1.1/§1.3), este archivo solo la expone por HTTP.
//
// Mismo patrón de auth que create-order/customer-lookup (public.ts): NI
// `authMiddleware` NI `originAllowed` — ElevenLabs no manda `Origin` ni
// `Authorization`, solo el secreto dedicado `x-atiende-tool-secret`. La nota
// real de `verify_jwt=false` del origen es un detalle de plataforma de
// Supabase Edge Functions sin equivalente aquí, pero el principio que
// documenta (ElevenLabs no manda Authorization) es exactamente lo que
// `x-atiende-tool-secret` ya resuelve.
//
// Se monta como su propio sub-Hono (en vez de extender public.ts) para que
// el árbol de archivos deje claro qué endpoints son Server Tools de voz.
import { Hono } from "hono";
import { consumeRateLimit, findNearestBranch, OrderValidationError, quoteOrder, searchProducts } from "@atiende/domain-restaurantes";
import type { RequestedOrderItemInput } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

async function resolveOrganizationOrNotFound(deps: AppDeps, orgSlug: string) {
  const org = await deps.restaurantesRepo.findOrganizationBySlug(orgSlug);
  if (!org) throw Errors.notFound(`Restaurante "${orgSlug}" no encontrado.`);
  return org;
}

function requireVoiceToolSecret(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-tool-secret", deps.env.voiceToolSecret)) throw Errors.unauthorized();
}

interface QuoteItemBody {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

function mapQuoteItems(raw: unknown): RequestedOrderItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as QuoteItemBody;
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      requestedQuantity: typeof item.requested_quantity === "number" ? item.requested_quantity : Number(item.requested_quantity),
      tortilla: item.tortilla === "maiz" || item.tortilla === "harina" ? item.tortilla : undefined,
    };
  });
}

export function restaurantesVoiceToolsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // §1.1 — POST /v1/restaurantes/:orgSlug/branches/nearest (buscar_sucursal_cercana).
  // Única de las 3 con negocio genuinamente nuevo (nearest-branch.ts, §1.1.1):
  // matching de colonia contra `restaurantes.known_zone` de ESTA organización
  // + distancia Haversine real. Cero-match real -> encontrada:false, NUNCA se
  // inventa/adivina una sucursal.
  app.post("/v1/restaurantes/:orgSlug/branches/nearest", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const org = await resolveOrganizationOrNotFound(deps, c.req.param("orgSlug"));
    const { colonia } = await readJsonCapped<{ colonia?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof colonia !== "string" || !colonia.trim() || colonia.length > 160) throw Errors.validation("colonia es requerido");

    const limited = await consumeRateLimit(deps.restaurantesRepo, "voice-branches-nearest", requestActor(c.req.raw, colonia), 60, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const match = await findNearestBranch(deps.restaurantesRepo, { organizationId: org.id, colonia });
    if (!match.found) return c.json({ encontrada: false, mensaje: match.message });
    return c.json({ encontrada: true, branch_slug: match.branchSlug, branch_name: match.branchName, distancia_km: match.distanceKm, colonia_reconocida: match.recognizedZoneName });
  });

  // §1.2 — POST /v1/restaurantes/:orgSlug/products/search (buscar_producto).
  // Reutiliza 100% `searchProducts` (Fase 1) — branch_slug sigue siendo
  // obligatorio: si falta o no existe, error explícito 400, nunca cae en
  // silencio a una sucursal default (bug real corregido 3-sep-2026 en el
  // origen: hardcode silencioso a `fco-montejo`).
  app.post("/v1/restaurantes/:orgSlug/products/search", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const org = await resolveOrganizationOrNotFound(deps, c.req.param("orgSlug"));
    const { query, branch_slug: branchSlug } = await readJsonCapped<{ query?: unknown; branch_slug?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof query !== "string" || !query.trim() || query.length > 160) throw Errors.validation("query es requerido");
    if (typeof branchSlug !== "string" || !branchSlug.trim() || branchSlug.length > 100) {
      throw Errors.validation("branch_slug es requerido — confirma la sucursal antes de buscar productos");
    }

    const limited = await consumeRateLimit(deps.restaurantesRepo, "voice-products-search", requestActor(c.req.raw, branchSlug), 120, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const branch = await deps.restaurantesRepo.findBranch(org.id, { slug: branchSlug });
    if (!branch) throw Errors.validation(`Sucursal '${branchSlug}' no encontrada`);

    const productos = await searchProducts(deps.restaurantesRepo, { propertyId: branch.propertyId, query });
    return c.json({
      productos: productos.map((p) => ({ id: p.id, name: p.name, price: p.price, pack_size: p.packSize, requires_adult_confirmation: p.requiresAdultConfirmation })),
    });
  });

  // §1.3 — POST /v1/restaurantes/:orgSlug/orders/quote (cotizar_pedido).
  // Reutiliza en su mayoría `buildOrderQuoteFromProducts` (Fase 1) vía el
  // wrapper `quoteOrder` (Fase 2, orders.ts) — la guardia anti-alucinación de
  // precio/pack_size/tortilla/mayoría-de-edad vive ahí completa y no cambia
  // una línea. Respuesta: el `OrderQuote` real tal cual (lines/total/
  // containsAlcohol) — el LLM debe leer este resultado y repetirlo, nunca
  // calcular él mismo.
  app.post("/v1/restaurantes/:orgSlug/orders/quote", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const org = await resolveOrganizationOrNotFound(deps, c.req.param("orgSlug"));
    const body = await readJsonCapped<{ branch_slug?: unknown; items?: unknown; adult_confirmed?: unknown }>(c.req.raw, 24 * 1024);
    const branchSlug = typeof body.branch_slug === "string" ? body.branch_slug : "";
    if (!branchSlug.trim()) throw Errors.validation("branch_slug es requerido");

    const limited = await consumeRateLimit(deps.restaurantesRepo, "voice-orders-quote", requestActor(c.req.raw, branchSlug), 120, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    try {
      const quote = await quoteOrder(deps.restaurantesRepo, {
        organizationId: org.id,
        branchSlug,
        items: mapQuoteItems(body.items),
        adultConfirmed: body.adult_confirmed === true,
      });
      return c.json({ quote });
    } catch (err) {
      if (err instanceof OrderValidationError) throw Errors.validation(err.message);
      throw err;
    }
  });

  return app;
}

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
import { consumeRateLimit, findNearestBranch, OrderValidationError, quoteOrder, searchProducts } from "@atiende/domain-restaurantes";
import type { RequestedOrderItemInput, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

async function resolveOrganizationOrNotFound(repo: RestaurantesRepository, orgSlug: string) {
  const org = await repo.findOrganizationBySlug(orgSlug);
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
    const { colonia } = await readJsonCapped<{ colonia?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof colonia !== "string" || !colonia.trim() || colonia.length > 160) throw Errors.validation("colonia es requerido");

    // Sub-Hono propio sin authMiddleware/dbSession -- abre su propia sesión de
    // sistema (`userId: null`), igual que public.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(repo, "voice-branches-nearest", requestActor(c.req.raw, colonia), 60, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const match = await findNearestBranch(repo, { organizationId: org.id, colonia });
      if (!match.found) return c.json({ encontrada: false, mensaje: match.message });
      return c.json({ encontrada: true, branch_slug: match.branchSlug, branch_name: match.branchName, distancia_km: match.distanceKm, colonia_reconocida: match.recognizedZoneName });
    });
  });

  // §1.2 — POST /v1/restaurantes/:orgSlug/products/search (buscar_producto).
  // Reutiliza 100% `searchProducts` (Fase 1) — branch_slug sigue siendo
  // obligatorio: si falta o no existe, error explícito 400, nunca cae en
  // silencio a una sucursal default (bug real corregido 3-sep-2026 en el
  // origen: hardcode silencioso a `fco-montejo`).
  app.post("/v1/restaurantes/:orgSlug/products/search", async (c) => {
    requireVoiceToolSecret(deps, c.req.raw);
    const { query, branch_slug: branchSlug } = await readJsonCapped<{ query?: unknown; branch_slug?: unknown }>(c.req.raw, 8 * 1024);
    if (typeof query !== "string" || !query.trim() || query.length > 160) throw Errors.validation("query es requerido");
    if (typeof branchSlug !== "string" || !branchSlug.trim() || branchSlug.length > 100) {
      throw Errors.validation("branch_slug es requerido — confirma la sucursal antes de buscar productos");
    }

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(repo, "voice-products-search", requestActor(c.req.raw, branchSlug), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      const branch = await repo.findBranch(org.id, { slug: branchSlug });
      if (!branch) throw Errors.validation(`Sucursal '${branchSlug}' no encontrada`);

      const productos = await searchProducts(repo, { propertyId: branch.propertyId, query });
      return c.json({
        productos: productos.map((p) => ({ id: p.id, name: p.name, price: p.price, pack_size: p.packSize, requires_adult_confirmation: p.requiresAdultConfirmation })),
      });
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
    const body = await readJsonCapped<{ branch_slug?: unknown; items?: unknown; adult_confirmed?: unknown }>(c.req.raw, 24 * 1024);
    const branchSlug = typeof body.branch_slug === "string" ? body.branch_slug : "";
    if (!branchSlug.trim()) throw Errors.validation("branch_slug es requerido");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrganizationOrNotFound(repo, c.req.param("orgSlug"));

      const limited = await consumeRateLimit(repo, "voice-orders-quote", requestActor(c.req.raw, branchSlug), 120, 60);
      if (!limited.allowed) throw Errors.tooManyRequests();

      try {
        const quote = await quoteOrder(repo, {
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
  });

  return app;
}

// Storefront PUBLICO de restaurantes (R-09): menu, cotizacion, confirmacion, creacion de pedido y rastreo
// por token. SIN login para el cliente: igual que el checkout web de public.ts, este grupo se monta sin
// `authMiddleware` y abre su propia sesion de sistema (`userId: null`); su defensa es CORS por origen,
// limite de tasa por IP + sesion, validacion estricta de entradas y el aislamiento por organizacion.
//
// El pedido NO se arma aqui: reutiliza el registro unico de tools con canal "web"
// (cotizar_pedido -> confirmar_resumen -> crear_pedido, misma maquina de estados del servidor que voz y
// WhatsApp), asi que las reglas duras de PM (horario/doble turno, minimo a domicilio, zona, alcohol solo al
// recoger, propina solo con tarjeta) viven en un solo lugar. Los precios SIEMPRE salen de la base: lo que
// mande el navegador nunca fija un total. Pago en sucursal (efectivo/tarjeta): no hay pasarela.
//
// Compatibilidad con la base sin migrar: el menu, la politica y el flujo degradan con SAVEPOINT en el
// repositorio; el rastreo (migracion 032) responde `disponible: false` si la funcion aun no existe. Nada
// de esto devuelve 500 por una base vieja.
//
// Consentimiento: el POST de pedido exige `acepta_aviso_privacidad: true` (400 `aviso_privacidad_requerido` si falta) y, ya creado
// el pedido, guarda la evidencia (version del aviso, fecha, canal) con `PrivacidadRepository.recordOrderPrivacyConsent` (migracion 042).
import { Hono } from "hono";
import type { Context } from "hono";
import {
  OrderConflictError,
  OrderFlowViolationError,
  OrderValidationError,
  buildStorefrontBranches,
  buildStorefrontMenu,
  consumeRateLimit,
  invokeAgentTool,
  previewPromotion,
} from "@atiende/domain-restaurantes";
import type { AgentToolContext, CanalPedido, Order, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { encolarComandaParaPedido } from "@atiende/domain-restaurantes/softrestaurant";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import { issueStorefrontTrackingToken, storefrontTrackingKey, verifyStorefrontTrackingToken } from "../../../storefront-tracking-token.ts";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import { softRestaurantComandaDeps } from "./softrestaurant-wiring.ts";
import type { AppDeps } from "../../../deps.ts";

/** Identificador de la sesion de compra (lo genera el navegador): fija el estado cotizar/confirmar/crear. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const QUOTE_HASH_RE = /^[0-9a-f]{32}$/;
const MAX_ITEMS = 50;

interface StorefrontItemBody {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

interface StorefrontBody {
  readonly session_id?: unknown;
  readonly items?: unknown;
  readonly canal?: unknown;
  readonly colonia_entrega?: unknown;
  readonly payment_method?: unknown;
  readonly adult_confirmed?: unknown;
  readonly promo_code?: unknown;
  readonly quote_hash?: unknown;
  readonly customer_name?: unknown;
  readonly customer_phone?: unknown;
  readonly customer_email?: unknown;
  readonly customer_address?: unknown;
  readonly notes?: unknown;
  readonly propina?: unknown;
  /** Aceptacion del aviso de privacidad (casilla del checkout): sin `true` el servidor no crea el pedido. */
  readonly acepta_aviso_privacidad?: unknown;
}

const noStore = (c: Context) => c.header("Cache-Control", "no-store");

/** Solo se reenvian al registro de tools los campos conocidos y con tipo correcto (nada de pasar el body entero). */
function cleanItems(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) throw Errors.validation("El carrito debe tener entre 1 y 50 productos.");
  return (raw as StorefrontItemBody[]).map((item) => {
    if (!item || typeof item !== "object") throw Errors.validation("Producto inválido en el carrito.");
    return {
      product_id: typeof item.product_id === "string" ? item.product_id.slice(0, 64) : undefined,
      product_name: typeof item.product_name === "string" ? item.product_name.slice(0, 240) : undefined,
      requested_quantity: typeof item.requested_quantity === "number" ? item.requested_quantity : undefined,
      tortilla: item.tortilla === "maiz" || item.tortilla === "harina" || item.tortilla === "mixta" ? item.tortilla : undefined,
    };
  });
}

function sessionIdOf(body: StorefrontBody): string {
  if (typeof body.session_id !== "string" || !SESSION_ID_RE.test(body.session_id)) throw Errors.validation("session_id inválido.");
  return body.session_id;
}

function webContext(organizationId: string, sessionId: string): AgentToolContext {
  return { organizationId, channel: "web", phone: null, flow: { key: `web:${sessionId}`, turn: null } };
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length <= max ? v : undefined;
}

export function restaurantesStorefrontRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const trackingKey = storefrontTrackingKey(deps.env.internalSecret);

  async function resolveOrg(repo: RestaurantesRepository, orgSlug: string) {
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) throw Errors.notFound("Restaurante no encontrado.");
    return org;
  }

  async function limitOrThrow(repo: RestaurantesRepository, c: Context, scope: string, max: number, secondary = "") {
    // Bucket solo por IP: el tope real anti-abuso. session_id lo elige el cliente, asi que rotarlo
    // NO debe dar un bucket nuevo (mismo criterio que el checkout publico existente, public.ts).
    const byIp = await consumeRateLimit(repo, scope, requestActor(c.req.raw, ""), max, 60);
    if (!byIp.allowed) throw Errors.tooManyRequests();
    // Bucket adicional por IP + sesion: solo suma un tope por sesion, nunca sustituye al de IP.
    if (secondary) {
      const bySession = await consumeRateLimit(repo, `${scope}-session`, requestActor(c.req.raw, secondary), max, 60);
      if (!bySession.allowed) throw Errors.tooManyRequests();
    }
  }

  async function registrarConsentimiento(db: Parameters<typeof deps.restaurantesRepo>[0], repo: RestaurantesRepository, organizationId: string, orderId: string): Promise<void> {
    const privacidad = deps.privacidadRepo?.(db);
    if (!privacidad) return;
    try {
      await repo.runWithRowSavepoint(() => privacidad.recordOrderPrivacyConsent(organizationId, orderId, "web"));
    } catch (err) {
      console.error("storefront: no se pudo guardar el consentimiento del aviso de privacidad (el pedido ya existe):", err instanceof Error ? err.message : err);
    }
  }

  function assertOrigin(c: Context) {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
  }

  // GET /v1/restaurantes/:orgSlug/storefront -- el restaurante y sus sucursales activas.
  app.get("/v1/restaurantes/:orgSlug/storefront", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120);
      return c.json({ restaurante: { slug: org.slug, nombre: org.name }, sucursales: await buildStorefrontBranches(repo, org.id) });
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/:branchSlug/menu -- menu por categorias con precios y disponibilidad en vivo.
  app.get("/v1/restaurantes/:orgSlug/storefront/:branchSlug/menu", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120);
      const branch = await repo.findBranch(org.id, { slug: c.req.param("branchSlug") });
      if (!branch || branch.status !== "active") throw Errors.notFound("Sucursal no encontrada.");
      const [sucursal] = (await buildStorefrontBranches(repo, org.id)).filter((b) => b.slug === branch.slug);
      return c.json({ sucursal: sucursal ?? null, categorias: await buildStorefrontMenu(repo, branch.propertyId) });
    });
  });

  // POST .../quote -- cotiza el carrito (tool cotizar_pedido) y, si hay codigo, la vista previa del descuento.
  app.post("/v1/restaurantes/:orgSlug/storefront/:branchSlug/quote", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<StorefrontBody>(c.req.raw, 24 * 1024);
    const sessionId = sessionIdOf(body);
    const items = cleanItems(body.items);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-quote", 60, sessionId);
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, webContext(org.id, sessionId), "cotizar_pedido", {
            branch_slug: c.req.param("branchSlug"),
            items,
            adult_confirmed: body.adult_confirmed === true,
            canal: body.canal,
            colonia_entrega: str(body.colonia_entrega, 200),
            payment_method: body.payment_method,
          }),
        );
        const result = outcome.result as { quote: unknown; quote_hash?: string };
        let promo: Awaited<ReturnType<typeof previewPromotion>> | null = null;
        const code = str(body.promo_code, 40);
        if (code && code.trim()) {
          const raw = outcome.raw as { total: number; lines: ReadonlyArray<{ productId: string; name: string; price: number; quantity: number }> };
          const branch = await repo.findBranch(org.id, { slug: c.req.param("branchSlug") });
          if (branch) {
            promo = await previewPromotion(repo, {
              organizationId: org.id,
              propertyId: branch.propertyId,
              rawCode: code,
              canal: (body.canal === "recoger" ? "recoger" : "domicilio") as CanalPedido,
              total: raw.total,
              items: raw.lines.map((l) => ({ id: l.productId, name: l.name, price: l.price, quantity: l.quantity })),
            });
          }
        }
        return c.json({ quote: result.quote, quote_hash: result.quote_hash ?? null, promo });
      } catch (err) {
        if (err instanceof OrderValidationError) return c.json({ code: "validation_error", message: err.message, ...(err instanceof OrderFlowViolationError ? { motivo: err.code } : {}) }, 400);
        throw err;
      }
    });
  });

  // POST .../confirm -- el cliente confirmo el resumen (tool confirmar_resumen).
  app.post("/v1/restaurantes/:orgSlug/storefront/:branchSlug/confirm", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<StorefrontBody>(c.req.raw, 4 * 1024);
    const sessionId = sessionIdOf(body);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-quote", 60, sessionId);
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, webContext(org.id, sessionId), "confirmar_resumen", { quote_hash: typeof body.quote_hash === "string" && QUOTE_HASH_RE.test(body.quote_hash) ? body.quote_hash : undefined }),
        );
        return c.json(outcome.result as object);
      } catch (err) {
        if (err instanceof OrderValidationError) return c.json({ code: "validation_error", message: err.message, ...(err instanceof OrderFlowViolationError ? { motivo: err.code } : {}) }, 400);
        throw err;
      }
    });
  });

  // POST .../orders -- crea el pedido (tool crear_pedido) y encola la comanda a SoftRestaurant.
  app.post("/v1/restaurantes/:orgSlug/storefront/:branchSlug/orders", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<StorefrontBody>(c.req.raw, 32 * 1024);
    const sessionId = sessionIdOf(body);
    const items = cleanItems(body.items);
    // El checkout web exige la aceptacion del aviso de privacidad EN EL SERVIDOR (la casilla de la interfaz no basta):
    // sin ella no se toca la base ni se crea nada. Debe ser el booleano `true`, no un texto ni un numero.
    if (body.acepta_aviso_privacidad !== true) {
      return c.json({ code: "validation_error", message: "Para hacer tu pedido debes aceptar el aviso de privacidad.", motivo: "aviso_privacidad_requerido" }, 400);
    }
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-order", 10, sessionId);
      const ctx = webContext(org.id, sessionId);
      const canal = body.canal === "recoger" ? "recoger" : body.canal === undefined ? undefined : (body.canal as CanalPedido);
      const quoteHash = typeof body.quote_hash === "string" && QUOTE_HASH_RE.test(body.quote_hash) ? body.quote_hash : null;
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, ctx, "crear_pedido", {
            branch_slug: c.req.param("branchSlug"),
            customer_name: str(body.customer_name, 160),
            customer_phone: str(body.customer_phone, 64),
            customer_email: str(body.customer_email, 320),
            customer_address: str(body.customer_address, 1000),
            items,
            notes: str(body.notes, 2000),
            payment_method: body.payment_method,
            adult_confirmed: body.adult_confirmed === true,
            canal,
            colonia_entrega: str(body.colonia_entrega, 200),
            promo_code: str(body.promo_code, 40),
            propina: typeof body.propina === "number" ? body.propina : undefined,
            idempotency_key: quoteHash ? `storefront:${sessionId}:${quoteHash}` : undefined,
          }),
        );
        const order = outcome.raw as Order;
        // Evidencia del consentimiento (version del aviso vigente, fecha, canal `web`; sin PII). Best-effort con SAVEPOINT: base sin la
        // migracion 042 -> "no_disponible"; cualquier otro fallo se registra y NUNCA tumba un pedido ya creado.
        await registrarConsentimiento(db, repo, org.id, order.id);
        // Correo de confirmacion (si el cliente dejo correo) y comanda al POS: best-effort, nunca cambian el pedido.
        await triggerRestaurantesEmailDispatchInline(deps, db, repo);
        const comanda = await encolarComandaParaPedido(softRestaurantComandaDeps(deps, db, repo), {
          order,
          tipo: canal === "recoger" ? "recoger" : "domicilio",
          colonia: str(body.colonia_entrega, 200),
          propina: typeof body.propina === "number" ? body.propina : undefined,
        });
        return c.json({
          rastreo_token: issueStorefrontTrackingToken(trackingKey, org.id, order.id),
          estado: order.status,
          total: order.total,
          canal: canal === "recoger" ? "recoger" : "domicilio",
          sucursal: order.branch,
          comanda: comanda.modo === "activo" ? { estado: comanda.agente.estado, folio: comanda.agente.folio, mensaje: comanda.agente.mensaje } : null,
        });
      } catch (err) {
        if (err instanceof OrderFlowViolationError && err.code === "pedido_ya_creado") {
          // Doble envio (reintento de red, doble clic): el pedido ya existe; se devuelve su rastreo en vez de un error.
          const snap = await repo.readOrderFlow(org.id, ctx.flow!.key);
          const orderId = snap?.context?.orderId;
          if (orderId) return c.json({ ya_registrado: true, rastreo_token: issueStorefrontTrackingToken(trackingKey, org.id, orderId) });
        }
        if (err instanceof OrderConflictError) throw Errors.conflict(err.message);
        if (err instanceof OrderValidationError) return c.json({ code: "validation_error", message: err.message, ...(err instanceof OrderFlowViolationError ? { motivo: err.code } : {}) }, 400);
        throw err;
      }
    });
  });

  // GET .../storefront/track/:token -- estado del pedido por token firmado (sin datos personales).
  app.get("/v1/restaurantes/:orgSlug/storefront/track/:token", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-track", 60);
      const verified = verifyStorefrontTrackingToken(trackingKey, c.req.param("token"));
      // Token invalido, vencido, de otra organizacion o de un pedido que no existe: la MISMA respuesta (sin oraculo).
      if (!verified.ok || verified.claims.org !== org.id) throw Errors.notFound("No encontramos ese pedido.");
      const result = await repo.findStorefrontOrderTracking(org.id, verified.claims.ord);
      if (!result.disponible) return c.json({ disponible: false, mensaje: "El rastreo en línea todavía no está disponible. Llama a la sucursal para conocer el estado de tu pedido." });
      if (!result.pedido) throw Errors.notFound("No encontramos ese pedido.");
      return c.json({ disponible: true, pedido: result.pedido });
    });
  });

  return app;
}

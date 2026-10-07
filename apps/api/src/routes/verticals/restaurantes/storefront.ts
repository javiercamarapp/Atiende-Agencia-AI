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
// el pedido, guarda la evidencia (version del aviso, fecha, canal) con `PrivacidadRepository.recordOrderPrivacyConsent` (migracion 063).
import { Hono } from "hono";
import type { Context } from "hono";
import {
  OrderConflictError,
  OrderFlowViolationError,
  MARCA_VACIA,
  OrderValidationError,
  StorefrontValidationError,
  buildStorefrontBranches,
  buildStorefrontDirectorio,
  buildStorefrontMenu,
  buildStorefrontPromociones,
  consumeRateLimit,
  invokeAgentTool,
  previewPromotion,
  registerCallbackRequest,
  redondearACentavos,
  registrarConsentimientoMarketing,
  seccionEncargados,
  sugerirSucursalPorColonia,
  sugerirSucursalPorUbicacion,
  validarSolicitudEvento,
} from "@atiende/domain-restaurantes";
import type { AgentToolContext, CanalPedido, Order, RestaurantesRepository } from "@atiende/domain-restaurantes";
import { encolarComandaParaPedido, type ResultadoEncolarPedido } from "@atiende/domain-restaurantes/softrestaurant";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import { issueStorefrontTrackingToken, storefrontTrackingKey, verifyStorefrontTrackingToken } from "../../../storefront-tracking-token.ts";
import { efectosPostCommitDePedido } from "./efectos-post-commit.ts";
import { avisarPedidoRecibido } from "./autopiloto-recibido.ts";
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
  /** Casilla OPCIONAL y desmarcada de promociones por WhatsApp: solo el booleano `true` registra el consentimiento de marketing. */
  readonly acepta_promociones?: unknown;
  readonly programado_para?: unknown;
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

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Texto libre del cliente: un valor que pasa del tope se RECHAZA con un 400 que nombra el campo; nunca se descarta
 * en silencio (el pedido nacia sin las notas de alergia y con un enganoso "falta direccion"). */
function strOrReject(v: unknown, max: number, etiqueta: string): string | undefined {
  if (typeof v === "string" && v.length > max) throw Errors.validation(`${etiqueta} excede el máximo de ${max} caracteres.`);
  return typeof v === "string" ? v : undefined;
}

/** Los pedidos programados existen en el backend, pero este menu en linea no tiene (todavia) selector de fecha:
 * un `programado_para` se rechaza de forma explicita en vez de ignorarse y mandar el pedido a cocina de inmediato. */
function rejectProgramado(body: StorefrontBody): void {
  if (body.programado_para !== undefined && body.programado_para !== null) {
    throw Errors.validation("Los pedidos programados todavía no se pueden hacer desde el menú en línea. Llama a la sucursal para programar tu pedido.");
  }
}

/** Dinero a centavos: una fraccion de centavo no existe (se guardaba 10.555 y la nota imprimia $10.55). */
function propinaDe(v: unknown): number | undefined {
  return typeof v === "number" ? redondearACentavos(v) : undefined;
}

const PEDIDO_YA_REGISTRADO = "Este pedido ya quedó registrado con otros datos. Revisa su estado en el rastreo; si necesitas cambiar algo, llama a la sucursal.";

export function restaurantesStorefrontRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const trackingKey = storefrontTrackingKey(deps.env.internalSecret);

  async function resolveOrg(repo: RestaurantesRepository, orgSlug: string) {
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) throw Errors.notFound("Restaurante no encontrado.");
    return org;
  }

  async function limitOrThrow(repo: RestaurantesRepository, c: Context, scope: string, max: number, organizationId: string, secondary = "") {
    // Bucket por IP + RESTAURANTE: el tope real anti-abuso. La organizacion forma parte de la llave porque una IP
    // compartida (CGNAT de redes moviles, wifi de una plaza) agotaba el cupo de TODOS los restaurantes a la vez.
    // session_id lo elige el cliente, asi que rotarlo NO debe dar un bucket nuevo (mismo criterio que el checkout
    // publico existente, public.ts); la organizacion sale del slug de la ruta, no del cuerpo.
    const byIp = await consumeRateLimit(repo, scope, requestActor(c.req.raw, organizationId), max, 60);
    if (!byIp.allowed) throw Errors.tooManyRequests();
    // Bucket adicional por IP + sesion: solo suma un tope por sesion, nunca sustituye al de IP.
    if (secondary) {
      const bySession = await consumeRateLimit(repo, `${scope}-session`, requestActor(c.req.raw, `${organizationId}:${secondary}`), max, 60);
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

  /** Pedido ya registrado en esta sesion (reintento tras una respuesta perdida, doble clic): se devuelve el rastreo
   * del pedido existente en vez de crear otro o dejar al cliente sin saber que su pedido SI quedo. */
  function yaRegistrado(orgId: string, err: unknown): { rastreo_token: string } | null {
    if (!(err instanceof OrderFlowViolationError) || err.code !== "pedido_ya_creado" || !err.orderId) return null;
    return { rastreo_token: issueStorefrontTrackingToken(trackingKey, orgId, err.orderId) };
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
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const sucursales = await buildStorefrontBranches(repo, org.id);
      // R-38: marca (portada, logo, redes) y promociones que el motor aplica solas. La marca es `null` si nunca se guardo o si la base
      // aun no tiene la migracion 062 (la pagina cae a una portada generica con el nombre); nada de esto vuelve a la ruta un 500.
      const marca = await repo.findStorefrontMarca(org.id);
      const branches = (await repo.listBranchesForOrganizationAdmin(org.id)).filter((b) => b.status === "active");
      const promociones = await buildStorefrontPromociones(repo, org.id, branches.map((b) => ({ slug: b.slug, propertyId: b.propertyId })));
      return c.json({ restaurante: { slug: org.slug, nombre: org.name }, sucursales, marca: marca ?? { ...MARCA_VACIA }, promociones });
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/sitemap.xml -- sitemap de las paginas indexables del restaurante (R-38): la pagina
  // de inicio, cada sucursal activa y el formulario de eventos. Nunca incluye rastreo ni checkout (noindex).
  app.get("/v1/restaurantes/:orgSlug/storefront/sitemap.xml", async (c) => {
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const sucursales = (await repo.listBranchesForOrganizationAdmin(org.id)).filter((b) => b.status === "active");
      const base = `${deps.env.appBaseUrl}/pedir/${encodeURIComponent(org.slug)}`;
      const rutas = [base, `${base}/eventos`, ...sucursales.map((b) => `${base}/${encodeURIComponent(b.slug)}`)];
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rutas.map((r) => `  <url><loc>${escapeXml(r)}</loc></url>`).join("\n")}\n</urlset>\n`;
      c.header("Cache-Control", "public, max-age=3600");
      return c.body(xml, 200, { "Content-Type": "application/xml; charset=utf-8" });
    });
  });

  // POST /v1/restaurantes/:orgSlug/storefront/eventos -- solicitud publica de evento/catering (R-43). Crea una solicitud de contacto
  // (callback_requests) con motivo 'evento' y canal 'web' que aparece en la bandeja del panel y avisa al personal. Defensas: CORS por
  // origen, limite de tasa por IP y por IP + telefono, cuerpo acotado, validacion estricta y honeypot sin captcha: un bot que llena el
  // campo oculto `sitio_web` recibe el MISMO exito pero no se crea nada.
  app.post("/v1/restaurantes/:orgSlug/storefront/eventos", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-evento", 5, org.id);
      if (typeof body.sitio_web === "string" && body.sitio_web.trim() !== "") return c.json({ recibido: true });
      try {
        const branch = typeof body.sucursal === "string" ? await repo.findBranch(org.id, { slug: body.sucursal }) : null;
        const zona = resolverZonaHorariaNegocio(branch ? (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria : null);
        const solicitud = validarSolicitudEvento(body, hoyFechaNegocio(zona));
        if (!branch || branch.status !== "active") throw new StorefrontValidationError("Elige una sucursal disponible.");
        // Tope por persona, independiente de la IP: el mismo telefono no abre mas de 3 solicitudes por hora en este restaurante
        // (reintentos y doble clic incluidos; rotar de IP no da cupo nuevo).
        const porTelefono = await consumeRateLimit(repo, "storefront-evento-telefono", `${org.id}:${solicitud.telefono}`, 3, 3600);
        if (!porTelefono.allowed) throw Errors.tooManyRequests();
        // SAVEPOINT propio: contra una base sin la migracion 062 el registro falla (sin la funcion de sistema, el INSERT directo no tiene
        // permiso, SQLSTATE 42501) y esa transaccion unica del request quedaria abortada: con el savepoint el 503 honesto se entrega.
        const creada = await repo.runWithRowSavepoint(() =>
          registerCallbackRequest(repo, {
            organizationId: org.id,
            propertyId: branch.propertyId,
            customerName: solicitud.nombre,
            customerPhone: solicitud.telefono,
            reason: "evento",
            message: solicitud.mensaje,
            source: "web",
          }),
        );
        return c.json({ recibido: true, solicitud: creada.id });
      } catch (err) {
        if (err instanceof StorefrontValidationError) return c.json({ code: "validation_error", message: err.message }, 400);
        const code = (err as { code?: string } | null)?.code;
        if (code === "42501" || code === "42883" || code === "42P01" || code === "42703") {
          return c.json({ code: "service_unavailable", message: "Las solicitudes de evento todavía no están disponibles en línea. Llama a la sucursal para cotizar tu evento." }, 503);
        }
        throw err;
      }
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/directorio -- directorio publico: TODAS las sucursales visibles
  // (activas o solo informativas) con direccion, telefono, horario e insignias. Solo campos publicos.
  app.get("/v1/restaurantes/:orgSlug/storefront/directorio", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      return c.json({ restaurante: { slug: org.slug, nombre: org.name }, sucursales: await buildStorefrontDirectorio(repo, org.id) });
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/zonas -- nombres de las colonias/zonas conocidas (autocompletar de "¿Dónde está?").
  // Solo nombres: nada de coordenadas ni ids.
  app.get("/v1/restaurantes/:orgSlug/storefront/zonas", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const nombres = (await repo.listKnownZones(org.id)).map((z) => z.name).sort((a, b) => a.localeCompare(b, "es"));
      return c.json({ zonas: nombres.slice(0, 500) });
    });
  });

  // POST /v1/restaurantes/:orgSlug/storefront/sucursal-sugerida -- sucursal sugerida por colonia {colonia} o por ubicacion {lat, lng}.
  // POST y no GET a proposito: las coordenadas viajan en el cuerpo (no en la URL, que queda en los registros) y NUNCA se guardan ni se
  // escriben en logs; se usan solo para calcular la distancia.
  app.post("/v1/restaurantes/:orgSlug/storefront/sucursal-sugerida", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<{ colonia?: unknown; lat?: unknown; lng?: unknown }>(c.req.raw, 2 * 1024);
    const colonia = strOrReject(body.colonia, 120, "La colonia");
    const tieneUbicacion = body.lat !== undefined || body.lng !== undefined;
    if (!colonia && !tieneUbicacion) throw Errors.validation("Indique una colonia o permita su ubicación.");
    if (tieneUbicacion && (typeof body.lat !== "number" || typeof body.lng !== "number" || !Number.isFinite(body.lat) || !Number.isFinite(body.lng) || Math.abs(body.lat) > 90 || Math.abs(body.lng) > 180)) {
      throw Errors.validation("La ubicación no es válida.");
    }
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const sugerencia = colonia ? await sugerirSucursalPorColonia(repo, org.id, colonia) : await sugerirSucursalPorUbicacion(repo, org.id, { lat: body.lat as number, lng: body.lng as number });
      return c.json({ sugerencia });
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/privacidad -- seccion "Encargados y transferencias" del aviso (BORRADOR pendiente de
  // revision legal): proveedores que de verdad usa la organizacion segun su configuracion (canal de WhatsApp conectado, voz habilitada).
  app.get("/v1/restaurantes/:orgSlug/storefront/privacidad", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const whatsappConectado = (await repo.getWhatsappChannelConfig(org.id)).phoneNumberId !== null;
      let vozHabilitada = false;
      if (deps.vozRepo) {
        const voz = deps.vozRepo(db);
        for (const branch of (await repo.listBranchesForOrganizationAdmin(org.id)).filter((b) => b.status === "active")) {
          const lectura = await voz.getConfig(branch.propertyId);
          if (lectura.disponible && lectura.valor.habilitado) {
            vozHabilitada = true;
            break;
          }
        }
      }
      return c.json({ encargados: seccionEncargados({ whatsappConectado, vozHabilitada }) });
    });
  });

  // GET /v1/restaurantes/:orgSlug/storefront/:branchSlug/menu -- menu por categorias con precios y disponibilidad en vivo.
  app.get("/v1/restaurantes/:orgSlug/storefront/:branchSlug/menu", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-read", 120, org.id);
      const branch = await repo.findBranch(org.id, { slug: c.req.param("branchSlug") });
      if (!branch || branch.status !== "active") throw Errors.notFound("Sucursal no encontrada.");
      const [sucursal] = (await buildStorefrontBranches(repo, org.id)).filter((b) => b.slug === branch.slug);
      // La marca viaja tambien aqui: logo, redes y la imagen del Open Graph de la pagina de la sucursal (null si no hay o falta la 062).
      const marca = await repo.findStorefrontMarca(org.id);
      return c.json({ sucursal: sucursal ?? null, categorias: await buildStorefrontMenu(repo, branch.propertyId), marca: marca ?? { ...MARCA_VACIA } });
    });
  });

  // POST .../quote -- cotiza el carrito (tool cotizar_pedido) y, si hay codigo, la vista previa del descuento.
  app.post("/v1/restaurantes/:orgSlug/storefront/:branchSlug/quote", async (c) => {
    noStore(c);
    assertOrigin(c);
    const body = await readJsonCapped<StorefrontBody>(c.req.raw, 24 * 1024);
    const sessionId = sessionIdOf(body);
    rejectProgramado(body);
    const items = cleanItems(body.items);
    const coloniaEntrega = strOrReject(body.colonia_entrega, 200, "La colonia");
    const codigoPromo = strOrReject(body.promo_code, 40, "El código de promoción");
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-quote", 60, org.id, sessionId);
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, webContext(org.id, sessionId), "cotizar_pedido", {
            branch_slug: c.req.param("branchSlug"),
            items,
            adult_confirmed: body.adult_confirmed === true,
            canal: body.canal,
            colonia_entrega: coloniaEntrega,
            payment_method: body.payment_method,
          }),
        );
        const result = outcome.result as { quote: unknown; quote_hash?: string };
        let promo: Awaited<ReturnType<typeof previewPromotion>> | null = null;
        const code = codigoPromo;
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
        const previo = yaRegistrado(org.id, err);
        if (previo) return c.json({ code: "conflict", message: (err as Error).message, motivo: "pedido_ya_creado", ya_registrado: true, ...previo }, 409);
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
      await limitOrThrow(repo, c, "storefront-quote", 60, org.id, sessionId);
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, webContext(org.id, sessionId), "confirmar_resumen", { quote_hash: typeof body.quote_hash === "string" && QUOTE_HASH_RE.test(body.quote_hash) ? body.quote_hash : undefined }),
        );
        return c.json(outcome.result as object);
      } catch (err) {
        const previo = yaRegistrado(org.id, err);
        if (previo) return c.json({ code: "conflict", message: (err as Error).message, motivo: "pedido_ya_creado", ya_registrado: true, ...previo }, 409);
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
    rejectProgramado(body);
    const items = cleanItems(body.items);
    // El checkout web exige la aceptacion del aviso de privacidad EN EL SERVIDOR (la casilla de la interfaz no basta):
    // sin ella no se toca la base ni se crea nada. Debe ser el booleano `true`, no un texto ni un numero.
    if (body.acepta_aviso_privacidad !== true) {
      return c.json({ code: "validation_error", message: "Para hacer tu pedido debes aceptar el aviso de privacidad.", motivo: "aviso_privacidad_requerido" }, 400);
    }
    const cliente = {
      nombre: strOrReject(body.customer_name, 160, "El nombre"),
      telefono: strOrReject(body.customer_phone, 64, "El teléfono"),
      correo: strOrReject(body.customer_email, 320, "El correo"),
      direccion: strOrReject(body.customer_address, 1000, "La dirección"),
      notas: strOrReject(body.notes, 2000, "Las notas"),
      colonia: strOrReject(body.colonia_entrega, 200, "La colonia"),
      promo: strOrReject(body.promo_code, 40, "El código de promoción"),
      propina: propinaDe(body.propina),
    };
    // La transaccion SOLO crea el pedido y ENCOLA sus efectos (correo en el outbox, comanda del POS con envio diferido).
    // Los efectos externos corren DESPUES del COMMIT (ver efectos-post-commit.ts): un COMMIT que no llega ya no deja
    // un correo ni una comanda de un pedido inexistente.
    const transaccion = await deps.engine.withAppSession({ userId: null }, async (db): Promise<{ readonly respuesta: Response } | { readonly order: Order; readonly orgId: string; readonly encolada: ResultadoEncolarPedido }> => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-order", 10, org.id, sessionId);
      const ctx = webContext(org.id, sessionId);
      const canal = body.canal === "recoger" ? "recoger" : body.canal === undefined ? undefined : (body.canal as CanalPedido);
      const quoteHash = typeof body.quote_hash === "string" && QUOTE_HASH_RE.test(body.quote_hash) ? body.quote_hash : null;
      try {
        const outcome = await repo.runWithRowSavepoint(() =>
          invokeAgentTool(repo, ctx, "crear_pedido", {
            branch_slug: c.req.param("branchSlug"),
            customer_name: cliente.nombre,
            customer_phone: cliente.telefono,
            customer_email: cliente.correo,
            customer_address: cliente.direccion,
            items,
            notes: cliente.notas,
            payment_method: body.payment_method,
            adult_confirmed: body.adult_confirmed === true,
            canal,
            colonia_entrega: cliente.colonia,
            promo_code: cliente.promo,
            propina: cliente.propina,
            idempotency_key: quoteHash ? `storefront:${sessionId}:${quoteHash}` : undefined,
          }),
        );
        const order = outcome.raw as Order;
        // Evidencia del consentimiento (version del aviso vigente, fecha, canal `web`; sin PII). Best-effort con SAVEPOINT: base sin la
        // migracion 063 -> "no_disponible"; cualquier otro fallo se registra y NUNCA tumba un pedido ya creado.
        await registrarConsentimiento(db, repo, org.id, order.id);
        // Casilla opcional de promociones por WhatsApp (autopiloto 2): evidencia con fecha, fuente `checkout_web` y la version del aviso que decide
        // la base. Best-effort en su propio SAVEPOINT: base sin la migracion 052 -> "no_disponible"; nunca tumba un pedido ya creado.
        if (body.acepta_promociones === true && order.customerId) {
          await registrarConsentimientoMarketing(db, { organizationId: org.id, customerId: order.customerId, otorgar: true, fuente: "checkout_web" });
        }
        const encolada = await encolarComandaParaPedido(softRestaurantComandaDeps(deps, db, repo), {
          order,
          tipo: canal === "recoger" ? "recoger" : "domicilio",
          colonia: cliente.colonia,
          propina: cliente.propina,
          envioEnLinea: false,
        });
        // Autopiloto: "Recibimos su pedido #folio, tiempo estimado X" por WhatsApp (solo con plantilla aprobada; idempotente por pedido).
        await avisarPedidoRecibido(deps, db, repo, order);
        return { order, orgId: org.id, encolada };
      } catch (err) {
        if (err instanceof OrderFlowViolationError && err.code === "pedido_ya_creado") {
          // Doble envio (reintento de red, doble clic): el pedido ya existe; se devuelve su rastreo en vez de un error.
          const orderId = err.orderId ?? (await repo.readOrderFlow(org.id, ctx.flow!.key))?.context?.orderId;
          if (orderId) return { respuesta: c.json({ ya_registrado: true, rastreo_token: issueStorefrontTrackingToken(trackingKey, org.id, orderId) }) };
        }
        // La llave de idempotencia ya se uso con otro contenido (p. ej. se corrigio la direccion tras perder la
        // respuesta): el pedido original SI existe. Mensaje para el cliente en espanol, no el texto interno del motor.
        if (err instanceof OrderConflictError) throw Errors.conflict(PEDIDO_YA_REGISTRADO);
        if (err instanceof OrderValidationError) return { respuesta: c.json({ code: "validation_error", message: err.message, ...(err instanceof OrderFlowViolationError ? { motivo: err.code } : {}) }, 400) };
        throw err;
      }
    });
    if ("respuesta" in transaccion) return transaccion.respuesta;
    const { order, orgId, encolada } = transaccion;
    const comanda = await efectosPostCommitDePedido(deps, encolada);
    return c.json({
      rastreo_token: issueStorefrontTrackingToken(trackingKey, orgId, order.id),
      estado: order.status,
      total: order.total,
      canal: body.canal === "recoger" ? "recoger" : "domicilio",
      sucursal: order.branch,
      comanda,
    });
  });

  // GET .../storefront/track/:token -- estado del pedido por token firmado (sin datos personales).
  app.get("/v1/restaurantes/:orgSlug/storefront/track/:token", async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const org = await resolveOrg(repo, c.req.param("orgSlug"));
      await limitOrThrow(repo, c, "storefront-track", 60, org.id);
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

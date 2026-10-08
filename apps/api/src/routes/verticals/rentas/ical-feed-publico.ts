// Paridad3 Rn-13 -- el camino recomendado es GET /rentas/feed/:token.ics (token opaco y rotable, límite por token); el de
// abajo por UUID queda DEPRECADO (ver el comentario del límite más abajo).
//
// Fase 5 -- GET /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed.ics:
// exportación PÚBLICA del feed iCal de disponibilidad de una unidad, para que
// Airbnb/Booking/VRBO/etc. importen la disponibilidad real de rentas. SIN
// authMiddleware/dbSession de staff a propósito -- un feed iCal de canal es SIEMPRE
// una URL pública sin autenticación (así es como cualquier plataforma de renta
// vacacional expone su calendario de disponibilidad hoy en la práctica: es
// información de disponibilidad -- qué noches están ocupadas--, nunca información de
// negocio sensible como nombre de huésped, precio o datos de contacto; ver
// domain-rentas/src/ical/exportador.ts, "nunca con datos de huésped"). Mismo criterio
// de sesión "de sistema" que las rutas públicas de citas/restaurantes
// (`engine.withAppSession({ userId: null }, ...)`), nunca `requirePropertyMembership`.
//
// `:canalCodigo` es parte de la ruta (no un query param) para que cada canal reciba su
// propio feed con su propia numeración de SEQUENCE y bookkeeping de anti-eco (ver
// domain-rentas/src/sync/motor.ts::exportarFeedParaUnidad) -- prácticas reales de PMS
// generan un enlace de exportación distinto por plataforma exactamente por esta razón
// (reconciliación/anti-eco por canal), aunque el contenido de disponibilidad sea
// equivalente.
import { Hono } from "hono";
import type { Context } from "hono";
import { etagDeFeedIcs, exportarFeedParaUnidad, extraerTokenDeSegmento, hashesFeedIguales, hashTokenFeed } from "@atiende/domain-rentas";
import { ApiError } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../../../errors.ts";
import { requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

// Hallazgo de auditoría (rubro 10, "performance y escalabilidad", severidad MEDIA):
// "feed iCal público de rentas sin rate-limit ejecuta 3+2N queries por request" --
// esta ruta es pública/sin auth por diseño (ver comentario de arriba), así que un
// scraper enumerando unidadId/canalCodigo desde una sola IP puede disparar cómputo/queries
// sin freno.
//
// Paridad3 (Rn-13): ese límite era de 30 consultas cada 5 min POR IP, y las OTA (Airbnb, Booking,
// Vrbo) consultan desde rangos de IP compartidos: una gestora con 40 unidades x 3 canales podía recibir
// más de 30 consultas de la misma IP en 5 minutos, la OTA recibía un 429, no actualizaba la
// disponibilidad y la noche no se cerraba (riesgo de overbooking). Ahora hay DOS caminos:
//   - URL con TOKEN (`GET /rentas/feed/:token.ics`, la recomendada): el límite se aplica POR TOKEN
//     (12 por minuto) y por IP solo hay un tope alto (600 cada 5 min) contra scrapers, que ninguna OTA
//     legítima alcanza. El token es opaco (256 bits), se guarda solo su hash y se puede rotar.
//   - URL por UUID (`.../feed.ics`, DEPRECADA): sigue respondiendo durante la ventana de migración, con
//     encabezado `Deprecation`, y su tope por IP sube a 600 cada 5 min por la misma razón. El riesgo de
//     mantenerla (la URL no se puede rotar; adivinarla exige acertar dos UUID v4, 244 bits) queda
//     documentado en docs/DEPLOY.md. Se apaga con RENTAS_ICAL_FEED_UUID_LEGACY=off; por omisión NO se
//     apaga (apagarla obliga a cada gestora a pegar la URL nueva en cada OTA).
const ICAL_FEED_IP_RATE_LIMIT = { max: 600, windowMs: 5 * 60_000 } as const;
const ICAL_FEED_TOKEN_RATE_LIMIT = { max: 12, windowMs: 60_000 } as const;

const CACHE_CONTROL_FEED = "max-age=300"; // 5 min: sin `public`/`s-maxage` el CDN no lo guarda, así cada consulta de la OTA llega a nuestro límite por token y registra su último acceso.

/** El switch de la URL por UUID: encendido salvo que RENTAS_ICAL_FEED_UUID_LEGACY valga "off" (o "0"/"false"). */
export function feedUuidLegacyActivo(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const valor = env.RENTAS_ICAL_FEED_UUID_LEGACY?.trim().toLowerCase();
  return !(valor === "off" || valor === "0" || valor === "false");
}

/** Responde el .ics con ETag estable; 304 si la OTA ya tiene esta versión. */
function responderFeed(c: Context, contenidoIcs: string, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  const etag = etagDeFeedIcs(contenidoIcs);
  c.header("ETag", etag);
  c.header("Cache-Control", CACHE_CONTROL_FEED);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  for (const [k, v] of Object.entries(extraHeaders)) c.header(k, v);
  const candidatos = (c.req.header("if-none-match") ?? "").split(",").map((x) => x.trim().replace(/^W\//, ""));
  if (candidatos.includes(etag) || candidatos.includes("*")) return c.body(null, 304);
  c.header("Content-Type", "text/calendar; charset=utf-8");
  return c.body(contenidoIcs);
}

async function limitarPorIp(c: Context): Promise<void> {
  const permitido = await rateLimit(`rentas:ical-feed:${requestActor(c.req.raw)}`, ICAL_FEED_IP_RATE_LIMIT.max, ICAL_FEED_IP_RATE_LIMIT.windowMs, {
    category: "rentas:ical-feed-publico",
  });
  if (!permitido) throw Errors.tooManyRequests("Demasiadas solicitudes al feed de disponibilidad. Intenta de nuevo en unos minutos.");
}

export function rentasIcalFeedPublicoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // Paridad3 Rn-13 -- feed por TOKEN. Sesión de sistema (auth.uid() NULL), igual que la ruta por UUID: es una URL pública
  // de disponibilidad (nunca datos de huésped), el secreto es el token. Orden: tope por IP -> forma del token (sin tocar la
  // base) -> tope por token -> resolver el hash -> comparar en tiempo constante -> exportar.
  app.get("/rentas/feed/:archivo", async (c) => {
    await limitarPorIp(c);

    const token = extraerTokenDeSegmento(c.req.param("archivo"));
    if (token === null) throw Errors.notFound("Feed no encontrado.");
    const hash = hashTokenFeed(token);

    // El límite se cuenta por HASH del token (nunca el valor en claro en una llave de memoria o de log).
    const permitido = await rateLimit(`rentas:ical-feed-token:${hash}`, ICAL_FEED_TOKEN_RATE_LIMIT.max, ICAL_FEED_TOKEN_RATE_LIMIT.windowMs, {
      category: "rentas:ical-feed-token",
    });
    if (!permitido) throw Errors.tooManyRequests("Demasiadas solicitudes a este feed. La OTA debe consultarlo a lo más una vez por minuto.");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const syncRepo = deps.rentasCalendarSyncRepo(db);
      const resuelto = await syncRepo.resolverFeedToken(hash);
      // Base sin la migración 037: ningún token puede existir todavía -> 404 (la URL por UUID sigue funcionando).
      if (!resuelto.disponible || resuelto.token === null || !hashesFeedIguales(resuelto.token.tokenHash, hash)) throw Errors.notFound("Feed no encontrado.");
      const t = resuelto.token;
      const feed = await exportarFeedParaUnidad(
        { syncRepo, organizationId: t.organizationId, propertyId: t.propertyId, unidadId: t.unidadId, canalId: t.canalId },
        `Disponibilidad — ${t.unidadId}`,
      );
      return responderFeed(c, feed.contenidoIcs);
    });
  });

  // Feed por UUID (DEPRECADO). `:canalCodigo` es parte de la ruta (no un query param) para que cada canal reciba su propio
  // feed con su propia numeración de SEQUENCE y bookkeeping de anti-eco.
  app.get("/rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed.ics", async (c) => {
    if (!feedUuidLegacyActivo()) {
      throw new ApiError(410, "gone", "Esta URL de exportación ya no está activa. Copia la URL con token desde Sincronización de calendario y pégala de nuevo en el canal.");
    }
    await limitarPorIp(c);

    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const canalCodigo = c.req.param("canalCodigo");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const rentasRepo = deps.rentasRepo(db);
      const unidad = await rentasRepo.findUnidad(propertyId, unidadId);
      if (!unidad) throw Errors.notFound("Unidad no encontrada.");
      const canal = await rentasRepo.findCanalPorCodigo(canalCodigo);
      if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no reconocido.`);

      const syncRepo = deps.rentasCalendarSyncRepo(db);
      const feed = await exportarFeedParaUnidad({ syncRepo, organizationId: unidad.organizationId, propertyId, unidadId, canalId: canal.id }, `Disponibilidad — ${unidadId}`);
      // `Deprecation: true` (RFC 9745): la OTA/cliente sabe que esta URL será retirada; sin fecha porque la decide el dueño del producto.
      return responderFeed(c, feed.contenidoIcs, { Deprecation: "true", "X-Atiende-Aviso": "URL deprecada: usa la URL con token de Sincronizacion de calendario." });
    });
  });

  return app;
}

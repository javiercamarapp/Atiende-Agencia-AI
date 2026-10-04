// Encuesta post-entrega, lado PUBLICO del cliente (R-41, migracion 041). Sin login: la liga que recibio por WhatsApp lleva un token firmado
// (organizacion + pedido, vence a los 14 dias) y nada personal.
//   GET  /v1/restaurantes/:orgSlug/encuesta/:token   estado de la encuesta: sucursal, si ya respondio, liga de resenas si aplica
//   POST /v1/restaurantes/:orgSlug/encuesta/:token   { calificacion 1-5, comentario? } -> la PRIMERA respuesta gana (reintento = ya_respondida)
// Token invalido, vencido, de otra organizacion o de un pedido sin encuesta: la MISMA respuesta 404 (sin oraculo). Con calificacion <= 2 se
// emite una notificacion in-app al owner/admin (sin PII, una por pedido, best-effort). Base SIN migrar: `disponible: false` (nunca un 500).
import { Hono } from "hono";
import type { Context } from "hono";
import { emitirNotificacion } from "@atiende/db";
import {
  ENCUESTA_CALIFICACION_BAJA_MAX,
  EncuestaValidationError,
  consumeRateLimit,
  normalizarComentario,
  validarCalificacion,
} from "@atiende/domain-restaurantes";
import type { RestaurantesRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor } from "../../../http-security.ts";
import { encuestaTokenKey, verifyEncuestaToken } from "../../../encuesta-token.ts";
import type { AppDeps } from "../../../deps.ts";

const noStore = (c: Context) => c.header("Cache-Control", "no-store");
const MENSAJE_NO_DISPONIBLE = "La encuesta todavía no está disponible. ¡Gracias por tu pedido!";

export function restaurantesEncuestaPublicaRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const key = encuestaTokenKey(deps.env.internalSecret);
  const path = "/v1/restaurantes/:orgSlug/encuesta/:token";

  async function limitOrThrow(repo: RestaurantesRepository, c: Context, scope: string, max: number) {
    // Bucket solo por IP (el tope real anti-abuso); el token no da un bucket nuevo.
    const r = await consumeRateLimit(repo, scope, requestActor(c.req.raw, ""), max, 60);
    if (!r.allowed) throw Errors.tooManyRequests();
  }

  /** Resuelve organizacion + pedido del token. Cualquier fallo es el mismo 404. */
  async function resolver(repo: RestaurantesRepository, c: Context): Promise<{ organizationId: string; orderId: string }> {
    const org = await repo.findOrganizationBySlug(c.req.param("orgSlug") ?? "");
    const verified = verifyEncuestaToken(key, c.req.param("token") ?? "");
    if (!org || !verified.ok || verified.claims.org !== org.id) throw Errors.notFound("No encontramos esa encuesta.");
    return { organizationId: org.id, orderId: verified.claims.ord };
  }

  function repoDeEncuesta(db: Parameters<NonNullable<AppDeps["encuestaRepo"]>>[0]) {
    if (!deps.encuestaRepo) throw Errors.serviceUnavailable("La encuesta post-entrega no está disponible en este despliegue.");
    return deps.encuestaRepo(db);
  }

  app.get(path, async (c) => {
    noStore(c);
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      await limitOrThrow(repo, c, "encuesta-leer", 60);
      const { organizationId, orderId } = await resolver(repo, c);
      const lectura = await repoDeEncuesta(db).publica(organizationId, orderId);
      if (!lectura.disponible) return c.json({ disponible: false, mensaje: MENSAJE_NO_DISPONIBLE });
      if (!lectura.valor) throw Errors.notFound("No encontramos esa encuesta.");
      return c.json({ disponible: true, encuesta: lectura.valor });
    });
  });

  app.post(path, async (c) => {
    noStore(c);
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
    const body = await readJsonCapped<{ calificacion?: unknown; comentario?: unknown }>(c.req.raw, 8 * 1024);
    let calificacion: number;
    let comentario: string | null;
    try {
      calificacion = validarCalificacion(body.calificacion);
      comentario = normalizarComentario(body.comentario);
    } catch (err) {
      if (err instanceof EncuestaValidationError) throw Errors.validation(err.message);
      throw err;
    }
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      await limitOrThrow(repo, c, "encuesta-responder", 10);
      const { organizationId, orderId } = await resolver(repo, c);
      const lectura = await repoDeEncuesta(db).responder(organizationId, orderId, calificacion, comentario);
      if (!lectura.disponible) return c.json({ disponible: false, mensaje: MENSAJE_NO_DISPONIBLE }, 503);
      const r = lectura.valor;
      if (!r || r.estado === "no_encontrada") throw Errors.notFound("No encontramos esa encuesta.");
      if (r.estado === "registrada" && r.calificacion !== null && r.calificacion <= ENCUESTA_CALIFICACION_BAJA_MAX) {
        // "Algo que atender": una calificacion baja avisa a owner/admin (sin PII; dedupe por pedido; dentro de un SAVEPOINT, nunca rompe la respuesta).
        await emitirNotificacion(db, {
          evento: "restaurantes.encuesta.calificacion_baja",
          organizationId,
          propertyId: r.propertyId,
          clave: orderId,
          entidadTipo: "encuesta_entrega",
          entidadId: orderId,
        });
      }
      return c.json({ disponible: true, estado: r.estado, calificacion: r.calificacion, resenasUrl: r.resenasUrl }, r.estado === "registrada" ? 201 : 200);
    });
  });

  return app;
}

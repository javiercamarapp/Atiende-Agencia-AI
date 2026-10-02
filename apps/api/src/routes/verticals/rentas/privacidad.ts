// Rn-07 -- solicitudes ARCO (acceso, rectificacion, cancelacion, oposicion) de rentas. El admin de la gestora REGISTRA la
// solicitud que el titular le hace por correo, telefono o en persona y la mueve de estado; los plazos (20 + 15 dias de
// calendario) los calcula la base (migracion rentas 028, rentas.arco_solicitud / arco_registrar / arco_cambiar_estado).
// Documentacion operativa, NO asesoria legal.
//
//   GET   /rentas/:propertyId/privacidad/solicitudes              lista paginada (+ plazo calculado)
//   POST  /rentas/:propertyId/privacidad/solicitudes              registra una solicitud (idempotente por contacto + derecho)
//   GET   /rentas/:propertyId/privacidad/solicitudes/:id/eventos  bitacora de una solicitud
//   PATCH /rentas/:propertyId/privacidad/solicitudes/:id/estado   en_proceso | bloqueada | resuelta | rechazada
//
// Solo admin_gestora (contiene datos de contacto de titulares; la RLS de 028 lo vuelve a exigir). La solicitud es de la
// ORGANIZACION (sale de la sesion), no de la propiedad. Base sin migrar: la lista responde `disponible:false` y las
// escrituras 503 explicito, nunca un 500 ni una lista vacia que parezca real. Al registrar emite el aviso in-app
// `rentas.privacidad.arco_registrada` (sin PII: solo el id de la solicitud como clave de dedupe).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  ARCO_DERECHOS,
  ARCO_ESTADOS,
  ARCO_PLAZO_EJECUCION_DIAS,
  ARCO_PLAZO_RESPUESTA_DIAS,
  PRIVACIDAD_ROLES,
  PostgresRentasPrivacidadRepository,
  folioArco,
  plazoArco,
  validarCambioEstadoArco,
  validarSolicitudArco,
} from "@atiende/domain-rentas";
import type { ArcoDerecho, ArcoEstado, RentasPrivacidadRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function entero(raw: string | undefined, campo: string, min: number, max: number, defecto: number): number {
  if (raw === undefined) return defecto;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

export function rentasPrivacidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = (db: Parameters<AppDeps["rentasRepo"]>[0]): RentasPrivacidadRepository => (deps.rentasPrivacidadRepo ? deps.rentasPrivacidadRepo(db) : new PostgresRentasPrivacidadRepository(db));
  const base = "/rentas/:propertyId/privacidad/solicitudes";
  app.use(`${base}`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const limit = entero(c.req.query("limit"), "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
    const offset = entero(c.req.query("offset"), "offset", 0, 1_000_000, 0);
    const estado = c.req.query("estado");
    if (estado !== undefined && !(ARCO_ESTADOS as readonly string[]).includes(estado)) throw Errors.validation(`estado: se esperaba uno de ${ARCO_ESTADOS.join(", ")}.`);
    const derecho = c.req.query("derecho");
    if (derecho !== undefined && !(ARCO_DERECHOS as readonly string[]).includes(derecho)) throw Errors.validation(`derecho: se esperaba uno de ${ARCO_DERECHOS.join(", ")}.`);

    const pagina = await repo(c.get("db")).listar(c.get("organizationId") as string, { estado: (estado as ArcoEstado | undefined) ?? null, derecho: (derecho as ArcoDerecho | undefined) ?? null }, { limit, offset });
    const ahora = new Date();
    return c.json(
      {
        disponible: pagina.disponible,
        total: pagina.total,
        nextOffset: pagina.nextOffset,
        plazos: { respuestaDias: ARCO_PLAZO_RESPUESTA_DIAS, ejecucionDias: ARCO_PLAZO_EJECUCION_DIAS },
        items: pagina.items.map((s) => ({ ...s, folio: folioArco(s.id), plazo: plazoArco(s, ahora) })),
      },
      200,
    );
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const v = validarSolicitudArco(await readJsonCapped(c.req.raw, 8 * 1024));
    if (!v.ok) throw Errors.validation(v.error);
    const organizationId = c.get("organizationId") as string;
    const db = c.get("db");
    const r = await repo(db).registrar(organizationId, v.valor);
    switch (r.outcome) {
      case "created":
      case "existing": {
        if (r.outcome === "created") {
          await emitirNotificacion(db, { evento: "rentas.privacidad.arco_registrada", organizationId, propertyId: c.req.param("propertyId"), clave: r.id, entidadTipo: "arco_solicitud", entidadId: r.id });
          logEvent(c, "info", "rentas_arco_registrada", { solicitudId: r.id, derecho: v.valor.derecho, canal: v.valor.canal });
        }
        return c.json({ id: r.id, folio: folioArco(r.id), creada: r.outcome === "created" }, r.outcome === "created" ? 201 : 200);
      }
      case "forbidden":
        throw Errors.forbidden();
      case "invalid_input":
        throw Errors.validation("Parametros invalidos para registrar la solicitud.");
      case "unavailable":
        throw Errors.serviceUnavailable("Las solicitudes ARCO de rentas todavia no estan disponibles en este ambiente (migracion pendiente).");
    }
  });

  app.get(`${base}/:solicitudId/eventos`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const id = c.req.param("solicitudId");
    if (!UUID_RE.test(id)) throw Errors.validation("solicitudId invalido.");
    const eventos = await repo(c.get("db")).listarEventos(c.get("organizationId") as string, id);
    if (eventos === null) return c.json({ disponible: false, items: [] }, 200);
    return c.json({ disponible: true, items: eventos.map((e) => ({ id: e.id, evento: e.evento, desde: e.desde, hacia: e.hacia, nota: e.nota, creadoEn: e.creadoEn })) }, 200);
  });

  app.patch(`${base}/:solicitudId/estado`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const id = c.req.param("solicitudId");
    if (!UUID_RE.test(id)) throw Errors.validation("solicitudId invalido.");
    const v = validarCambioEstadoArco(await readJsonCapped(c.req.raw, 4 * 1024));
    if (!v.ok) throw Errors.validation(v.error);
    const r = await repo(c.get("db")).cambiarEstado(c.get("organizationId") as string, id, v.valor.estado, v.valor.nota);
    switch (r.outcome) {
      case "updated":
        logEvent(c, "info", "rentas_arco_estado", { solicitudId: id, estado: r.estado });
        return c.json({ id: r.id, estado: r.estado }, 200);
      case "not_found":
        throw Errors.notFound("Solicitud no encontrada.");
      case "invalid_transition":
        throw Errors.conflict("Esa solicitud no puede pasar a ese estado desde su estado actual.");
      case "invalid_input":
        throw Errors.validation("Parametros invalidos para actualizar la solicitud.");
      case "forbidden":
        throw Errors.forbidden();
      case "unavailable":
        throw Errors.serviceUnavailable("Las solicitudes ARCO de rentas todavia no estan disponibles en este ambiente (migracion pendiente).");
    }
  });

  return app;
}

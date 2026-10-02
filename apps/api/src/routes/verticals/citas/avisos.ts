// C-16 -- Centro de avisos de citas (panel). Una sola pantalla con lo que hay que atender HOY, con datos reales:
//   * citas por confirmar (pendientes que empiezan en las proximas 72 h),
//   * estado de entrega de los recordatorios de 24 h (agotados/fallidos) -- solo owner/admin,
//   * escalaciones de crisis con su seguimiento -- solo owner/admin (son datos de salud).
//
//   GET  /v1/citas/properties/:propertyId/admin/avisos
//   POST /v1/citas/properties/:propertyId/admin/escalaciones/:escalationId/seguimiento   { estado: in_progress|resolved, nota? }
//
// Compatibilidad con la base sin migrar: cada bloque corre dentro de su propio SAVEPOINT en el repositorio y responde un estado honesto
// (`disponible:false`, `seguimientoDisponible:false`) en vez de un 500 o de una lista vacia que parezca real; el POST responde 503
// explicito. Nunca se hace Promise.all sobre la sesion (una sola transaccion por request): todo es secuencial.
// Privacidad: el telefono de la persona que escribio una crisis sale ENMASCARADO y el extracto del mensaje no sale nunca.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ESCALACION_SEGUIMIENTO_DESTINOS } from "@atiende/domain-citas";
import type { CitasRole, EscalacionSeguimientoDestino } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const ROLES_SEGUIMIENTO: readonly CitasRole[] = ["owner", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTA_MAX = 500;
const HORAS_POR_CONFIRMAR = 72;
const DIAS_ATRAS_RECORDATORIOS = 7;
const MAX_POR_CONFIRMAR = 20;

/** "***1234": solo los ultimos 4 digitos; el resto del telefono nunca sale del servidor hacia este panel. */
export function enmascararTelefono(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  return digitos.length <= 4 ? "***" : `***${digitos.slice(-4)}`;
}

export function citasAvisosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/citas/properties/:propertyId/admin";
  app.use(`${base}/avisos`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/escalaciones/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(`${base}/avisos`, async (c) => {
    const organizationId = c.get("organizationId");
    const repo = deps.citasRepo(c.get("db"));
    const role = c.get("verticalRole") as CitasRole | undefined;
    const puedeVerSensibles = role !== undefined && ROLES_SEGUIMIENTO.includes(role);
    const ahora = Date.now();

    // 1) Citas por confirmar. Secuencial (misma sesion). Solo lectura de tablas existentes desde 001: no depende de ninguna migracion.
    const desde = new Date(ahora).toISOString();
    const hasta = new Date(ahora + HORAS_POR_CONFIRMAR * 3_600_000).toISOString();
    const enVentana = await repo.listAppointmentsInRange(organizationId, desde, hasta, undefined, 500);
    const pendientes = enVentana.filter((a) => a.status === "pending");
    const visibles = pendientes.slice(0, MAX_POR_CONFIRMAR);
    const proveedores = visibles.length ? await repo.findProvidersByIds(organizationId, [...new Set(visibles.map((a) => a.providerId))]) : [];
    const servicios = visibles.length ? await repo.findServicesByIds(organizationId, [...new Set(visibles.map((a) => a.serviceId))]) : [];
    const nombreProveedor = new Map(proveedores.map((p) => [p.id, p.displayName]));
    const nombreServicio = new Map(servicios.map((s) => [s.id, s.name]));

    // 2) Recordatorios (solo owner/admin: la funcion SQL lo exige; para otro rol sale null y se declara "no visible").
    let recordatorios: { visible: boolean; disponible: boolean; ventanaDias: number; filas: { canal: string; estado: string; total: number }[] };
    if (!puedeVerSensibles) {
      recordatorios = { visible: false, disponible: false, ventanaDias: DIAS_ATRAS_RECORDATORIOS, filas: [] };
    } else {
      const filas = await repo.recordatoriosPorEstado(organizationId, new Date(ahora - DIAS_ATRAS_RECORDATORIOS * 86_400_000).toISOString(), hasta);
      recordatorios = { visible: true, disponible: filas !== null, ventanaDias: DIAS_ATRAS_RECORDATORIOS, filas: (filas ?? []).map((f) => ({ canal: f.channel, estado: f.status, total: f.total })) };
    }

    // 3) Escalaciones de crisis (solo owner/admin).
    let escalaciones: {
      visible: boolean;
      disponible: boolean;
      seguimientoDisponible: boolean;
      items: { id: string; canal: string; palabraClave: string; telefono: string; creadaEn: string; seguimiento: string | null; seguimientoEn: string | null; nota: string | null }[];
    };
    if (!puedeVerSensibles) {
      escalaciones = { visible: false, disponible: false, seguimientoDisponible: false, items: [] };
    } else {
      const pagina = await repo.listEscalaciones(organizationId, 50);
      escalaciones = {
        visible: true,
        disponible: pagina.disponible,
        seguimientoDisponible: pagina.seguimientoDisponible,
        items: pagina.items.map((e) => ({
          id: e.id,
          canal: e.channel,
          palabraClave: e.keywordMatched,
          telefono: enmascararTelefono(e.customerPhone),
          creadaEn: e.createdAt,
          seguimiento: e.seguimiento,
          seguimientoEn: e.seguimientoAt,
          nota: e.seguimientoNota,
        })),
      };
    }

    return c.json(
      {
        generadoEn: new Date(ahora).toISOString(),
        porConfirmar: {
          horas: HORAS_POR_CONFIRMAR,
          total: pendientes.length,
          items: visibles.map((a) => ({
            id: a.id,
            iniciaEn: a.startsAt,
            proveedor: nombreProveedor.get(a.providerId) ?? null,
            servicio: nombreServicio.get(a.serviceId) ?? null,
            origen: a.source,
          })),
        },
        recordatorios,
        escalaciones,
      },
      200,
    );
  });

  app.post(`${base}/escalaciones/:escalationId/seguimiento`, async (c) => {
    assertVerticalRole(c, ROLES_SEGUIMIENTO);
    const escalationId = c.req.param("escalationId");
    if (!UUID_RE.test(escalationId)) throw Errors.validation("escalationId inválido.");
    const body = await readJsonCapped<{ estado?: unknown; nota?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof body.estado !== "string" || !(ESCALACION_SEGUIMIENTO_DESTINOS as readonly string[]).includes(body.estado)) {
      throw Errors.validation(`estado: se esperaba uno de ${ESCALACION_SEGUIMIENTO_DESTINOS.join(", ")}.`);
    }
    let nota: string | null = null;
    if (body.nota !== undefined && body.nota !== null) {
      if (typeof body.nota !== "string") throw Errors.validation("nota: se esperaba texto.");
      const limpia = body.nota.trim();
      if (limpia.length > NOTA_MAX) throw Errors.validation(`nota: máximo ${NOTA_MAX} caracteres.`);
      nota = limpia === "" ? null : limpia;
    }
    const result = await deps.citasRepo(c.get("db")).setEscalacionSeguimiento(c.get("organizationId"), escalationId, body.estado as EscalacionSeguimientoDestino, nota);
    switch (result.outcome) {
      case "updated":
        return c.json({ id: result.id, estado: result.estado, en: result.en }, 200);
      case "not_found":
        throw Errors.notFound("Escalación no encontrada.");
      case "invalid_input":
        throw Errors.validation("Parámetros inválidos para actualizar la escalación.");
      case "forbidden":
        throw Errors.forbidden();
      case "unavailable":
        throw Errors.serviceUnavailable("El seguimiento de escalaciones todavía no está disponible en este ambiente (migración pendiente).");
    }
  });

  return app;
}

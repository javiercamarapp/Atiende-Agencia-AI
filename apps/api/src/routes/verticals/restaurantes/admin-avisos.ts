// R-16 -- avisos del staff de restaurantes (migracion 043). Tres rutas reales sobre las funciones de la base:
//
//   GET  /v1/restaurantes/:propertyId/admin/avisos            "Mis avisos" (cada persona del staff) y, para owner/admin, la
//                                                              matriz equipo x aviso y el umbral de entrega tardia por sucursal.
//   PUT  /v1/restaurantes/:propertyId/admin/avisos/preferencias  enciende/apaga un aviso (y su sonido) de uno mismo o, owner/admin, de
//                                                              alguien de su equipo.
//   PUT  /v1/restaurantes/:propertyId/admin/avisos/umbral      minutos de gracia de la alerta de entrega tardia de una sucursal (owner/admin).
//
// La AUTORIDAD real es la base (core.set_notification_preference / restaurantes.set_umbral_entrega_tardia, security definer, con su
// verificacion de rol y de organizacion); la ruta agrega el primer filtro por rol (MANAGER_ROLES / STAFF_INVITE_ROLES), valida el
// cuerpo y deja bitacora (restaurantes.audit_log) de lo que owner/admin cambian sobre OTRA persona o sobre una sucursal. Las
// preferencias propias no se auditan (son personales).
//
// Base sin migrar: GET responde `disponible: false` (la pantalla muestra "aun no disponible", sin 500) y los PUT responden 503.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AvisosNoDisponiblesError,
  AvisosPermisoError,
  AvisosValidacionError,
  EVENTOS_AVISO,
  MANAGER_ROLES,
  STAFF_INVITE_ROLES,
  TIPOS_AVISO,
  UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN,
  UMBRAL_ENTREGA_TARDIA_MAX,
  UMBRAL_ENTREGA_TARDIA_MIN,
  guardarPreferenciaAviso,
  guardarUmbralEntrega,
  listarPreferenciasAvisos,
  listarUmbralesEntrega,
} from "@atiende/domain-restaurantes";
import type { PreferenciaAviso } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PreferenciaBody {
  readonly tipo?: unknown;
  readonly enabled?: unknown;
  readonly sonido?: unknown;
  readonly userId?: unknown;
}
interface UmbralBody {
  readonly propertyId?: unknown;
  readonly minutos?: unknown;
}

/** Estado efectivo por aviso: lo guardado o, sin fila, el default (encendido). */
function efectivas(filas: readonly PreferenciaAviso[], userId: string) {
  const propias = new Map(filas.filter((f) => f.userId === userId).map((f) => [f.tipo, f]));
  return EVENTOS_AVISO.map((e) => ({ tipo: e.tipo, enabled: propias.get(e.tipo)?.enabled ?? true, sonido: propias.get(e.tipo)?.sonido ?? true }));
}

function mapearError(err: unknown): never {
  if (err instanceof AvisosNoDisponiblesError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof AvisosPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof AvisosValidacionError) throw Errors.validation(err.message);
  throw err;
}

export function restaurantesAdminAvisosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/avisos";
  for (const p of [base, `${base}/preferencias`, `${base}/umbral`]) app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const esAdmin = (STAFF_INVITE_ROLES as readonly string[]).includes(c.get("verticalRole") ?? "");
    const db = c.get("db");
    c.header("Cache-Control", "no-store");

    try {
      const propias = await listarPreferenciasAvisos(db, organizationId, { todos: esAdmin });
      const eventos = EVENTOS_AVISO.map((e) => ({ tipo: e.tipo, etiqueta: e.etiqueta, descripcion: e.descripcion, sonidoAplica: e.sonidoAplica }));
      if (!propias.disponible) return c.json({ disponible: false, eventos, mias: [], equipo: null, umbrales: null, umbralDefectoMin: UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN });

      const mias = efectivas(propias.filas, userId);
      if (!esAdmin) return c.json({ disponible: true, eventos, mias, equipo: null, umbrales: null, umbralDefectoMin: UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN });

      const miembros = await deps.coreStaffRepo(db).listOrgMembers(organizationId);
      const equipo = miembros.map((m) => ({
        userId: m.userId,
        fullName: m.fullName,
        email: m.email,
        verticalRole: m.verticalRole,
        preferencias: efectivas(propias.filas, m.userId),
      }));
      const umbrales = await listarUmbralesEntrega(db, organizationId);
      return c.json({
        disponible: true,
        eventos,
        mias,
        equipo,
        umbrales: umbrales.disponible ? umbrales.sucursales : null,
        umbralMin: UMBRAL_ENTREGA_TARDIA_MIN,
        umbralMax: UMBRAL_ENTREGA_TARDIA_MAX,
        umbralDefectoMin: UMBRAL_ENTREGA_TARDIA_DEFECTO_MIN,
      });
    } catch (err) {
      return mapearError(err);
    }
  });

  app.put(`${base}/preferencias`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const callerId = c.get("userId");
    const raw = await readJsonCapped<PreferenciaBody>(c.req.raw, 2 * 1024);
    if (typeof raw.tipo !== "string" || !TIPOS_AVISO.has(raw.tipo)) throw Errors.validation("tipo: aviso desconocido.");
    if (typeof raw.enabled !== "boolean") throw Errors.validation("enabled: debe ser verdadero o falso.");
    if (raw.sonido !== undefined && typeof raw.sonido !== "boolean") throw Errors.validation("sonido: debe ser verdadero o falso.");
    if (raw.userId !== undefined && raw.userId !== null && (typeof raw.userId !== "string" || !UUID_RE.test(raw.userId))) throw Errors.validation("userId: identificador inválido.");
    const objetivo = typeof raw.userId === "string" && raw.userId !== callerId ? raw.userId : null;
    if (objetivo !== null) assertVerticalRole(c, STAFF_INVITE_ROLES);

    const db = c.get("db");
    try {
      // Conserva el valor actual de lo que no se manda (cambiar solo el aviso no borra la preferencia de sonido y viceversa).
      const actuales = await listarPreferenciasAvisos(db, organizationId, { todos: objetivo !== null });
      if (!actuales.disponible) throw new AvisosNoDisponiblesError();
      const previa = actuales.filas.find((f) => f.userId === (objetivo ?? callerId) && f.tipo === raw.tipo);
      const sonido = typeof raw.sonido === "boolean" ? raw.sonido : (previa?.sonido ?? true);
      await guardarPreferenciaAviso(db, { organizationId, userId: objetivo, tipo: raw.tipo, enabled: raw.enabled, sonido });
      if (objetivo !== null) {
        await deps.restaurantesRepo(db).registrarAuditoria({
          organizationId,
          actorUserId: callerId,
          action: "avisos.preferencia",
          entityType: "configuracion",
          entityId: objetivo,
          campo: raw.tipo,
          antes: previa ? (previa.enabled ? "encendido" : "apagado") : "encendido",
          despues: raw.enabled ? "encendido" : "apagado",
        });
      }
      logEvent(c, "info", "restaurantes_avisos_preferencia_guardada", { actorUserId: callerId, organizationId, propia: objetivo === null, tipo: raw.tipo, enabled: raw.enabled });
      return c.json({ ok: true, tipo: raw.tipo, enabled: raw.enabled, sonido });
    } catch (err) {
      return mapearError(err);
    }
  });

  app.put(`${base}/umbral`, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const callerId = c.get("userId");
    const raw = await readJsonCapped<UmbralBody>(c.req.raw, 2 * 1024);
    if (typeof raw.propertyId !== "string" || !UUID_RE.test(raw.propertyId)) throw Errors.validation("propertyId: identificador de sucursal inválido.");
    if (typeof raw.minutos !== "number" || !Number.isInteger(raw.minutos)) throw Errors.validation("minutos: debe ser un número entero.");

    // Alcance por sucursal: un owner/admin con membership acotada (property_ids) solo cambia el umbral de SUS sucursales
    // (mismo criterio que el resto de rutas admin, sin ensanchar el alcance). Membership org-wide (null) = todas.
    const alcance = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (alcance !== null && !alcance.includes(raw.propertyId)) throw Errors.forbidden("No tienes acceso a esta sucursal.");

    const db = c.get("db");
    try {
      const previos = await listarUmbralesEntrega(db, organizationId);
      const sucursal = previos.sucursales.find((s) => s.propertyId === raw.propertyId);
      if (previos.disponible && !sucursal) throw Errors.notFound("Sucursal no encontrada.");
      await guardarUmbralEntrega(db, raw.propertyId, raw.minutos);
      await deps.restaurantesRepo(db).registrarAuditoria({
        organizationId,
        actorUserId: callerId,
        action: "avisos.umbral_entrega_tardia",
        entityType: "configuracion",
        entityId: raw.propertyId,
        campo: "entrega_tardia_min",
        antes: sucursal?.entregaTardiaMin === null || sucursal === undefined ? null : String(sucursal.entregaTardiaMin),
        despues: String(raw.minutos),
      });
      logEvent(c, "info", "restaurantes_avisos_umbral_guardado", { actorUserId: callerId, organizationId, propertyId: raw.propertyId, minutos: raw.minutos });
      return c.json({ ok: true, propertyId: raw.propertyId, minutos: raw.minutos });
    } catch (err) {
      return mapearError(err);
    }
  });

  return app;
}

// R-15 (migracion 042) -- perfil operativo del repartidor: vehiculo, placas, disponibilidad, turno, licencia y contacto de emergencia.
//
//   GET|PUT    /v1/restaurantes/:propertyId/repartidor/perfil                          el repartidor lee y corrige SU perfil
//   GET|PUT|DELETE /v1/restaurantes/:propertyId/admin/staff/:userId/perfil-repartidor  owner/admin gestionan el de su organizacion
//
// Archivo aparte (no engorda admin-staff.ts). Quien puede qué lo decide la base (RLS + funciones definer de la 042); aquí se repite
// como primer filtro: la ruta propia exige rol `repartidor`, la de gestion `STAFF_INVITE_ROLES` (owner/admin) y verifica que el
// objetivo sea un repartidor de ESTA organizacion. El staff de piso no tiene acceso a ninguna de las dos (ni a licencia ni a
// contacto de emergencia). PUT es un reemplazo completo; el telefono se valida con packages/domain-restaurantes/src/phone.ts.
//
// Bitacora (migracion 019): cuando gestiona owner/admin se registra QUE secciones cambiaron, nunca los valores (sin PII). Una
// correccion hecha por el propio repartidor se registra solo en el log de la API: `record_audit_log` solo admite owner/admin/staff.
// Base SIN migrar: `disponible: false` y 503 honesto en la escritura, nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  REPARTIDOR_ROLES,
  STAFF_INVITE_ROLES,
  diaLocalSucursal,
  estadoLicencia,
  notificarLicenciaSiCorresponde,
  validarPerfilEntrada,
} from "@atiende/domain-restaurantes";
import type { RepartidorPerfil, RepartidorPerfilEntrada, RepartidorPerfilRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { UUID_RE } from "./voz-admin.ts";

const MSG_NO_DISPONIBLE = "El perfil del repartidor aún no está disponible: requiere aplicar la migración 042 en la base de datos.";

function serializar(p: RepartidorPerfil, hoy: string) {
  const lic = estadoLicencia(p.licenciaVigencia, hoy);
  return {
    userId: p.userId,
    vehiculoTipo: p.vehiculoTipo,
    placas: p.placas,
    disponibilidad: p.disponibilidad,
    turno: p.turno,
    licenciaNumero: p.licenciaNumero,
    licenciaVigencia: p.licenciaVigencia,
    licenciaEstado: lic.estado,
    licenciaDias: lic.dias,
    emergenciaNombre: p.emergenciaNombre,
    emergenciaTelefono: p.emergenciaTelefono,
    updatedAt: p.updatedAt,
  };
}

/** Secciones que cambiaron (nombres de campo, nunca valores) para la bitacora. */
function camposCambiados(antes: RepartidorPerfil | null, e: RepartidorPerfilEntrada): string[] {
  const claves: (keyof RepartidorPerfilEntrada)[] = ["vehiculoTipo", "placas", "disponibilidad", "turno", "licenciaNumero", "licenciaVigencia", "emergenciaNombre", "emergenciaTelefono"];
  return claves.filter((k) => (antes ? antes[k] : k === "disponibilidad" ? "disponible" : null) !== e[k]);
}

export function restaurantesRepartidorPerfilRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const propio = "/v1/restaurantes/:propertyId/repartidor/perfil";
  const gestion = "/v1/restaurantes/:propertyId/admin/staff/:userId/perfil-repartidor";
  for (const path of [propio, gestion]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function repo(c: Context<CoreAuthHonoEnv>): RepartidorPerfilRepository {
    if (!deps.repartidorPerfilRepo) throw Errors.serviceUnavailable("El perfil del repartidor no está disponible en este despliegue.");
    return deps.repartidorPerfilRepo(c.get("db"));
  }

  async function hoyLocal(c: Context<CoreAuthHonoEnv>): Promise<string> {
    const { zonaHoraria } = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(c.req.param("propertyId") ?? "");
    return diaLocalSucursal(new Date(), zonaHoraria).fecha;
  }

  /** Lee, guarda, avisa y devuelve el perfil resultante. `registrarComoGestion` = bitacora de owner/admin. */
  async function guardarYResponder(c: Context<CoreAuthHonoEnv>, userId: string, registrarComoGestion: boolean) {
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<unknown>(c.req.raw, 4 * 1024);
    const v = validarPerfilEntrada(raw);
    if (!v.ok) throw Errors.validation(v.error);

    const r = repo(c);
    const previo = await r.obtener(organizationId, userId);
    if (!previo.disponible) throw Errors.serviceUnavailable(MSG_NO_DISPONIBLE);
    const resultado = await r.guardar(organizationId, userId, v.valor);
    if (resultado.estado === "no_disponible") throw Errors.serviceUnavailable(MSG_NO_DISPONIBLE);
    if (resultado.estado === "prohibido") throw Errors.forbidden("No tienes permiso para editar este perfil.");
    if (resultado.estado === "no_es_repartidor") throw Errors.notFound("Ese miembro no es repartidor de esta organización.");
    if (resultado.estado === "invalido") throw Errors.validation(resultado.detalle);

    const hoy = await hoyLocal(c);
    // Aviso in-app al owner/admin si la licencia ya esta por vencer o vencida (best-effort, dedupe mensual, sin PII).
    await notificarLicenciaSiCorresponde(c.get("db"), organizationId, userId, v.valor.licenciaVigencia, hoy);

    const cambios = camposCambiados(previo.perfil, v.valor);
    logEvent(c, "info", "restaurantes_repartidor_perfil_actualizado", { actorUserId: c.get("userId"), organizationId, repartidorId: userId, campos: cambios.join(",") });
    if (registrarComoGestion && cambios.length > 0) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "repartidor.perfil_actualizado",
        entityType: "repartidor",
        entityId: userId,
        campo: cambios.join(","),
        antes: null,
        despues: null,
      });
    }
    const actual = await r.obtener(organizationId, userId);
    return c.json({ disponible: true, hoy, perfil: actual.perfil ? serializar(actual.perfil, hoy) : null });
  }

  // ---- el propio repartidor ----
  app.get(propio, async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    const lectura = await repo(c).obtener(c.get("organizationId"), c.get("userId"));
    const hoy = await hoyLocal(c);
    return c.json({ disponible: lectura.disponible, hoy, perfil: lectura.perfil ? serializar(lectura.perfil, hoy) : null });
  });

  app.put(propio, async (c) => {
    assertVerticalRole(c, REPARTIDOR_ROLES);
    return guardarYResponder(c, c.get("userId"), false);
  });

  // ---- gestion por owner/admin ----
  /** El objetivo debe ser un repartidor de ESTA organizacion (404 uniforme si no: mismo mensaje para inexistente y ajeno). */
  async function exigirRepartidor(c: Context<CoreAuthHonoEnv>): Promise<string> {
    const userId = c.req.param("userId") ?? "";
    if (!UUID_RE.test(userId)) throw Errors.validation("userId: se esperaba un UUID.");
    const miembros = await deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(c.get("organizationId"), "repartidor");
    if (!miembros.some((m) => m.userId === userId)) throw Errors.notFound("Ese miembro no es repartidor de esta organización.");
    return userId;
  }

  app.get(gestion, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const userId = await exigirRepartidor(c);
    const lectura = await repo(c).obtener(c.get("organizationId"), userId);
    const hoy = await hoyLocal(c);
    return c.json({ disponible: lectura.disponible, hoy, perfil: lectura.perfil ? serializar(lectura.perfil, hoy) : null });
  });

  app.put(gestion, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const userId = await exigirRepartidor(c);
    return guardarYResponder(c, userId, true);
  });

  // ARCO cancelacion/supresion: borra el perfil operativo y el personal; la bitacora conserva solo que se hizo.
  app.delete(gestion, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const userId = await exigirRepartidor(c);
    const organizationId = c.get("organizationId");
    const r = await repo(c).suprimir(organizationId, userId);
    if (!r.disponible) throw Errors.serviceUnavailable(MSG_NO_DISPONIBLE);
    if (r.prohibido) throw Errors.forbidden("No tienes permiso para suprimir este perfil.");
    logEvent(c, "info", "restaurantes_repartidor_perfil_suprimido", { actorUserId: c.get("userId"), organizationId, repartidorId: userId, borrado: r.borrado });
    if (r.borrado) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "repartidor.perfil_suprimido",
        entityType: "repartidor",
        entityId: userId,
        campo: "perfil",
        antes: null,
        despues: null,
      });
    }
    return c.json({ ok: true, borrado: r.borrado });
  });

  return app;
}

// Encuesta post-entrega, lado PANEL (R-41, migracion 041). Solo owner/admin (las funciones SQL exigen lo mismo):
//   GET  /v1/restaurantes/:propertyId/admin/encuestas/config           configuracion de la sucursal (apagada por defecto)
//   PUT  /v1/restaurantes/:propertyId/admin/encuestas/config           { activa, esperaMin, resenasUrl, umbralResena } (bitacora si cambia algo)
//   GET  /v1/restaurantes/:propertyId/admin/encuestas/resumen          satisfaccion global, por sucursal y por repartidor + comentarios recientes
//          ?dias=30 (1..92) | ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   y   ?alcance=sucursal|organizacion (por defecto organizacion)
//   POST /v1/restaurantes/:propertyId/admin/encuestas/enviar-pendientes  encola ya las encuestas pendientes de TODA la organizacion
//          (solo con alcance de toda la organizacion; deja bitacora; limitado a pocas llamadas por minuto)
// Comentarios: texto libre del cliente, visible solo a owner/admin; sin telefono ni nombre del cliente. Base SIN migrar: lecturas ->
// `disponible: false` con vacios honestos; escrituras -> 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  STAFF_INVITE_ROLES,
  EncuestaNoDisponibleError,
  EncuestaValidationError,
  diaLocalSucursal,
  tasaRespuestaPct,
  validarConfigEntrada,
} from "@atiende/domain-restaurantes";
import type { EncuestaPromedio, EncuestaRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { ejecutarBarridoEncuestas } from "./encuesta-envio.ts";

export const ENCUESTA_DIAS_POR_DEFECTO = 30;
export const ENCUESTA_DIAS_MAX = 92;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function fechaValida(f: string): boolean {
  if (!FECHA_RE.test(f)) return false;
  const d = new Date(`${f}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}
function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}
function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}
const conTasa = <T extends EncuestaPromedio>(p: T) => ({ ...p, tasaRespuestaPct: tasaRespuestaPct(p) });

export function restaurantesEncuestaAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/encuestas";
  for (const p of [`${base}/config`, `${base}/resumen`, `${base}/enviar-pendientes`]) {
    app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function encuestaRepo(c: Context<CoreAuthHonoEnv>): EncuestaRepository {
    if (!deps.encuestaRepo) throw Errors.serviceUnavailable("La encuesta post-entrega no está disponible en este despliegue.");
    return deps.encuestaRepo(c.get("db"));
  }

  /** La sucursal debe existir en ESTA organizacion y estar dentro del alcance del staff. */
  async function resolverSucursal(c: Context<CoreAuthHonoEnv>): Promise<{ organizationId: string; propertyId: string }> {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    return { organizationId, propertyId };
  }

  app.get(`${base}/config`, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const lectura = await encuestaRepo(c).leerConfig(organizationId, propertyId);
    return c.json({ disponible: lectura.disponible, config: lectura.valor });
  });

  app.put(`${base}/config`, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    try {
      const entrada = validarConfigEntrada({ activa: body.activa, esperaMin: body.esperaMin, resenasUrl: body.resenasUrl, umbralResena: body.umbralResena });
      const config = await encuestaRepo(c).guardarConfig(organizationId, propertyId, entrada);
      return c.json({ disponible: true, config });
    } catch (err) {
      if (err instanceof EncuestaValidationError) throw Errors.validation(err.message);
      if (err instanceof EncuestaNoDisponibleError) throw Errors.serviceUnavailable("La encuesta post-entrega aún no está disponible: requiere la actualización de base de datos pendiente (migración 041).");
      throw err;
    }
  });

  app.get(`${base}/resumen`, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    const { zonaHoraria } = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId);
    const { fecha: hoy, zonaHoraria: zona } = diaLocalSucursal(new Date(), zonaHoraria);

    const qDesde = c.req.query("desde");
    const qHasta = c.req.query("hasta");
    const qDias = c.req.query("dias");
    const qAlcance = c.req.query("alcance") ?? "organizacion";
    if (qAlcance !== "organizacion" && qAlcance !== "sucursal") throw Errors.validation("alcance debe ser `organizacion` o `sucursal`.");
    let desde: string;
    let hasta: string;
    if (qDesde !== undefined || qHasta !== undefined) {
      if (qDias !== undefined) throw Errors.validation("Usa `dias` o `desde`/`hasta`, no ambos.");
      if (!qDesde || !qHasta || !fechaValida(qDesde) || !fechaValida(qHasta)) throw Errors.validation("desde y hasta deben ser fechas YYYY-MM-DD.");
      desde = qDesde;
      hasta = qHasta;
    } else {
      let dias = ENCUESTA_DIAS_POR_DEFECTO;
      if (qDias !== undefined) {
        if (!/^\d{1,3}$/.test(qDias)) throw Errors.validation(`dias debe ser un entero entre 1 y ${ENCUESTA_DIAS_MAX}.`);
        dias = Number(qDias);
      }
      if (dias < 1 || dias > ENCUESTA_DIAS_MAX) throw Errors.validation(`dias debe ser un entero entre 1 y ${ENCUESTA_DIAS_MAX}.`);
      hasta = hoy;
      desde = restarDias(hoy, dias - 1);
    }
    if (hasta < desde) throw Errors.validation("hasta no puede ser anterior a desde.");
    if (hasta > hoy) throw Errors.validation("hasta no puede ser posterior al día de hoy de la sucursal.");
    if (diasEntre(desde, hasta) > ENCUESTA_DIAS_MAX) throw Errors.validation(`El rango máximo es de ${ENCUESTA_DIAS_MAX} días.`);

    const lectura = await encuestaRepo(c).resumen(organizationId, desde, hasta, qAlcance === "sucursal" ? propertyId : null);
    const r = lectura.valor;
    return c.json({
      disponible: lectura.disponible,
      zonaHoraria: zona,
      hoy,
      desde,
      hasta,
      alcance: qAlcance,
      resumen: { ...conTasa(r.global), distribucion: r.global.distribucion },
      porSucursal: r.porSucursal.map(conTasa),
      porRepartidor: r.porRepartidor.map(conTasa),
      recientes: r.recientes,
    });
  });

  app.post(`${base}/enviar-pendientes`, async (c) => {
    const { organizationId, propertyId } = await resolverSucursal(c);
    // Encola mensajes a CLIENTES de toda la organizacion: solo quien tiene alcance de toda la organizacion.
    const alcance = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (alcance !== null) throw Errors.forbidden("Enviar las encuestas pendientes requiere acceso a todas las sucursales de la organización.");
    const resultado = await ejecutarBarridoEncuestas(deps, organizationId, { topePorMinuto: { scope: "encuesta-enviar-pendientes", actor: organizationId, max: 6 } });
    if (!resultado) throw Errors.tooManyRequests();
    if (resultado.disponible && resultado.encoladas > 0) {
      await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "encuesta.envio_manual",
        entityType: "configuracion",
        entityId: propertyId,
        campo: "encuestas_encoladas",
        antes: null,
        despues: String(resultado.encoladas),
      });
    }
    return c.json({
      disponible: resultado.disponible,
      candidatas: resultado.candidatas,
      encoladas: resultado.encoladas,
      yaRegistradas: resultado.yaRegistradas,
      omitidas: resultado.omitidas,
      errores: resultado.errores,
    });
  });

  return app;
}

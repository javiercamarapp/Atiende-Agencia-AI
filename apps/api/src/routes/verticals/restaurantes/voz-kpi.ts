// KPI de voz, costo por llamada/dia y alertas operativas del agente de voz de restaurantes (R-13, migración 035).
// Por sucursal (`:propertyId`), lado PANEL (staff owner/admin; las policies y las funciones SQL exigen el mismo umbral):
//   GET  .../admin/voz/kpi                 KPI de hoy, del mes y de los últimos 14 días (día = día local de la sucursal)
//   GET  .../admin/voz/alertas             umbrales configurados + alertas ya disparadas
//   PUT  .../admin/voz/alertas/config      reemplaza los umbrales (costo del día en centavos MXN, tasa de error en %)
//   POST .../admin/voz/alertas/evaluar     compara HOY con los umbrales y registra (panel + bitácora) las nuevas
//
// Solo alertas INTERNAS (panel y bitácora): ninguna ruta de este archivo envía WhatsApp ni correo.
// Sin PII: todo es agregado; no se expone ni teléfono (ni enmascarado), ni transcripción, ni hash del llamante.
// Base SIN migrar: lecturas -> `disponible: false` con ceros/vacío; escrituras -> 503. Cada consulta degrada con
// SAVEPOINT dentro de la transacción del request (ver PostgresVozKpiRepository).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  STAFF_INVITE_ROLES,
  VozNoDisponibleError,
  VozRechazadaError,
  diaLocalSucursal,
  rangoDelMes,
  resumirKpis,
  totalizarDias,
  validarUmbrales,
} from "@atiende/domain-restaurantes";
import type { VozAlerta, VozKpiDia, VozKpiRepository, VozUmbrales } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

/** Días de la serie diaria que muestra el panel. */
export const SERIE_DIAS = 14;

function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function serializarDia(d: VozKpiDia) {
  return {
    fecha: d.fecha,
    llamadas: d.llamadas,
    llamadasCerradas: d.llamadasCerradas,
    duracionTotalS: d.duracionTotalS,
    pedidosVoz: d.pedidosVoz,
    escaladas: d.escaladas,
    abandonadas: d.abandonadas,
    erroresProveedor: d.erroresProveedor,
    toolP95Ms: d.toolP95Ms,
    costoCentavosMxn: d.costoTotalCentavosMxn,
  };
}

function serializarAlerta(a: VozAlerta) {
  return { fecha: a.fecha, tipo: a.tipo, valor: a.valor, umbral: a.umbral, nueva: a.nueva };
}

function serializarUmbrales(u: VozUmbrales, disponible: boolean) {
  return { disponible, configurado: u.configurado, umbralCostoDiaCentavosMxn: u.umbralCostoDiaCentavosMxn, umbralTasaErrorPct: u.umbralTasaErrorPct, minLlamadasTasaError: u.minLlamadasTasaError };
}

function asServiceUnavailable(err: unknown): never {
  if (err instanceof VozNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof VozRechazadaError) throw Errors.forbidden(err.message);
  throw err;
}

export function restaurantesVozKpiRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/voz";
  const kpiPath = `${base}/kpi`;
  const alertasPath = `${base}/alertas`;
  const configPath = `${base}/alertas/config`;
  const evaluarPath = `${base}/alertas/evaluar`;

  for (const path of [kpiPath, alertasPath, configPath, evaluarPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function kpiRepo(c: Context<CoreAuthHonoEnv>): VozKpiRepository {
    if (!deps.vozKpiRepo) throw Errors.serviceUnavailable("Los KPI de voz no están disponibles en este despliegue.");
    return deps.vozKpiRepo(c.get("db"));
  }

  /** La sucursal debe existir en ESTA organización y estar dentro del alcance del staff. */
  async function resolverSucursal(c: Context<CoreAuthHonoEnv>): Promise<{ organizationId: string; propertyId: string }> {
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    return { organizationId, propertyId };
  }

  async function diaDeHoy(c: Context<CoreAuthHonoEnv>, propertyId: string) {
    const { zonaHoraria } = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId);
    return diaLocalSucursal(new Date(), zonaHoraria);
  }

  app.get(kpiPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const { fecha: hoy, zonaHoraria } = await diaDeHoy(c, propertyId);
    const mes = rangoDelMes(hoy);
    const inicioSerie = restarDias(hoy, SERIE_DIAS - 1);
    // Un solo rango cubre el mes en curso y la serie de 14 días (maximo 44 dias, dentro del tope de 63 de la base).
    const desde = mes.desde < inicioSerie ? mes.desde : inicioSerie;
    const lectura = await kpiRepo(c).getKpisDiarios(organizationId, propertyId, desde, hoy);
    const dias = lectura.valor;
    const resumen = resumirKpis(dias.filter((d) => d.fecha >= mes.desde), hoy, zonaHoraria);
    return c.json({
      disponible: lectura.disponible,
      zonaHoraria,
      hoy,
      mesDesde: mes.desde,
      diaDeHoy: resumen.diaDeHoy,
      mes: resumen.mes,
      serie: dias.filter((d) => d.fecha >= inicioSerie).map(serializarDia),
      serieTotales: totalizarDias(dias.filter((d) => d.fecha >= inicioSerie)),
    });
  });

  app.get(alertasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const repo = kpiRepo(c);
    const umbrales = await repo.getUmbrales(propertyId);
    const alertas = await repo.listAlertas(organizationId, propertyId, 20);
    return c.json({
      disponible: umbrales.disponible && alertas.disponible,
      umbrales: serializarUmbrales(umbrales.valor, umbrales.disponible),
      alertas: alertas.valor.map(serializarAlerta),
    });
  });

  app.put(configPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    // PUT reemplaza la configuración COMPLETA: cada campo es obligatorio (null apaga una alerta).
    for (const campo of ["umbralCostoDiaCentavosMxn", "umbralTasaErrorPct", "minLlamadasTasaError"]) {
      if (!(campo in raw)) throw Errors.validation(`${campo}: campo requerido.`);
    }
    const errores = validarUmbrales({
      umbralCostoDiaCentavosMxn: raw.umbralCostoDiaCentavosMxn,
      umbralTasaErrorPct: raw.umbralTasaErrorPct,
      minLlamadasTasaError: raw.minLlamadasTasaError,
    });
    if (errores.length > 0) throw Errors.validation(errores.join(" "));
    const entrada = {
      umbralCostoDiaCentavosMxn: raw.umbralCostoDiaCentavosMxn as number | null,
      umbralTasaErrorPct: raw.umbralTasaErrorPct as number | null,
      minLlamadasTasaError: raw.minLlamadasTasaError as number,
    };
    const repo = kpiRepo(c);
    const anterior = await repo.getUmbrales(propertyId);

    let guardados: VozUmbrales;
    try {
      guardados = await repo.upsertUmbrales(organizationId, propertyId, c.get("userId"), entrada);
    } catch (err) {
      return asServiceUnavailable(err);
    }

    logEvent(c, "info", "restaurantes_admin_voz_umbrales_actualizados", { actorUserId: c.get("userId"), organizationId, propertyId });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.voz_umbrales_actualizados",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "voz_umbrales",
      antes: anterior.disponible && anterior.valor.configurado ? JSON.stringify({ costoDiaCentavosMxn: anterior.valor.umbralCostoDiaCentavosMxn, tasaErrorPct: anterior.valor.umbralTasaErrorPct, minLlamadas: anterior.valor.minLlamadasTasaError }) : null,
      despues: JSON.stringify({ costoDiaCentavosMxn: guardados.umbralCostoDiaCentavosMxn, tasaErrorPct: guardados.umbralTasaErrorPct, minLlamadas: guardados.minLlamadasTasaError }),
    });
    return c.json(serializarUmbrales(guardados, true));
  });

  app.post(evaluarPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const lectura = await kpiRepo(c).evaluarAlertas(organizationId, propertyId);
    return c.json({ disponible: lectura.disponible, alertas: lectura.valor.map(serializarAlerta) });
  });

  return app;
}

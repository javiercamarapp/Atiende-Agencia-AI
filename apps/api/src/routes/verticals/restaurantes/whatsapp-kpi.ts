// KPI del agente de WhatsApp de restaurantes por sucursal y día local (R-31, migración 040):
//   GET /v1/restaurantes/:propertyId/admin/whatsapp/kpi?dias=14            últimos N días (1..63) hasta HOY local de la sucursal
//   GET /v1/restaurantes/:propertyId/admin/whatsapp/kpi?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   rango explícito (máx. 63 días, hasta <= hoy local)
// Lado PANEL, solo owner/admin (la función SQL exige lo mismo). Solo lectura: no escribe nada, no envía nada, no hay PII (todo agregado).
// Base SIN migrar -> `disponible: false` con serie vacía (estado honesto, nunca un 500). `entrega` (avisos de pedido entregados/leidos, migracion 066) trae su propio `disponible`. El costo LLM es de la ORGANIZACIÓN y solo lo ve quien
// tiene alcance de toda la organización (en otro caso viene null); el costo por pedido es un PROMEDIO del periodo, no un costo real por pedido.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, costoPorPedidoCentavos, diaLocalSucursal, porcentaje, resumirWhatsappEntrega, resumirWhatsappKpi } from "@atiende/domain-restaurantes";
import type { WhatsappKpiDia, WhatsappKpiRepository } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

/** Días por defecto de la serie y tope (la base acepta como máximo 63 días por consulta). */
export const WHATSAPP_KPI_DIAS_POR_DEFECTO = 14;
export const WHATSAPP_KPI_DIAS_MAX = 63;

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

function serializarDia(d: WhatsappKpiDia) {
  return {
    fecha: d.fecha,
    conversaciones: d.conversaciones,
    conversacionesConPedido: d.conversacionesConPedido,
    conversacionesConHandoff: d.conversacionesConHandoff,
    conversionPct: porcentaje(d.conversacionesConPedido, d.conversaciones),
    handoffPct: porcentaje(d.conversacionesConHandoff, d.conversaciones),
    pedidos: d.pedidos,
    handoffs: d.handoffs,
    pedidosOrg: d.pedidosOrg,
    costoLlmOrgCentavosMxn: d.costoLlmOrgCentavosMxn,
    costoLlmPorPedidoCentavosMxn: costoPorPedidoCentavos(d.costoLlmOrgCentavosMxn, d.pedidosOrg),
  };
}

export function restaurantesWhatsappKpiRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const kpiPath = "/v1/restaurantes/:propertyId/admin/whatsapp/kpi";
  app.use(kpiPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function kpiRepo(c: Context<CoreAuthHonoEnv>): WhatsappKpiRepository {
    if (!deps.whatsappKpiRepo) throw Errors.serviceUnavailable("Los indicadores del agente de WhatsApp no están disponibles en este despliegue.");
    return deps.whatsappKpiRepo(c.get("db"));
  }

  app.get(kpiPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    // La sucursal debe existir en ESTA organización y estar dentro del alcance del staff.
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);

    const { zonaHoraria } = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId);
    const { fecha: hoy, zonaHoraria: zona } = diaLocalSucursal(new Date(), zonaHoraria);

    const qDesde = c.req.query("desde");
    const qHasta = c.req.query("hasta");
    const qDias = c.req.query("dias");
    let desde: string;
    let hasta: string;
    if (qDesde !== undefined || qHasta !== undefined) {
      if (qDias !== undefined) throw Errors.validation("Usa `dias` o `desde`/`hasta`, no ambos.");
      if (!qDesde || !qHasta || !fechaValida(qDesde) || !fechaValida(qHasta)) throw Errors.validation("desde y hasta deben ser fechas YYYY-MM-DD.");
      desde = qDesde;
      hasta = qHasta;
    } else {
      let dias = WHATSAPP_KPI_DIAS_POR_DEFECTO;
      if (qDias !== undefined) {
        if (!/^\d{1,3}$/.test(qDias)) throw Errors.validation("dias debe ser un entero entre 1 y 63.");
        dias = Number(qDias);
      }
      if (dias < 1 || dias > WHATSAPP_KPI_DIAS_MAX) throw Errors.validation("dias debe ser un entero entre 1 y 63.");
      hasta = hoy;
      desde = restarDias(hoy, dias - 1);
    }
    if (hasta < desde) throw Errors.validation("hasta no puede ser anterior a desde.");
    if (hasta > hoy) throw Errors.validation("hasta no puede ser posterior al día de hoy de la sucursal.");
    if (diasEntre(desde, hasta) > WHATSAPP_KPI_DIAS_MAX) throw Errors.validation(`El rango máximo es de ${WHATSAPP_KPI_DIAS_MAX} días.`);

    const repoKpi = kpiRepo(c);
    const lectura = await repoKpi.getKpisDiarios(organizationId, propertyId, desde, hasta);
    const resumen = resumirWhatsappKpi(lectura.valor);
    // Entrega y lectura de los avisos de estado de pedido (migracion 066). Su disponibilidad es INDEPENDIENTE de la del KPI de conversaciones:
    // una base con la 040 y sin la 066 muestra el KPI de siempre y `entrega.disponible: false` (estado honesto, nunca ceros inventados).
    const entregaLectura = await repoKpi.getEntregaDiaria(organizationId, propertyId, desde, hasta);
    return c.json({
      disponible: lectura.disponible,
      zonaHoraria: zona,
      hoy,
      desde,
      hasta,
      resumen: {
        dias: resumen.dias,
        conversaciones: resumen.conversaciones,
        conversacionesConPedido: resumen.conversacionesConPedido,
        conversacionesConHandoff: resumen.conversacionesConHandoff,
        conversionPct: resumen.conversionPct,
        handoffPct: resumen.handoffPct,
        pedidos: resumen.pedidos,
        handoffs: resumen.handoffs,
        pedidosOrg: resumen.pedidosOrg,
        orgEsDemo: resumen.orgEsDemo,
        costoLlmOrgCentavosMxn: resumen.costoLlmOrgCentavosMxn,
        costoLlmPorPedidoCentavosMxn: resumen.costoLlmPorPedidoCentavosMxn,
      },
      serie: lectura.valor.map(serializarDia),
      entrega: {
        disponible: entregaLectura.disponible,
        resumen: resumirWhatsappEntrega(entregaLectura.valor),
        serie: entregaLectura.valor,
      },
    });
  });

  return app;
}

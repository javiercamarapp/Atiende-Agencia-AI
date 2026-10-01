// Rn-03 -- reporte de ocupación e ingresos por unidad, propietario, canal y mes:
//   GET /rentas/:propertyId/reportes/ocupacion-ingresos
//     ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD        periodo [desde, hasta) (sin ambos: mes en curso de la property)
//     &agrupar=unidad|propietario|canal|mes     agrupación exportada en csv/pdf (default unidad)
//     &formato=json|csv|pdf                     default json (json trae TODAS las agrupaciones)
//     &unidad_id=<uuid>&propietario_id=<uuid>&canal=<codigo>   filtros opcionales
// Solo lectura. Contiene dinero => mismo techo de roles que finanzas (admin_gestora y
// contador, FINANZAS_LECTURA_ROLES); la RLS real de rentas.reserva_financiero
// (can_read_finanzas) lo vuelve a exigir en la base. Misma sesión/membership que el resto
// de rentas (authMiddleware + dbSession + requirePropertyMembership).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  AGRUPACIONES_REPORTE,
  FINANZAS_LECTURA_ROLES,
  MAX_NOCHES_REPORTE,
  PostgresRentasReportesRepository,
  calcularNoches,
  esRangoValido,
  generarReporteOcupacionIngresos,
  mesCalendarioDe,
  reporteACsv,
  reporteAPdf,
} from "@atiende/domain-rentas";
import type { AgrupacionReporte, GrupoReporte, MetricasReporte, ResultadoReporte } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const CANAL_RE = /^[a-z0-9_]{1,32}$/;

function metricasAJson(m: MetricasReporte) {
  return {
    llegadas: m.llegadas,
    noches_ocupadas: m.nochesOcupadas,
    noches_disponibles: m.nochesDisponibles,
    ocupacion_basis_points: m.ocupacionBasisPoints,
    ingreso_bruto_centavos: m.ingresoBrutoCentavos,
    comision_canal_centavos: m.comisionCanalCentavos,
    comision_gestor_centavos: m.comisionGestorCentavos,
    gastos_centavos: m.gastosCentavos,
    impuestos_centavos: m.impuestosCentavos,
    neto_centavos: m.netoCentavos,
    adr_centavos: m.adrCentavos,
  };
}

const grupoAJson = (g: GrupoReporte) => ({ clave: g.clave, etiqueta: g.etiqueta, ...metricasAJson(g) });

function reporteAJson(r: ResultadoReporte, financieroDisponible: boolean) {
  return {
    periodo: { desde: r.periodo.inicio, hasta: r.periodo.fin },
    moneda: r.moneda,
    financiero_disponible: financieroDisponible,
    totales: metricasAJson(r.totales),
    por_unidad: r.porUnidad.map(grupoAJson),
    por_propietario: r.porPropietario.map(grupoAJson),
    por_canal: r.porCanal.map(grupoAJson),
    por_mes: r.porMes.map(grupoAJson),
    advertencias: {
      reservas_sin_movimiento_financiero: r.advertencias.reservasSinMovimientoFinanciero,
      reservas_moneda_distinta: r.advertencias.reservasMonedaDistinta,
      noches_solapadas_omitidas: r.advertencias.nochesSolapadasOmitidas,
      reservas_duplicadas_omitidas: r.advertencias.reservasDuplicadasOmitidas,
    },
  };
}

function fechaOpcional(valor: string | undefined, campo: string): string | null {
  if (valor === undefined || valor === "") return null;
  if (!FECHA_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba una fecha YYYY-MM-DD.`);
  return valor;
}

export function rentasReportesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ruta = "/rentas/:propertyId/reportes/ocupacion-ingresos";
  app.use(ruta, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(ruta, async (c) => {
    assertVerticalRole(c, FINANZAS_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasReportesRepo ? deps.rentasReportesRepo(c.get("db")) : new PostgresRentasReportesRepository(c.get("db"));

    const formato = c.req.query("formato") ?? "json";
    if (formato !== "json" && formato !== "csv" && formato !== "pdf") throw Errors.validation('formato: se esperaba "json", "csv" o "pdf".');
    const agrupar = (c.req.query("agrupar") ?? "unidad") as AgrupacionReporte;
    if (!AGRUPACIONES_REPORTE.includes(agrupar)) throw Errors.validation(`agrupar: se esperaba ${AGRUPACIONES_REPORTE.join(", ")}.`);
    const unidadId = c.req.query("unidad_id");
    if (unidadId !== undefined && !UUID_RE.test(unidadId)) throw Errors.validation("unidad_id: se esperaba un UUID.");
    const ownerId = c.req.query("propietario_id");
    if (ownerId !== undefined && !UUID_RE.test(ownerId)) throw Errors.validation("propietario_id: se esperaba un UUID.");
    const canal = c.req.query("canal");
    if (canal !== undefined && !CANAL_RE.test(canal)) throw Errors.validation("canal: código de canal inválido.");

    const desde = fechaOpcional(c.req.query("desde"), "desde");
    const hasta = fechaOpcional(c.req.query("hasta"), "hasta");
    if ((desde === null) !== (hasta === null)) throw Errors.validation("desde y hasta se piden juntos (o ninguno, para el mes en curso).");
    let periodo: { inicio: string; fin: string };
    if (desde !== null && hasta !== null) {
      periodo = { inicio: desde, fin: hasta };
      if (!esRangoValido(periodo)) throw Errors.validation("El periodo es inválido: 'hasta' debe ser una fecha real posterior a 'desde'.");
      if (calcularNoches(periodo) > MAX_NOCHES_REPORTE) throw Errors.validation(`El periodo no puede exceder ${MAX_NOCHES_REPORTE} noches.`);
    } else {
      // Mes en curso en la zona horaria de la property (America/Merida, etc.): nunca el día UTC crudo.
      const ctx = await repo.leerContextoPropiedad(propertyId);
      periodo = mesCalendarioDe(hoyFechaNegocio(resolverZonaHorariaNegocio(ctx.zonaHoraria)));
    }

    const datos = await repo.cargarDatosReporte(propertyId, periodo, { unidadId, ownerId, canal });
    const reporte = generarReporteOcupacionIngresos({ periodo, moneda: datos.moneda, unidades: datos.unidades, reservas: datos.reservas });

    const nombre = `reporte-ocupacion-ingresos_${periodo.inicio}_${periodo.fin}`;
    if (formato === "csv") {
      return c.body(reporteACsv(reporte, agrupar), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${nombre}.csv"`,
        "Cache-Control": "no-store",
      });
    }
    if (formato === "pdf") {
      return c.body(reporteAPdf(reporte, agrupar) as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nombre}.pdf"`,
        "Cache-Control": "no-store",
      });
    }
    return c.json(reporteAJson(reporte, datos.financieroDisponible), 200);
  });

  return app;
}

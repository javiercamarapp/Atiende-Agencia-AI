// CFO de la plataforma (cockpit del superadmin): UNA sola lectura y UN solo armado para la pantalla,
// las exportaciones, las recomendaciones y el Copiloto, asi ninguno muestra cifras distintas.
//
// Lee (todo caller-bound, en UNA transaccion; cada repositorio corre bajo SAVEPOINT):
//   * dashboard CFO del mes y del mes anterior (0030/0057): plan, ingreso esperado, costo medido por
//     categoria, cobranza, sucursales y tipo de cambio;
//   * fotos mensuales de MRR de los ultimos 12 meses (0030);
//   * uso por cliente y mes, supuestos y capturas del dueño (0085);
//   * infraestructura compartida capturada (0032).
// Base sin migrar: 0030 ausente -> null (la ruta responde «no disponible»); 0085 o 0032 ausentes ->
// el cockpit se arma igual con lo que hay y lo dice en `faltantes`.
import { construirFilasCfo, tipoCambioDeFilas } from "./filas.ts";
import type { TipoCambioCfo } from "./filas.ts";
import { cockpit, evaluarAlertasCfo } from "@atiende/billing";
import type { AlertaCfo } from "@atiende/billing";
import type { BillingSnapshotRow, CapturaCfoRow, CfoOrgRow, InfraCostRow, SupuestoCfoRow, UsoCfoRow } from "@atiende/db";
import type { AppDeps } from "../deps.ts";

export const MESES_HISTORIA = 12;
export const COCKPIT_NO_DISPONIBLE = "El CFO de la plataforma todavía no está disponible en este despliegue (falta aplicar la migración 0030_superadmin_cfo_dashboard).";

export function mesActualUtc(ahora: Date = new Date()): string {
  return ahora.toISOString().slice(0, 7);
}

export function sumarMeses(mes: string, n: number): string {
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

function diasDe(mes: string): number {
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export interface DatosCockpit {
  readonly mes: string;
  readonly rows: readonly CfoOrgRow[];
  readonly rowsPrevias: readonly CfoOrgRow[];
  readonly fotos: readonly BillingSnapshotRow[];
  readonly uso: readonly UsoCfoRow[];
  readonly supuestos: readonly SupuestoCfoRow[];
  readonly capturas: readonly CapturaCfoRow[];
  readonly infra: readonly InfraCostRow[];
  /** 0085 aplicada (uso, supuestos y capturas). */
  readonly cockpitMigrado: boolean;
  /** 0032 aplicada (infraestructura). */
  readonly infraMigrada: boolean;
}

/** Lee todo lo del cockpit con la sesion del superadmin. `null` = 0030 sin aplicar. */
export async function leerCockpit(deps: AppDeps, callerId: string, mes: string): Promise<DatosCockpit | null> {
  const cfo = deps.cfoRepo;
  if (!cfo) return null;
  const desde = sumarMeses(mes, -(MESES_HISTORIA - 1));
  const previo = sumarMeses(mes, -1);
  return deps.engine.withAppSession({ userId: callerId }, async (db) => {
    const r = cfo(db);
    const actual = await r.getDashboardRows(callerId, `${mes}-01`);
    if (actual.availability === "not_migrated") return null;
    const prev = await r.getDashboardRows(callerId, `${previo}-01`);
    const fotos = await r.listSnapshots(callerId, `${desde}-01`, `${mes}-01`);
    const repo = deps.cfoCockpitRepo?.(db);
    const uso = repo ? await repo.getUso(callerId, `${desde}-01`, `${mes}-01`) : null;
    const supuestos = repo ? await repo.listSupuestos(callerId) : null;
    // Capturas: la historia y hasta 12 meses de presupuesto hacia adelante.
    const capturas = repo ? await repo.listCapturas(callerId, `${desde}-01`, `${sumarMeses(mes, 12)}-01`) : null;
    const infra = deps.pylRepo ? await deps.pylRepo(db).listInfraCosts(callerId, `${mes}-01`, `${mes}-01`) : null;
    return {
      mes,
      rows: actual.rows,
      rowsPrevias: prev.rows,
      fotos: fotos.snapshots,
      uso: uso?.uso ?? [],
      supuestos: supuestos?.supuestos ?? [],
      capturas: capturas?.capturas ?? [],
      infra: infra?.costs ?? [],
      cockpitMigrado: uso?.availability === "available",
      infraMigrada: infra?.availability === "available",
    };
  });
}

export interface Cockpit {
  readonly mes: string;
  readonly enCurso: boolean;
  readonly diasTranscurridos: number;
  readonly diasDelMes: number;
  readonly tipoCambio: TipoCambioCfo | null;
  readonly tipoCambioPrevio: TipoCambioCfo | null;
  readonly supuestos: cockpit.Supuestos;
  readonly economia: readonly cockpit.FilaEconomia[];
  readonly agregados: { readonly total: cockpit.AgregadoEconomia; readonly porVertical: readonly cockpit.AgregadoEconomia[]; readonly porPlan: readonly cockpit.AgregadoEconomia[] };
  readonly saas: cockpit.MetricasSaas;
  readonly alertas: { readonly cfo: readonly AlertaCfo[]; readonly cockpit: readonly cockpit.AlertaCockpit[] };
  /** Lo que falta para que el cockpit este completo (decisiones o capturas del dueño, migraciones). */
  readonly faltantes: readonly string[];
  readonly medidorCobro: boolean;
}

const mesDe = (fecha: string) => fecha.slice(0, 7);

export function armarCockpit(d: DatosCockpit, ahora: Date = new Date()): Cockpit {
  const enCurso = d.mes === mesActualUtc(ahora);
  const diasDelMes = diasDe(d.mes);
  const diasTranscurridos = enCurso ? Math.max(1, ahora.getUTCDate()) : diasDelMes;
  const previo = sumarMeses(d.mes, -1);
  const supuestos = cockpit.resolverSupuestos(d.supuestos);
  const umbral = supuestos.umbralMargenPct.valor;
  const fx = tipoCambioDeFilas(d.rows);
  const fxPrevio = tipoCambioDeFilas(d.rowsPrevias);
  const filas = construirFilasCfo(d.rows, { umbralMargenPct: umbral, mxnPorUsd: fx?.mxnPorUsd ?? null });

  const infraDelMes = d.infra.filter((c) => mesDe(c.mes) === d.mes);
  const economia = cockpit.calcularEconomia({
    filas,
    uso: d.uso.filter((u) => mesDe(u.mes) === d.mes),
    usoPrevio: d.uso.filter((u) => mesDe(u.mes) === previo),
    supuestos,
    mxnPorUsd: fx?.mxnPorUsd ?? null,
    infraCentavos: infraDelMes.length === 0 ? null : infraDelMes.reduce((s, c) => s + c.montoMxnCentavos, 0),
    diasTranscurridos,
    diasDelMes,
    diasMesPrevio: diasDe(previo),
    sucursalesPorOrg: new Map(d.rows.map((r) => [r.organizationId, r.sucursalesActivas])),
  });

  // Historia de MRR: meses cerrados desde la foto guardada; el mes en curso, en vivo con el mismo MRR de la tabla.
  const desde = sumarMeses(d.mes, -(MESES_HISTORIA - 1));
  const meses: string[] = [];
  for (let m = desde; m <= d.mes; m = sumarMeses(m, 1)) meses.push(m);
  const planPorOrg = new Map(d.rows.map((r) => [r.organizationId, r.planId]));
  const historia: cockpit.FotosDelMes[] = meses.map((m) => {
    if (enCurso && m === d.mes) {
      return {
        mes: m,
        fotos: economia.map((f) => ({
          organizationId: f.organizationId,
          orgStatus: f.orgStatus,
          billingStatus: f.billingStatus,
          mrrCentavos: f.mrrMxn === null ? null : Math.round(f.mrrMxn * 100),
          vertical: f.vertical,
          planId: f.planId,
        })),
      };
    }
    return {
      mes: m,
      fotos: d.fotos
        .filter((s) => mesDe(s.mes) === m)
        .map((s) => ({ organizationId: s.organizationId, orgStatus: s.orgStatus, billingStatus: s.billingStatus, mrrCentavos: s.mrrCentavos, vertical: s.vertical, planId: s.planId ?? planPorOrg.get(s.organizationId) ?? null })),
    };
  });
  const primero = historia.findIndex((h) => h.fotos.length > 0);
  const historiaUtil = primero === -1 ? historia.slice(-1) : historia.slice(primero);

  // Costo real por mes para el presupuesto: medido (LLM + eventos) al tipo de cambio vigente; el mes del corte, el de la tabla.
  const costoRealPorMes = new Map<string, number | null>();
  for (const m of meses) {
    if (m === d.mes) {
      const conCosto = economia.every((f) => f.costoDirectoMxn !== null);
      costoRealPorMes.set(m, conCosto && fx ? Math.round(economia.reduce((s, f) => s + (f.costoDirectoMxn ?? 0), 0) * 100) / 100 : null);
      continue;
    }
    const delMes = d.uso.filter((u) => mesDe(u.mes) === m);
    costoRealPorMes.set(m, fx && delMes.length > 0 ? Math.round((delMes.reduce((s, u) => s + u.llmMicroUsd + u.eventosMicroUsd, 0) / 1_000_000) * fx.mxnPorUsd * 100) / 100 : null);
  }

  const saas = cockpit.calcularMetricasSaas({
    mes: d.mes,
    historia: historiaUtil,
    economia,
    capturas: d.capturas,
    ltvMesesTope: supuestos.ltvMesesTope.valor,
    enCurso,
    fx: fx ? { mxnPorUsd: fx.mxnPorUsd, fecha: fx.fecha, fuente: fx.fuente } : null,
    fxHace30d: fxPrevio?.mxnPorUsd ?? null,
    costoRealPorMes,
  });

  const alertasCockpit = cockpit.evaluarAlertasCockpit({
    economia,
    movimientoFxPct: saas.fx.disponible ? saas.fx.movimiento30dPct : null,
    umbralFxPct: supuestos.umbralFxPct.valor,
    umbralPicoCostoPct: supuestos.umbralPicoCostoPct.valor,
  });

  const faltantes: string[] = [];
  if (!d.cockpitMigrado) faltantes.push("Falta aplicar la migración 0085_superadmin_cfo_cockpit: sin uso por cliente (llamadas, minutos, pedidos), sin supuestos capturados y sin capturas del dueño.");
  if (!fx) faltantes.push("Captura el tipo de cambio del mes (Costos y margen): sin él no hay costo en MXN ni margen.");
  if (infraDelMes.length === 0) faltantes.push(`Captura la infraestructura compartida de ${d.mes} (P&L): sin ella no hay margen bruto, solo de contribución.`);
  const capturasDel = (tipo: CapturaCfoRow["tipo"]) => d.capturas.some((c) => c.tipo === tipo && mesDe(c.mes) === d.mes);
  if (!capturasDel("gasto_fijo")) faltantes.push(`Captura los gastos fijos de ${d.mes} (nómina, renta, herramientas): sin ellos el burn y el runway salen incompletos.`);
  if (!capturasDel("marketing")) faltantes.push(`Captura el gasto de marketing de ${d.mes}: sin él no hay CAC ni payback.`);
  if (!d.capturas.some((c) => c.tipo === "saldo_caja")) faltantes.push("Captura el saldo de caja: sin él no hay runway.");
  if (!d.capturas.some((c) => c.tipo.startsWith("presupuesto_"))) faltantes.push("Captura un presupuesto mensual (ingreso y costo) para comparar plan contra real.");
  const medidorCobro = d.uso.some((u) => u.conversacionesWa !== null);
  if (d.cockpitMigrado && !medidorCobro && d.uso.some((u) => u.vertical === "restaurantes")) {
    faltantes.push("Sin medidor de cobro (restaurantes.uso_facturable_mes, PR #771): las conversaciones de WhatsApp y el pool de los planes medidos salen «sin dato».");
  }

  return {
    mes: d.mes,
    enCurso,
    diasTranscurridos,
    diasDelMes,
    tipoCambio: fx,
    tipoCambioPrevio: fxPrevio,
    supuestos,
    economia,
    agregados: { total: cockpit.total(economia), porVertical: cockpit.porVertical(economia), porPlan: cockpit.porPlan(economia) },
    saas,
    alertas: { cfo: evaluarAlertasCfo(filas, { umbralMargenPct: umbral, ahoraMs: ahora.getTime() }), cockpit: alertasCockpit },
    faltantes,
    medidorCobro,
  };
}

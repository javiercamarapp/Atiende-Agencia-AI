// Dashboard ejecutivo CFO (SA-01) con MRR/ARR por vertical y cliente y NRR (SA-05): una sola
// lectura que compone costo, plan, cobranza y la foto mensual de ingreso.
// Ver packages/db/migrations/0030_superadmin_cfo_dashboard.sql y packages/billing/src/cfo.ts.
//
// REGLA DE LA CASA: nunca inventar una cifra. Lo que no tiene fuente sale como "no disponible"
// con su razon (caja, NRR sin foto previa, margen sin tipo de cambio, ingreso de una organizacion
// sin plan o con plan sin precio); jamas como 0.
//
// Solo lectura. Base sin migrar (0030 sin aplicar): `disponible: false` con mensaje honesto,
// nunca un 500 (el repo corre bajo SAVEPOINT, ver packages/db/src/superadmin-cfo-repository.ts).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { armarDashboardCfo, snapshotDesdeFila } from "@atiende/billing";
import type { SnapshotMrr } from "@atiende/billing";
import type { BillingSnapshotRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { construirFilasCfo, tipoCambioDeFilas, UMBRAL_MARGEN_PCT_DEFAULT } from "../cfo/filas.ts";
import type { AppDeps } from "../deps.ts";

export const CFO_NO_DISPONIBLE = "El dashboard CFO todavía no está disponible en este despliegue (falta aplicar la migración 0030_superadmin_cfo_dashboard).";
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;

/** `YYYY-MM` del mes en curso, en UTC (mismo criterio que `current_date` del servidor de Postgres). */
function mesActualUtc(): string {
  return new Date().toISOString().slice(0, 7);
}

function mesAnterior(mes: string): string {
  const [y, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function aSnapshot(s: BillingSnapshotRow): SnapshotMrr {
  return { organizationId: s.organizationId, orgStatus: s.orgStatus, billingStatus: s.billingStatus, mrrCentavos: s.mrrCentavos };
}

export function superadminCfoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/cfo/dashboard", async (c) => {
    const mesRaw = c.req.query("mes");
    const mes = mesRaw === undefined || mesRaw === "" ? mesActualUtc() : mesRaw;
    if (!MES_RE.test(mes)) throw Errors.validation("mes debe tener formato YYYY-MM.");
    let umbral = UMBRAL_MARGEN_PCT_DEFAULT;
    const umbralRaw = c.req.query("umbralMargenPct");
    if (umbralRaw !== undefined && umbralRaw !== "") {
      umbral = Number(umbralRaw);
      if (!Number.isFinite(umbral) || umbral < 0 || umbral > 100) throw Errors.validation("umbralMargenPct debe estar entre 0 y 100.");
    }
    const noDisponible = { disponible: false, mes, mensaje: CFO_NO_DISPONIBLE, umbralMargenPct: umbral, tipoCambio: null, dashboard: null, supuestos: [] as string[] };
    if (!deps.cfoRepo) return c.json(noDisponible);
    const repo = deps.cfoRepo;
    const callerId = c.get("userId");
    const esMesEnCurso = mes === mesActualUtc();
    const previo = mesAnterior(mes);

    const datos = await deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const r = repo(db);
      const dash = await r.getDashboardRows(callerId, `${mes}-01`);
      if (dash.availability === "not_migrated") return null;
      const previos = await r.listSnapshots(callerId, `${previo}-01`, `${previo}-01`);
      const actuales = esMesEnCurso ? null : await r.listSnapshots(callerId, `${mes}-01`, `${mes}-01`);
      return { rows: dash.rows, previos: previos.snapshots, actuales: actuales ? actuales.snapshots : null };
    });
    if (datos === null) return c.json(noDisponible);

    const fx = tipoCambioDeFilas(datos.rows);
    const filas = construirFilasCfo(datos.rows, { umbralMargenPct: umbral, mxnPorUsd: fx?.mxnPorUsd ?? null });
    const dashboard = armarDashboardCfo({
      mes,
      filas,
      umbralMargenPct: umbral,
      mxnPorUsd: fx?.mxnPorUsd ?? null,
      snapshotsPrevios: datos.previos.length > 0 ? datos.previos.map(aSnapshot) : null,
      // Mes en curso: la foto en vivo; mes cerrado: la guardada (o ninguna -> NRR no disponible).
      snapshotsActuales: esMesEnCurso ? filas.map(snapshotDesdeFila) : datos.actuales !== null && datos.actuales.length > 0 ? datos.actuales.map(aSnapshot) : null,
      ahoraMs: Date.now(),
    });

    const supuestos = [
      "MRR = ingreso esperado por el plan asignado (base + asientos facturables x precio por asiento) de las organizaciones activas con suscripción no cancelada; no es lo cobrado por Stripe. ARR = MRR x 12.",
      "Una organización activa sin plan o con plan sin precio NO suma al MRR: se cuenta aparte como «sin precio», nunca como cero.",
      "El costo del mes une LLM (core.llm_usage_daily) y eventos de voz, WhatsApp, telefonía, SMS, correo y storage (core.usage_cost_event) sin doble conteo; voz, WhatsApp y telefonía son estimados hasta conciliarlos con la factura del proveedor.",
      fx
        ? `Tipo de cambio ${fx.mxnPorUsd} MXN/USD${fx.fecha ? ` del ${fx.fecha}` : ""}${fx.fuente ? ` (fuente: ${fx.fuente})` : ""}.`
        : "No hay tipo de cambio configurado para este mes: el margen no se calcula hasta capturar uno (Costos y margen).",
      "El NRR compara contra la foto mensual de ingreso del mes anterior; solo existe desde que corre el cron de alertas CFO, así que los primeros meses salen «no disponible».",
      "Caja: no hay fuente de saldos bancarios, cuentas por cobrar ni pagos; se muestra «sin datos» en lugar de una cifra.",
    ];
    return c.json({
      disponible: true,
      mes,
      umbralMargenPct: umbral,
      tipoCambio: fx,
      organizaciones: datos.rows.length,
      dashboard,
      supuestos,
    });
  });

  return app;
}

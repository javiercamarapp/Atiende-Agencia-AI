// Fase 5 (conciliación bancaria): expone el motor de matching de 4 niveles (Fase 5
// — niveles 1-3, ver @atiende/domain-despachos/conciliacion/matching-engine.ts;
// nivel 4 LLM deliberadamente no portado, ver comentario de cabecera de ese
// archivo) más las reglas de alerta (comisiones, movimientos grandes, aging,
// duplicados). Mismo criterio que declaraciones.ts/nomina.ts: es un endpoint puro/
// calculadora — el cliente HTTP manda los movimientos bancarios ya parseados
// (parsing de CSV/OFX/etc. queda fuera de esta fase, ver informe de auditoría) y el
// motor los concilia contra los CFDI YA INGERIDOS de esta property
// (`repo.listInvoices`) sin necesitar una tabla nueva de "trabajo de conciliación" —
// ese es el alcance explícito de esta fase; persistir el historial de conciliaciones
// corridas es un incremento natural futuro, no bloqueante para el valor del motor.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CONCILIACION_ROLES,
  conciliarMovimientos,
  revisarMovimiento,
  revisarDuplicados,
  revisarDiscrepanciaIngresos,
  clasificarDeposito,
  verificarSpeiContraMovimientos,
  verificarPagoProveedor,
} from "@atiende/domain-despachos";
import type { MovimientoBancario, RegistroConciliable, InvoiceRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface MovimientoBody {
  readonly fecha?: unknown;
  readonly descripcion?: unknown;
  readonly referencia?: unknown;
  readonly cargo?: unknown;
  readonly abono?: unknown;
  readonly saldo?: unknown;
  readonly monto?: unknown;
  readonly banco?: unknown;
  readonly formato?: unknown;
}

interface MatchingBody {
  readonly movimientos?: unknown;
  readonly dateToleranceDays?: unknown;
  readonly montoTolerancePct?: unknown;
  readonly fuzzyThreshold?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw Errors.validation(`${field}: se esperaba un string no vacío.`);
  return value;
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function parseMovimiento(raw: unknown, idx: number): MovimientoBancario {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`movimientos[${idx}]: se esperaba un objeto.`);
  const m = raw as MovimientoBody;
  const fecha = requireString(m.fecha, `movimientos[${idx}].fecha`);
  const descripcion = typeof m.descripcion === "string" ? m.descripcion : "";
  const referencia = typeof m.referencia === "string" ? m.referencia : null;
  const cargo = typeof m.cargo === "number" ? m.cargo : null;
  const abono = typeof m.abono === "number" ? m.abono : null;
  const saldo = typeof m.saldo === "number" ? m.saldo : null;
  // `monto` con signo — si no viene explícito, se deriva de cargo/abono igual que
  // los parsers del origen (`monto = abono - cargo`).
  const monto = typeof m.monto === "number" ? m.monto : (abono ?? 0) - (cargo ?? 0);
  const banco = typeof m.banco === "string" ? m.banco : "generic";
  const formato = typeof m.formato === "string" ? m.formato : "csv";
  return { fecha, descripcion, referencia, cargo, abono, saldo, monto, banco, formato };
}

/** Aplana un `InvoiceRecord` ya ingerido a `RegistroConciliable` — usa la fecha
 * REAL del CFDI (`diot.proveedoresReportables[0].fecha`, mismo criterio de
 * declaraciones.ts para DIOT) con fallback a la fecha de ingesta si no está. */
function invoiceARegistroConciliable(inv: InvoiceRecord): RegistroConciliable {
  const fechaCfdi = inv.diot.proveedoresReportables[0]?.fecha ?? inv.createdAt.slice(0, 10);
  return {
    id: inv.id,
    fecha: fechaCfdi,
    total: inv.total,
    descripcion: inv.emisorNombre,
    referencia: inv.folioFiscal,
    folioFiscal: inv.folioFiscal,
  };
}

export function despachosConciliacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/conciliacion/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Corre el motor de matching contra los CFDI ya ingeridos de esta property. */
  app.post("/despachos/:propertyId/conciliacion/matching", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<MatchingBody>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);

    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const invoices = await repo.listInvoices(propertyId);
    const registros = invoices.map(invoiceARegistroConciliable);

    const resultado = conciliarMovimientos(movimientos, registros, {
      dateToleranceDays: optionalNumber(raw.dateToleranceDays, "dateToleranceDays", 3),
      montoTolerancePct: optionalNumber(raw.montoTolerancePct, "montoTolerancePct", 5.0),
      fuzzyThreshold: optionalNumber(raw.fuzzyThreshold, "fuzzyThreshold", 80),
    });

    return c.json(resultado);
  });

  /** Alertas de antigüedad/comisión/duplicados sobre un lote de movimientos ya
   * parseados — no requiere conciliarlos primero (opera sobre los movimientos tal
   * cual, el cliente decide si son ya el subconjunto "sin conciliar"). */
  app.post("/despachos/:propertyId/conciliacion/alertas", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly movimientos?: unknown; readonly declaredIncome?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);

    const porMovimiento = movimientos.flatMap((m) => revisarMovimiento(m));
    const duplicados = revisarDuplicados(movimientos);
    const totalDeposits = movimientos.filter((m) => m.monto > 0).reduce((acc, m) => acc + m.monto, 0);
    const declaredIncome = typeof raw.declaredIncome === "number" ? raw.declaredIncome : 0;
    const discrepanciaIngresos = revisarDiscrepanciaIngresos(totalDeposits, declaredIncome);

    return c.json({
      alertas: [...porMovimiento, ...duplicados, ...(discrepanciaIngresos ? [discrepanciaIngresos] : [])],
    });
  });

  /** Clasificación automática de un depósito (ingreso/financiamiento/aportación de
   * socio/garantía/otro) — CFF Art. 59 fr. III. */
  app.post("/despachos/:propertyId/conciliacion/clasificar-deposito", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly descripcion?: unknown; readonly referencia?: unknown }>(c.req.raw, 8 * 1024);
    const descripcion = requireString(raw.descripcion, "descripcion");
    const referencia = typeof raw.referencia === "string" ? raw.referencia : null;
    return c.json(clasificarDeposito(descripcion, referencia));
  });

  /** Verificación de un pago SPEI/proveedor contra los movimientos ya parseados —
   * SOLO el matching por clave de rastreo/RFC (100% portable); la consulta real a
   * STP/Banxico CEP no está conectada en esta fase (ver spei-matching.ts). */
  app.post("/despachos/:propertyId/conciliacion/verificar-spei", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly movimientos?: unknown; readonly claveRastreo?: unknown; readonly rfc?: unknown; readonly monto?: unknown; readonly fecha?: unknown; readonly dateToleranceDays?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);
    const monto = optionalNumber(raw.monto, "monto", NaN);
    if (!Number.isFinite(monto)) throw Errors.validation("monto: se esperaba un número.");
    const fecha = requireString(raw.fecha, "fecha");
    const dateToleranceDays = optionalNumber(raw.dateToleranceDays, "dateToleranceDays", 3);

    if (typeof raw.claveRastreo === "string" && raw.claveRastreo.length > 0) {
      return c.json(verificarSpeiContraMovimientos(raw.claveRastreo, monto, fecha, movimientos, dateToleranceDays));
    }
    if (typeof raw.rfc === "string" && raw.rfc.length > 0) {
      return c.json(verificarPagoProveedor(raw.rfc, monto, fecha, movimientos, dateToleranceDays));
    }
    throw Errors.validation("Se requiere claveRastreo o rfc.");
  });

  return app;
}

// Generador del papel de trabajo de devolución de IVA — puerto de
// `WorkpaperGenerator.generate` (workpaper.py). Ensambla en 7 secciones los
// números YA calculados por `calculo.ts` — no reintroduce cálculos nuevos.
//
// Sección 7 ("no discrepancia fiscal — depósitos bancarios", REQ-IVA-009) en
// el origen depende de `PapelTrabajoConciliacion` (producido por
// `reconciliacion_ingresos_egresos`, un motor DISTINTO de este módulo, fuera
// del árbol `devolucion_iva/`). Esta fase NO porta ese motor completo — ya
// existe en domain-despachos un puerto parcial y ya expuesto por HTTP de la
// pieza relevante (`conciliacion/classification.ts::clasificarDeposito` /
// `evaluarCasoDepositoSospechoso`, Fase 5, `POST .../conciliacion/
// clasificar-deposito`). Por eso la sección 7 aquí acepta una lista ya
// clasificada de depósitos (el cliente HTTP corre `clasificarDeposito` por
// cada depósito bancario del periodo y se la pasa a este generador) en vez
// de re-derivar `PapelTrabajoConciliacion` desde cero — mismo criterio de
// "no dupliques esa lógica" que pide la tarea. Sin esa lista, la sección se
// genera igual (7 secciones siempre, nunca 6) marcada `disponible: false`,
// igual que el origen.
import { clasificarIva, calcularSaldoFavor, calcularMontoDevolucion, conciliarDeclaracionSaldo, conciliarFacturasDiot, conciliarDiotDeclaracion } from "./calculo.ts";
import type { DeclaracionMensualIva, DiotEntryIva, FacturaCfdiIva } from "./types.ts";
import type { ResultadoClasificacionDeposito } from "../conciliacion/classification.ts";

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** ADR-4 / REQ-IVA-011 — el Art. 59 fracción III CFF nunca se aplica por
 * cuenta propia; ver `conciliacion/classification.ts` (misma advertencia ya
 * usada en Fase 5, `NOTA_ART_59_FR_III_CFF`) — se reutiliza literalmente el
 * mismo texto para no bifurcar la advertencia fiscal en dos redacciones. */
export const ADVERTENCIA_ART_59_FRACC_III =
  "Ninguna clasificación de depósito de esta sección es una determinación fiscal firme. La presunción de ingreso gravado del Art. 59 fracción III CFF exige facultades de comprobación previas y evidencia documental real (contrato de mutuo, acta de asamblea, contrato de garantía); toda clasificación automática de primera pasada es una sugerencia sujeta a revisión y aprobación humana explícita (ADR-4).";

function seccion1Resumen(periodo: string, facturas: readonly FacturaCfdiIva[], diotEntries: readonly DiotEntryIva[], declaraciones: readonly DeclaracionMensualIva[]) {
  const clasif = clasificarIva(facturas);
  return {
    periodo,
    resumenFacturas: {
      totalFacturas: facturas.length,
      acreditable100Count: clasif.acreditable_100.length,
      acreditableProporcionalCount: clasif.acreditable_proporcional.length,
      noAcreditableCount: clasif.no_acreditable.length,
      totalSubtotal: r2(facturas.reduce((a, f) => a + f.subtotal, 0)),
      totalIvaTrasladado: r2(facturas.reduce((a, f) => a + f.iva, 0)),
      totalGravado: r2(facturas.reduce((a, f) => a + f.total, 0)),
    },
    resumenDiot: {
      totalEntradas: diotEntries.length,
      totalIvaTrasladado: r2(diotEntries.reduce((a, e) => a + e.ivaTrasladado, 0)),
      totalIvaAcreditable: r2(diotEntries.reduce((a, e) => a + e.ivaAcreditable, 0)),
    },
    resumenDeclaraciones: {
      totalDeclaraciones: declaraciones.length,
      totalIvaCobrado: r2(declaraciones.reduce((a, d) => a + d.ivaCobrado, 0)),
      totalIvaPagado: r2(declaraciones.reduce((a, d) => a + d.ivaPagado, 0)),
      totalSaldoFavor: r2(declaraciones.reduce((a, d) => a + d.saldoFavor, 0)),
      totalSaldoContra: r2(declaraciones.reduce((a, d) => a + d.saldoContra, 0)),
    },
  };
}

function seccion2DiotPorProveedor(diotEntries: readonly DiotEntryIva[]) {
  const proveedores = diotEntries.map((e) => ({
    rfc: e.rfcTercero,
    nombre: e.nombre,
    tipoOperacion: e.tipoOperacion,
    montoNeto: e.montoNeto,
    ivaTrasladado: e.ivaTrasladado,
    ivaAcreditable: e.ivaAcreditable,
    numFacturas: e.foliosFiscales.length,
    foliosFiscales: e.foliosFiscales,
    facturasDetalle: e.facturasDetalle,
  }));
  return {
    proveedores,
    totalProveedores: proveedores.length,
    totalMontoNeto: r2(proveedores.reduce((a, p) => a + p.montoNeto, 0)),
    totalIvaTrasladado: r2(proveedores.reduce((a, p) => a + p.ivaTrasladado, 0)),
    totalIvaAcreditable: r2(proveedores.reduce((a, p) => a + p.ivaAcreditable, 0)),
  };
}

function seccion3ConciliacionCfdiDiot(facturas: readonly FacturaCfdiIva[], diotEntries: readonly DiotEntryIva[]) {
  const results = conciliarFacturasDiot(facturas, diotEntries);
  const matches = results.filter((r) => r.status === "match");
  const mismatches = results.filter((r) => r.status === "mismatch");
  const missing = results.filter((r) => r.status === "missing");
  return {
    totalFacturas: results.length,
    matches: matches.length,
    mismatches: mismatches.length,
    missing: missing.length,
    tasaConciliacion: results.length > 0 ? Math.round(((matches.length / results.length) * 100 + Number.EPSILON) * 10) / 10 : 0,
    detalleMismatches: mismatches.map((r) => ({ facturaUuid: r.facturaUuid, detalles: r.detalles })),
    detalleMissing: missing.map((r) => ({ facturaUuid: r.facturaUuid, detalles: r.detalles })),
  };
}

function seccion4ConciliacionDiotDeclaracion(diotEntries: readonly DiotEntryIva[], declaraciones: readonly DeclaracionMensualIva[]) {
  const results = conciliarDiotDeclaracion(diotEntries, declaraciones);
  const matches = results.filter((r) => r.status === "match");
  const mismatches = results.filter((r) => r.status === "mismatch");
  return {
    totalDeclaraciones: results.length,
    matches: matches.length,
    mismatches: mismatches.length,
    tasaConciliacion: results.length > 0 ? Math.round(((matches.length / results.length) * 100 + Number.EPSILON) * 10) / 10 : 0,
    detalle: results,
  };
}

function seccion5Balance(declaraciones: readonly DeclaracionMensualIva[], _diotEntries: readonly DiotEntryIva[]) {
  const saldoFavor = calcularSaldoFavor(declaraciones);
  const montoCalc = calcularMontoDevolucion(saldoFavor, declaraciones);
  const verificacion = conciliarDeclaracionSaldo(declaraciones, saldoFavor);
  return { saldoAFavor: r2(saldoFavor), montoDevolucion: montoCalc, verificacion };
}

function seccion6Documentos(documentos: readonly string[]) {
  const lower = documentos.map((d) => d.toLowerCase());
  return {
    documentos,
    totalDocumentos: documentos.length,
    checklist: {
      cfdiCompra: lower.some((d) => d.includes("cfdi") || d.includes("factura")),
      diot: lower.some((d) => d.includes("diot")),
      declaraciones: lower.some((d) => d.includes("declaracion")),
      estadosCuenta: lower.some((d) => d.includes("banco") || d.includes("estado")),
      balanza: lower.some((d) => d.includes("balanza")),
    },
  };
}

function seccion7NoDiscrepanciaDepositos(depositos?: readonly ResultadoClasificacionDeposito[]) {
  if (!depositos || depositos.length === 0) {
    return {
      disponible: false,
      mensaje: "No se proporcionó papel de conciliación de ingresos/egresos (depósitos bancarios) para este período; sección informativa sin datos.",
      totalDepositosClasificados: 0,
      clasificacionesDepositos: [],
      resumenPorClasificacion: {} as Record<string, number>,
      requiereRevisionHumana: false,
      advertenciaFiscal: ADVERTENCIA_ART_59_FRACC_III,
    };
  }

  const resumenPorClasificacion: Record<string, number> = {};
  for (const d of depositos) {
    resumenPorClasificacion[d.clasificacion] = (resumenPorClasificacion[d.clasificacion] ?? 0) + 1;
  }
  return {
    disponible: true,
    mensaje: null,
    totalDepositosClasificados: depositos.length,
    clasificacionesDepositos: depositos,
    resumenPorClasificacion,
    requiereRevisionHumana: depositos.some((d) => d.requiresHumanReview),
    advertenciaFiscal: ADVERTENCIA_ART_59_FRACC_III,
  };
}

export interface PapelTrabajoDevolucionIva {
  readonly periodo: string;
  readonly tenantId: string | null;
  readonly secciones: {
    readonly "1_resumen_periodo": ReturnType<typeof seccion1Resumen>;
    readonly "2_diot_por_proveedor": ReturnType<typeof seccion2DiotPorProveedor>;
    readonly "3_conciliacion_cfdi_diot": ReturnType<typeof seccion3ConciliacionCfdiDiot>;
    readonly "4_conciliacion_diot_declaracion": ReturnType<typeof seccion4ConciliacionDiotDeclaracion>;
    readonly "5_calculo_saldo": ReturnType<typeof seccion5Balance>;
    readonly "6_documentos_soporte": ReturnType<typeof seccion6Documentos>;
    readonly "7_no_discrepancia_fiscal_depositos": ReturnType<typeof seccion7NoDiscrepanciaDepositos>;
  };
  readonly metadata: {
    readonly generadoPor: string;
    readonly version: string;
    readonly totalFacturas: number;
    readonly totalDiotEntries: number;
    readonly totalDeclaraciones: number;
  };
}

/** `WorkpaperGenerator.generate` — siempre las 7 secciones, con o sin
 * `documentosSoporte`/`depositosClasificados`. */
export function generarPapelTrabajo(
  periodo: string,
  facturas: readonly FacturaCfdiIva[],
  diotEntries: readonly DiotEntryIva[],
  declaraciones: readonly DeclaracionMensualIva[],
  opts: { readonly tenantId?: string | null; readonly documentosSoporte?: readonly string[]; readonly depositosClasificados?: readonly ResultadoClasificacionDeposito[] } = {},
): PapelTrabajoDevolucionIva {
  return {
    periodo,
    tenantId: opts.tenantId ?? null,
    secciones: {
      "1_resumen_periodo": seccion1Resumen(periodo, facturas, diotEntries, declaraciones),
      "2_diot_por_proveedor": seccion2DiotPorProveedor(diotEntries),
      "3_conciliacion_cfdi_diot": seccion3ConciliacionCfdiDiot(facturas, diotEntries),
      "4_conciliacion_diot_declaracion": seccion4ConciliacionDiotDeclaracion(diotEntries, declaraciones),
      "5_calculo_saldo": seccion5Balance(declaraciones, diotEntries),
      "6_documentos_soporte": seccion6Documentos(opts.documentosSoporte ?? []),
      "7_no_discrepancia_fiscal_depositos": seccion7NoDiscrepanciaDepositos(opts.depositosClasificados),
    },
    metadata: {
      generadoPor: "atiende-fusion - Devolución de IVA",
      version: "1.0",
      totalFacturas: facturas.length,
      totalDiotEntries: diotEntries.length,
      totalDeclaraciones: declaraciones.length,
    },
  };
}

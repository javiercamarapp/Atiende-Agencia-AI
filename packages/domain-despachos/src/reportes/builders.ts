// Constructores de los 4 reportes de cliente de D-01 (balanza, DIOT, nómina, impuestos).
// Puros: reciben los registros YA leídos del modelo y devuelven un `ReporteCliente`. Todo
// número sale de un registro persistido; lo que el modelo no guarda se declara "sin datos".
//
// Qué fuente real respalda cada reporte (y qué NO existe todavía):
//  - DIOT: `invoice` (CFDI 4.0 tipo "I" reportables) vía `construirDiotDesdeInvoices` — la
//    misma regla que `GET .../declaraciones/diot/:periodo`.
//  - Impuestos: IVA acreditable de los CFDI tipo "I" válidos del período (`invoice.iva`,
//    convención DIOT del repo) + obligaciones del período en `fiscal_deadline`. NO hay CFDI
//    emitidos por el contribuyente ni ingresos persistidos => IVA trasladado/IVA a cargo e
//    ISR del período quedan "sin datos".
//  - Nómina: CFDI tipo "N" ingeridos en el período (`invoice`). La nómina procesada
//    (ISR retenido/IMSS por empleado) no se persiste => ese desglose queda "sin datos".
//  - Balanza: el modelo NO persiste asientos/pólizas, así que la balanza de comprobación
//    queda "sin datos"; se agrega el resumen por categoría contable de los CFDI del período
//    (dato real) como insumo, rotulado como tal, nunca como balanza.
import { construirDiotDesdeInvoices } from "../declaraciones/diot-desde-invoices.ts";
import type { FiscalDeadlineRecord, InvoiceRecord } from "../types.ts";
import { ETIQUETA_TIPO_REPORTE } from "./types.ts";
import type { CeldaReporte, ColumnaReporte, ReporteCliente, SeccionReporte, TipoReporteCliente } from "./types.ts";

export interface EntradaReporte {
  readonly periodo: string; // "YYYY-MM"
  readonly generadoEn: string; // "YYYY-MM-DD"
  readonly contribuyente: { readonly nombre: string };
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const TIPO_OPERACION_DIOT: Readonly<Record<string, string>> = {
  "03": "03 - Prestación de servicios profesionales",
  "06": "06 - Arrendamiento de inmuebles",
  "85": "85 - Otros",
};

/** RFC del contribuyente según los CFDI ingeridos (receptor del primero); `null` sin CFDI. */
function rfcDesdeInvoices(invoices: readonly InvoiceRecord[]): string | null {
  return invoices[0]?.rfcReceptor ?? null;
}

function seccionSinDatos(titulo: string, columnas: readonly ColumnaReporte[], motivo: string): SeccionReporte {
  return { titulo, columnas, filas: [], totales: null, sinDatosMotivo: motivo };
}

function ensamblar(tipo: TipoReporteCliente, entrada: EntradaReporte, rfc: string | null, secciones: readonly SeccionReporte[], notas: readonly string[]): ReporteCliente {
  return {
    tipo,
    titulo: ETIQUETA_TIPO_REPORTE[tipo],
    periodo: entrada.periodo,
    generadoEn: entrada.generadoEn,
    contribuyente: { nombre: entrada.contribuyente.nombre, rfc },
    secciones,
    notas,
    sinDatos: secciones.every((s) => s.filas.length === 0),
  };
}

const COLUMNAS_SIN_DATOS_UNICA: readonly ColumnaReporte[] = [{ clave: "concepto", titulo: "Concepto", tipo: "texto" }];

// ---------------------------------------------------------------------------
// DIOT
// ---------------------------------------------------------------------------
export function construirReporteDiot(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[]): ReporteCliente {
  const diot = construirDiotDesdeInvoices(invoicesDelPeriodo, entrada.periodo);
  const columnas: readonly ColumnaReporte[] = [
    { clave: "rfc", titulo: "RFC del tercero", tipo: "texto" },
    { clave: "nombre", titulo: "Nombre o razón social", tipo: "texto" },
    { clave: "tipoOperacion", titulo: "Tipo de operación", tipo: "texto" },
    { clave: "operaciones", titulo: "CFDI", tipo: "entero" },
    { clave: "montoNeto", titulo: "Valor de actos (base)", tipo: "moneda" },
    { clave: "iva16", titulo: "IVA acreditable 16%", tipo: "moneda" },
    { clave: "iva0", titulo: "IVA acreditable 0%", tipo: "moneda" },
    { clave: "ivaExento", titulo: "IVA otras tasas / exento", tipo: "moneda" },
  ];

  const seccion: SeccionReporte =
    diot.registros.length === 0
      ? seccionSinDatos("Operaciones con terceros", columnas, "No hay CFDI 4.0 tipo Ingreso reportables ingeridos en el período para este contribuyente.")
      : {
          titulo: "Operaciones con terceros",
          columnas,
          filas: diot.registros.map((r) => ({
            rfc: r.rfcTercero,
            nombre: r.nombre,
            tipoOperacion: TIPO_OPERACION_DIOT[r.tipoOperacion] ?? r.tipoOperacion,
            operaciones: r.count,
            montoNeto: r2(r.montoNeto),
            iva16: r2(r.ivaAcreditable16),
            iva0: r2(r.ivaAcreditable0),
            ivaExento: r2(r.ivaExento),
          })),
          totales: {
            rfc: "Total",
            nombre: null,
            tipoOperacion: null,
            operaciones: diot.registros.reduce((a, r) => a + r.count, 0),
            montoNeto: r2(diot.totalMontoNeto),
            iva16: r2(diot.registros.reduce((a, r) => a + r.ivaAcreditable16, 0)),
            iva0: r2(diot.registros.reduce((a, r) => a + r.ivaAcreditable0, 0)),
            ivaExento: r2(diot.registros.reduce((a, r) => a + r.ivaExento, 0)),
          },
          sinDatosMotivo: null,
        };

  return ensamblar("diot", entrada, diot.rfcContribuyente ?? rfcDesdeInvoices(invoicesDelPeriodo), [seccion], [
    "Reporte informativo para el cliente, calculado desde los CFDI 4.0 ya ingeridos; no es el archivo de carga por lotes del SAT ni sustituye la presentación de la DIOT.",
    "El tipo de operación es 85 (Otros) salvo que el proveedor tenga una naturaleza capturada explícitamente (03 servicios profesionales, 06 arrendamiento).",
    "Los RFC genéricos (XAXX010101000, XEXX010101000) se excluyen, conforme a la regla de DIOT.",
  ]);
}

// ---------------------------------------------------------------------------
// Impuestos (IVA / ISR) y obligaciones fiscales
// ---------------------------------------------------------------------------
export function construirReporteImpuestos(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[], vencimientosDelPeriodo: readonly FiscalDeadlineRecord[]): ReporteCliente {
  const ingreso = invoicesDelPeriodo.filter((i) => i.tipo === "I");
  const validos = ingreso.filter((i) => i.valido);
  const excluidos = ingreso.length - validos.length;

  const colIva: readonly ColumnaReporte[] = [
    { clave: "concepto", titulo: "Concepto", tipo: "texto" },
    { clave: "cfdi", titulo: "CFDI", tipo: "entero" },
    { clave: "base", titulo: "Base (subtotal)", tipo: "moneda" },
    { clave: "iva", titulo: "IVA", tipo: "moneda" },
  ];
  const seccionIva: SeccionReporte =
    validos.length === 0
      ? seccionSinDatos("IVA acreditable de CFDI 4.0 tipo Ingreso", colIva, "No hay CFDI 4.0 tipo Ingreso válidos ingeridos en el período.")
      : {
          titulo: "IVA acreditable de CFDI 4.0 tipo Ingreso",
          columnas: colIva,
          filas: [
            {
              concepto: "IVA de CFDI válidos del período",
              cfdi: validos.length,
              base: r2(validos.reduce((a, i) => a + i.subtotal, 0)),
              iva: r2(validos.reduce((a, i) => a + (i.iva ?? 0), 0)),
            },
          ],
          totales: null,
          sinDatosMotivo: null,
        };

  const seccionFaltante = seccionSinDatos(
    "IVA trasladado, IVA a cargo/a favor e ISR del período",
    COLUMNAS_SIN_DATOS_UNICA,
    "El modelo no persiste los CFDI emitidos por el contribuyente ni sus ingresos del período; el IVA trasladado, el saldo de IVA y el ISR (provisional) no pueden calcularse sin inventar cifras. Use la calculadora de Declaraciones con los ingresos capturados.",
  );

  const colObl: readonly ColumnaReporte[] = [
    { clave: "obligacion", titulo: "Obligación", tipo: "texto" },
    { clave: "fechaLimite", titulo: "Fecha límite", tipo: "texto" },
    { clave: "estado", titulo: "Estado", tipo: "texto" },
    { clave: "prioridad", titulo: "Prioridad", tipo: "texto" },
    { clave: "presentacion", titulo: "Presentada el", tipo: "texto" },
  ];
  const seccionObl: SeccionReporte =
    vencimientosDelPeriodo.length === 0
      ? seccionSinDatos("Obligaciones fiscales del período (SAT)", colObl, "No hay vencimientos fiscales registrados para el período.")
      : {
          titulo: "Obligaciones fiscales del período (SAT)",
          columnas: colObl,
          filas: [...vencimientosDelPeriodo]
            .sort((a, b) => a.fechaLimite.localeCompare(b.fechaLimite) || a.tipo.localeCompare(b.tipo, "es"))
            .map((v) => ({ obligacion: v.tipo, fechaLimite: v.fechaLimite, estado: v.estado, prioridad: v.prioridad, presentacion: v.fechaPresentacion })),
          totales: null,
          sinDatosMotivo: null,
        };

  const notas = [
    "El IVA mostrado sigue la convención de la DIOT del sistema (IVA de los CFDI de ingreso ingeridos, tratado como acreditable). No es una declaración de IVA ni determina el saldo a cargo o a favor.",
    "Los vencimientos corresponden al período fiscal indicado y se presentan hasta el día 17 del mes siguiente.",
  ];
  if (excluidos > 0) notas.push(`${excluidos} CFDI tipo Ingreso con hallazgos de validación se excluyeron del IVA acreditable.`);
  return ensamblar("impuestos", entrada, rfcDesdeInvoices(invoicesDelPeriodo), [seccionIva, seccionFaltante, seccionObl], notas);
}

// ---------------------------------------------------------------------------
// Nómina
// ---------------------------------------------------------------------------
export function construirReporteNomina(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[]): ReporteCliente {
  const nominas = invoicesDelPeriodo.filter((i) => i.tipo === "N");
  const columnas: readonly ColumnaReporte[] = [
    { clave: "fecha", titulo: "Fecha", tipo: "texto" },
    { clave: "folioFiscal", titulo: "Folio fiscal (UUID)", tipo: "texto" },
    { clave: "emisor", titulo: "RFC emisor", tipo: "texto" },
    { clave: "receptor", titulo: "RFC receptor (empleado)", tipo: "texto" },
    { clave: "total", titulo: "Total del recibo", tipo: "moneda" },
    { clave: "valido", titulo: "Validación", tipo: "texto" },
  ];
  const seccionCfdi: SeccionReporte =
    nominas.length === 0
      ? seccionSinDatos("Recibos de nómina (CFDI 4.0 tipo N) ingeridos", columnas, "No hay CFDI de nómina (tipo N) ingeridos en el período.")
      : {
          titulo: "Recibos de nómina (CFDI 4.0 tipo N) ingeridos",
          columnas,
          filas: [...nominas]
            .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.folioFiscal.localeCompare(b.folioFiscal))
            .map((i) => ({ fecha: i.fecha, folioFiscal: i.folioFiscal, emisor: i.rfcEmisor, receptor: i.rfcReceptor, total: r2(i.total), valido: i.valido ? "Válido" : "Con hallazgos" })),
          totales: { fecha: "Total", folioFiscal: `${nominas.length} recibo(s)`, emisor: null, receptor: null, total: r2(nominas.reduce((a, i) => a + i.total, 0)), valido: null },
          sinDatosMotivo: null,
        };

  const seccionDesglose = seccionSinDatos(
    "Desglose por empleado: ISR retenido, IMSS e INFONAVIT",
    COLUMNAS_SIN_DATOS_UNICA,
    "La nómina procesada (percepciones, ISR retenido, cuotas IMSS/INFONAVIT por empleado) no se persiste en el modelo; solo se conservan los recibos CFDI ingeridos. Use la calculadora de Nómina para un cálculo puntual.",
  );

  return ensamblar("nomina", entrada, rfcDesdeInvoices(invoicesDelPeriodo), [seccionCfdi, seccionDesglose], [
    "El total del recibo es el importe del CFDI tipo N ingerido; no equivale al sueldo bruto ni al neto sin el desglose de percepciones y deducciones del complemento de nómina 1.2.",
  ]);
}

// ---------------------------------------------------------------------------
// Balanza (insumo: CFDI por categoría contable)
// ---------------------------------------------------------------------------
const ETIQUETA_CATEGORIA: Readonly<Record<string, string>> = {
  gasto_operativo: "Gasto operativo",
  activo_fijo: "Activo fijo",
  inversion: "Inversión",
  honorarios: "Honorarios",
  nomina: "Nómina",
  sin_clasificar: "Sin clasificar",
};

export function construirReporteBalanza(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[]): ReporteCliente {
  const seccionBalanza = seccionSinDatos(
    "Balanza de comprobación",
    [
      { clave: "cuenta", titulo: "Cuenta (código agrupador SAT)", tipo: "texto" },
      { clave: "saldoInicial", titulo: "Saldo inicial", tipo: "moneda" },
      { clave: "debe", titulo: "Debe", tipo: "moneda" },
      { clave: "haber", titulo: "Haber", tipo: "moneda" },
      { clave: "saldoFinal", titulo: "Saldo final", tipo: "moneda" },
    ],
    "El modelo no persiste asientos ni pólizas contables, por lo que la balanza de comprobación no puede calcularse sin inventar saldos. La generación del XML de balanza (Anexo 24) sigue disponible en Contabilidad electrónica a partir de los asientos que se le proporcionen.",
  );

  const porCategoria = new Map<string, { cfdi: number; subtotal: number; iva: number; total: number }>();
  for (const inv of invoicesDelPeriodo) {
    const acc = porCategoria.get(inv.categoria) ?? { cfdi: 0, subtotal: 0, iva: 0, total: 0 };
    acc.cfdi += 1;
    acc.subtotal += inv.subtotal;
    acc.iva += inv.iva ?? 0;
    acc.total += inv.total;
    porCategoria.set(inv.categoria, acc);
  }
  const columnas: readonly ColumnaReporte[] = [
    { clave: "categoria", titulo: "Categoría contable", tipo: "texto" },
    { clave: "cfdi", titulo: "CFDI", tipo: "entero" },
    { clave: "subtotal", titulo: "Subtotal", tipo: "moneda" },
    { clave: "iva", titulo: "IVA", tipo: "moneda" },
    { clave: "total", titulo: "Total", tipo: "moneda" },
  ];
  const seccionResumen: SeccionReporte =
    porCategoria.size === 0
      ? seccionSinDatos("Resumen de CFDI del período por categoría contable (insumo, no es la balanza)", columnas, "No hay CFDI ingeridos en el período.")
      : {
          titulo: "Resumen de CFDI del período por categoría contable (insumo, no es la balanza)",
          columnas,
          filas: [...porCategoria.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .map(([cat, v]) => ({ categoria: ETIQUETA_CATEGORIA[cat] ?? cat, cfdi: v.cfdi, subtotal: r2(v.subtotal), iva: r2(v.iva), total: r2(v.total) })),
          totales: {
            categoria: "Total",
            cfdi: invoicesDelPeriodo.length,
            subtotal: r2([...porCategoria.values()].reduce((a, v) => a + v.subtotal, 0)),
            iva: r2([...porCategoria.values()].reduce((a, v) => a + v.iva, 0)),
            total: r2([...porCategoria.values()].reduce((a, v) => a + v.total, 0)),
          },
          sinDatosMotivo: null,
        };

  return ensamblar("balanza", entrada, rfcDesdeInvoices(invoicesDelPeriodo), [seccionBalanza, seccionResumen], [
    "La clasificación por categoría proviene de la clasificación contable guardada en cada CFDI; los CFDI 'Sin clasificar' aún no tienen cuenta asignada.",
    "Mezcla CFDI de todos los tipos (I, E, T, P, N) de la fecha de emisión del período; el resumen no netea notas de crédito.",
  ]);
}

export function construirReporteCliente(
  tipo: TipoReporteCliente,
  entrada: EntradaReporte,
  fuentes: { readonly invoicesDelPeriodo: readonly InvoiceRecord[]; readonly vencimientosDelPeriodo: readonly FiscalDeadlineRecord[] },
): ReporteCliente {
  switch (tipo) {
    case "diot":
      return construirReporteDiot(entrada, fuentes.invoicesDelPeriodo);
    case "impuestos":
      return construirReporteImpuestos(entrada, fuentes.invoicesDelPeriodo, fuentes.vencimientosDelPeriodo);
    case "nomina":
      return construirReporteNomina(entrada, fuentes.invoicesDelPeriodo);
    case "balanza":
      return construirReporteBalanza(entrada, fuentes.invoicesDelPeriodo);
  }
}

export type { CeldaReporte };

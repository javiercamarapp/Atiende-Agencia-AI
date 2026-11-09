// Constructores de los 4 reportes de cliente de D-01 (balanza, DIOT, nómina, impuestos).
// Puros: reciben los registros YA leídos del modelo y devuelven un `ReporteCliente`. Todo
// número sale de un registro persistido; lo que el modelo no guarda se declara "sin datos".
//
// Qué fuente real respalda cada reporte (y qué NO existe todavía):
//  - DIOT: `invoice` (CFDI 4.0 tipo "I" reportables) vía `construirDiotDesdeInvoices` — la
//    misma regla que `GET .../declaraciones/diot/:periodo`.
//  - Impuestos (D-P3-05): el papel de pagos provisionales persistido del período (D-25: IVA e ISR
//    por flujo de efectivo) + obligaciones del período en `fiscal_deadline`. Sin papel guardado
//    => "sin datos" con el motivo verdadero (no se ha generado el papel de AAAA-MM).
//  - Nómina: CFDI tipo "N" ingeridos en el período (`invoice`). La nómina procesada
//    (ISR retenido/IMSS por empleado) no se persiste => ese desglose queda "sin datos".
//  - Balanza: con el libro contable (D-24, migración 020) sale de las pólizas registradas; sin libro
//    queda "sin datos"; se agrega el resumen por categoría contable de los CFDI del período
//    (dato real) como insumo, rotulado como tal, nunca como balanza.
import { construirDiotDesdeInvoices } from "../declaraciones/diot-desde-invoices.ts";
import type { LineaBalanzaLibro } from "../libro/types.ts";
import type { PapelGuardado } from "../pagos-provisionales/repository.ts";
import type { FiscalDeadlineRecord, InvoiceRecord } from "../types.ts";
import { ETIQUETA_TIPO_REPORTE } from "./types.ts";
import type { CeldaReporte, ColumnaReporte, ReporteCliente, SeccionReporte, TipoReporteCliente } from "./types.ts";

export interface EntradaReporte {
  readonly periodo: string; // "YYYY-MM"
  readonly generadoEn: string; // "YYYY-MM-DD"
  readonly contribuyente: { readonly nombre: string };
  /** RFC de la ficha de cartera del cliente (D-P3-01): es el UNICO origen del RFC del contribuyente; `null`/ausente = sin ficha. */
  readonly rfcContribuyente?: string | null;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const TIPO_OPERACION_DIOT: Readonly<Record<string, string>> = {
  "03": "03 - Prestación de servicios profesionales",
  "06": "06 - Arrendamiento de inmuebles",
  "85": "85 - Otros",
};

/** RFC del contribuyente: el de la ficha de cartera. Nunca se deriva de un CFDI (el receptor del primero puede ser un empleado o un tercero). */
function rfcDeFicha(entrada: EntradaReporte): string | null {
  return entrada.rfcContribuyente ?? null;
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
function diotSinDatosMotivo(excluidos: number, rfc: string | null): string {
  if (rfc === null) return "El cliente no tiene ficha de cartera con RFC: sin el RFC del contribuyente no se puede armar la DIOT. Captura la ficha en Cartera.";
  if (excluidos > 0) return `No hay compras (CFDI recibidos, vigentes y válidos) reportables en el período; ${excluidos} CFDI quedaron fuera por ser emitidos por el cliente, cancelados o con hallazgos de validación.`;
  return "No hay CFDI 4.0 tipo Ingreso recibidos y reportables ingeridos en el período para este contribuyente.";
}

export function construirReporteDiot(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[]): ReporteCliente {
  const diot = construirDiotDesdeInvoices(invoicesDelPeriodo, entrada.periodo, rfcDeFicha(entrada));
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
      ? seccionSinDatos("Operaciones con terceros", columnas, diotSinDatosMotivo(diot.excluidos, rfcDeFicha(entrada)))
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

  return ensamblar("diot", entrada, rfcDeFicha(entrada), [seccion], [
    "Reporte informativo para el cliente, calculado desde los CFDI 4.0 ya ingeridos; no es el archivo de carga por lotes del SAT ni sustituye la presentación de la DIOT.",
    "El tipo de operación es 85 (Otros) salvo que el proveedor tenga una naturaleza capturada explícitamente (03 servicios profesionales, 06 arrendamiento).",
    "Los RFC genéricos (XAXX010101000, XEXX010101000) se excluyen, conforme a la regla de DIOT.",
    "Solo cuentan las compras del cliente: los CFDI que el propio cliente emitió (sus ventas), los cancelados o no encontrados ante el SAT y los que no pasan la validación no se reportan como proveedores.",
    ...(diot.excluidos > 0 && diot.registros.length > 0 ? [`${diot.excluidos} CFDI se dejaron fuera por no ser compras vigentes y válidas del cliente.`] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Impuestos (IVA / ISR) y obligaciones fiscales
// ---------------------------------------------------------------------------
/** Papeles de pagos provisionales YA persistidos (D-25) del periodo del reporte. `no_disponible` = la base aun no tiene la migracion 020. */
export interface PapelesReporte {
  readonly estado: "disponible" | "no_disponible";
  readonly papeles: readonly PapelGuardado[];
}

const pesos = (centavos: number): number => r2(centavos / 100);

/**
 * D-P3-05: el reporte de impuestos sale del papel de pagos provisionales PERSISTIDO del periodo (D-25), no de una suma de CFDI.
 * Antes decia "el modelo no persiste los CFDI emitidos" (falso desde D-22) y mostraba el IVA de los CFDI tipo I como acreditable
 * sin distinguir emitidos de recibidos. Sin papel guardado: "sin datos" con el motivo verdadero.
 */
export function construirReporteImpuestos(entrada: EntradaReporte, vencimientosDelPeriodo: readonly FiscalDeadlineRecord[], papeles: PapelesReporte): ReporteCliente {
  const [ejercicioTexto, mesTexto] = entrada.periodo.split("-");
  const ejercicio = Number(ejercicioTexto);
  const mes = Number(mesTexto);
  const delPeriodo = papeles.papeles.filter((p) => p.ejercicio === ejercicio && p.mes === mes);

  const colPapel: readonly ColumnaReporte[] = [
    { clave: "impuesto", titulo: "Impuesto", tipo: "texto" },
    { clave: "estado", titulo: "Estado del papel", tipo: "texto" },
    { clave: "regimen", titulo: "Régimen", tipo: "texto" },
    { clave: "base", titulo: "Base", tipo: "moneda" },
    { clave: "determinado", titulo: "Determinado", tipo: "moneda" },
    { clave: "acreditable", titulo: "Acreditable y retenciones", tipo: "moneda" },
    { clave: "aCargo", titulo: "A cargo", tipo: "moneda" },
    { clave: "aFavor", titulo: "A favor", tipo: "moneda" },
    { clave: "presentado", titulo: "Presentado el", tipo: "texto" },
  ];
  const tituloPapel = "Pagos provisionales de ISR e IVA (papel de trabajo)";
  const motivoSinPapel =
    papeles.estado === "no_disponible"
      ? "Los pagos provisionales todavía no están disponibles en esta base de datos (falta aplicar la migración 020): no hay papel que mostrar."
      : `No se ha generado el papel de pagos provisionales de ${entrada.periodo}: genéralo y guárdalo en Pagos provisionales para ver aquí el IVA y el ISR del periodo.`;
  const seccionPapel: SeccionReporte =
    delPeriodo.length === 0
      ? seccionSinDatos(tituloPapel, colPapel, motivoSinPapel)
      : {
          titulo: tituloPapel,
          columnas: colPapel,
          filas: [...delPeriodo]
            .sort((a, b) => a.impuesto.localeCompare(b.impuesto, "es"))
            .map((p) => ({
              impuesto: p.impuesto,
              estado: p.estado === "presentado" ? "Presentado" : "Borrador",
              regimen: p.regimen,
              base: pesos(p.baseCentavos),
              determinado: pesos(p.determinadoCentavos),
              acreditable: pesos(p.acreditableCentavos),
              aCargo: pesos(p.aCargoCentavos),
              aFavor: pesos(p.aFavorCentavos),
              presentado: p.fechaPresentacion,
            })),
          totales: null,
          sinDatosMotivo: null,
        };

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
    "Las cifras de IVA e ISR salen del papel de pagos provisionales guardado para el período (flujo de efectivo; ver la hoja del papel para sus exclusiones y advertencias). Un papel en Borrador no es una declaración presentada.",
    "Los vencimientos corresponden al período fiscal indicado; consulta la fecha límite de cada obligación en la tabla.",
  ];
  return ensamblar("impuestos", entrada, rfcDeFicha(entrada), [seccionPapel, seccionObl], notas);
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

  return ensamblar("nomina", entrada, rfcDeFicha(entrada), [seccionCfdi, seccionDesglose], [
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

/**
 * Balanza de comprobación. Con `balanzaLibro` (D-24, libro contable persistido, migración 020) con movimientos, la sección de balanza se llena con
 * las cuentas del libro del cliente (centavos -> pesos solo para mostrar); sin libro (base sin migrar o sin pólizas en el periodo) queda "sin datos"
 * con su motivo, como antes. El resumen de CFDI por categoría se conserva como insumo.
 */
export function construirReporteBalanza(entrada: EntradaReporte, invoicesDelPeriodo: readonly InvoiceRecord[], balanzaLibro?: readonly LineaBalanzaLibro[]): ReporteCliente {
  const pesos = (centavos: number): number => centavos / 100;
  const seccionBalanza: SeccionReporte =
    balanzaLibro && balanzaLibro.length > 0
      ? {
          titulo: "Balanza de comprobación",
          columnas: [
            { clave: "cuenta", titulo: "Cuenta del catálogo del cliente", tipo: "texto" },
            { clave: "saldoInicial", titulo: "Saldo inicial", tipo: "moneda" },
            { clave: "debe", titulo: "Debe", tipo: "moneda" },
            { clave: "haber", titulo: "Haber", tipo: "moneda" },
            { clave: "saldoFinal", titulo: "Saldo final", tipo: "moneda" },
          ],
          filas: balanzaLibro.map((l) => ({ cuenta: `${l.cuenta} ${l.descripcion}`, saldoInicial: pesos(l.saldoInicialCentavos), debe: pesos(l.debeCentavos), haber: pesos(l.haberCentavos), saldoFinal: pesos(l.saldoFinalCentavos) })),
          totales: { cuenta: "Total", saldoInicial: null, debe: pesos(balanzaLibro.reduce((s, l) => s + l.debeCentavos, 0)), haber: pesos(balanzaLibro.reduce((s, l) => s + l.haberCentavos, 0)), saldoFinal: null },
          sinDatosMotivo: null,
        }
      : seccionSinDatos(
          "Balanza de comprobación",
          [
            { clave: "cuenta", titulo: "Cuenta (código agrupador SAT)", tipo: "texto" },
            { clave: "saldoInicial", titulo: "Saldo inicial", tipo: "moneda" },
            { clave: "debe", titulo: "Debe", tipo: "moneda" },
            { clave: "haber", titulo: "Haber", tipo: "moneda" },
            { clave: "saldoFinal", titulo: "Saldo final", tipo: "moneda" },
          ],
          "El libro contable del cliente no tiene pólizas en este período (o la migración 020 aún no está aplicada), por lo que la balanza de comprobación no puede calcularse sin inventar saldos. Registra pólizas en Libro contable; la generación del XML (Anexo 24) está en Contabilidad electrónica.",
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

  return ensamblar("balanza", entrada, rfcDeFicha(entrada), [seccionBalanza, seccionResumen], [
    "La clasificación por categoría proviene de la clasificación contable guardada en cada CFDI; los CFDI 'Sin clasificar' aún no tienen cuenta asignada.",
    "Mezcla CFDI de todos los tipos (I, E, T, P, N) de la fecha de emisión del período; el resumen no netea notas de crédito.",
  ]);
}

export function construirReporteCliente(
  tipo: TipoReporteCliente,
  entrada: EntradaReporte,
  fuentes: { readonly invoicesDelPeriodo: readonly InvoiceRecord[]; readonly vencimientosDelPeriodo: readonly FiscalDeadlineRecord[]; readonly balanzaLibro?: readonly LineaBalanzaLibro[]; readonly papelesProvisionales?: PapelesReporte },
): ReporteCliente {
  switch (tipo) {
    case "diot":
      return construirReporteDiot(entrada, fuentes.invoicesDelPeriodo);
    case "impuestos":
      return construirReporteImpuestos(entrada, fuentes.vencimientosDelPeriodo, fuentes.papelesProvisionales ?? { estado: "no_disponible", papeles: [] });
    case "nomina":
      return construirReporteNomina(entrada, fuentes.invoicesDelPeriodo);
    case "balanza":
      return construirReporteBalanza(entrada, fuentes.invoicesDelPeriodo, fuentes.balanzaLibro);
  }
}

export type { CeldaReporte };

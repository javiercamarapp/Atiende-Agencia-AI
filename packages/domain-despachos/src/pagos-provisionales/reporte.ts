// D-25 -- el papel de trabajo como reporte tabular (JSON de pantalla, PDF y XLSX con el mismo modelo que los reportes de D-01).
// Los importes llegan en centavos enteros; solo AQUÍ se convierten a pesos para mostrarlos (la celda "moneda" del reporte son pesos).
import type { CeldaReporte, ColumnaReporte, ReporteTabular, SeccionReporte } from "../reportes/types.ts";
import type { LineaPapel, PapelProvisional, ResultadoImpuesto } from "./types.ts";

const pesos = (centavos: number): number => centavos / 100;

const COLUMNAS_LINEAS: readonly ColumnaReporte[] = [
  { clave: "concepto", titulo: "Concepto", tipo: "texto" },
  { clave: "importe", titulo: "Importe", tipo: "moneda" },
];

function seccionLineas(titulo: string, r: ResultadoImpuesto): SeccionReporte {
  if (r.estado !== "calculado") return { titulo, columnas: COLUMNAS_LINEAS, filas: [], totales: null, sinDatosMotivo: r.motivo ?? "Sin cálculo." };
  const filas = r.lineas.map((l: LineaPapel): Record<string, CeldaReporte> => ({ concepto: l.detalle ? `${l.concepto} (${l.detalle})` : l.concepto, importe: pesos(l.centavos) }));
  return { titulo, columnas: COLUMNAS_LINEAS, filas, totales: null, sinDatosMotivo: null };
}

export function construirReportePagosProvisionales(papel: PapelProvisional, entrada: { readonly nombre: string; readonly rfc: string | null; readonly generadoEn: string }): ReporteTabular {
  const periodo = `${papel.ejercicio}-${String(papel.mes).padStart(2, "0")}`;
  const columnasResultado: readonly ColumnaReporte[] = [
    { clave: "impuesto", titulo: "Impuesto", tipo: "texto" },
    { clave: "determinado", titulo: "Determinado", tipo: "moneda" },
    { clave: "acreditable", titulo: "Acreditamientos", tipo: "moneda" },
    { clave: "aCargo", titulo: "A cargo", tipo: "moneda" },
    { clave: "aFavor", titulo: "A favor", tipo: "moneda" },
  ];
  const fila = (nombre: string, r: ResultadoImpuesto): Record<string, CeldaReporte> => ({ impuesto: nombre, determinado: pesos(r.determinadoCentavos), acreditable: pesos(r.acreditableCentavos), aCargo: pesos(r.aCargoCentavos), aFavor: pesos(r.aFavorCentavos) });
  const resultado: SeccionReporte =
    papel.isr.estado === "calculado"
      ? { titulo: "Resultado", columnas: columnasResultado, filas: [fila("ISR", papel.isr), fila("IVA", papel.iva)], totales: null, sinDatosMotivo: null }
      : { titulo: "Resultado", columnas: columnasResultado, filas: [fila("IVA", papel.iva)], totales: null, sinDatosMotivo: null };
  const exclusiones: SeccionReporte = {
    titulo: "CFDI no incluidos",
    columnas: [
      { clave: "motivo", titulo: "Motivo", tipo: "texto" },
      { clave: "cantidad", titulo: "CFDI", tipo: "entero" },
      { clave: "importe", titulo: "Importe total", tipo: "moneda" },
    ],
    filas: papel.exclusiones.map((x) => ({ motivo: x.motivo, cantidad: x.cantidad, importe: pesos(x.importeCentavos) })),
    totales: null,
    sinDatosMotivo: papel.exclusiones.length === 0 ? "Todos los CFDI del periodo se incluyeron." : null,
  };
  const notas = [
    `Régimen ${papel.regimen}. Flujo de efectivo: CFDI PUE por su fecha; CFDI PPD solo por los pagos de su complemento de pago (REP) en el mes del pago.`,
    papel.pendientesPpd.cantidad > 0 ? `CFDI PPD sin complemento de pago registrado: ${papel.pendientesPpd.cantidad} por ${pesos(papel.pendientesPpd.importeCentavos).toFixed(2)} MXN (no cuentan todavía).` : "",
    ...papel.advertencias,
    "Papel de trabajo para revisión del contador: no es una declaración ni se presenta ante el SAT desde Atiende.",
  ].filter((n) => n !== "");
  return {
    tipo: "pagos_provisionales",
    titulo: "Pagos provisionales de ISR e IVA",
    periodo,
    generadoEn: entrada.generadoEn,
    contribuyente: { nombre: entrada.nombre, rfc: entrada.rfc },
    secciones: [resultado, seccionLineas("ISR: determinación", papel.isr), seccionLineas("IVA: determinación", papel.iva), exclusiones],
    notas,
    sinDatos: papel.documentosIncluidos === 0,
  };
}

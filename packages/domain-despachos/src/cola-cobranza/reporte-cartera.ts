// D-11 -- reporte de cartera y antiguedad de saldos por cliente (RFC receptor del CFDI). Puro y determinista:
// recibe las cuentas por cobrar PENDIENTES ya leidas (receivable + invoice, ver `apps/api/.../cola-cobranza.ts`)
// y la fecha de negocio de corte; devuelve el mismo modelo tabular que los reportes de cliente D-01, de modo que
// el render a PDF/JSON reutiliza `reporteAPdf` (pdf-lib, sin ejecutar nada del usuario) en vez de duplicarlo.
// Aritmetica en centavos enteros; solo al exponer cada celda se divide entre 100 (la columna `moneda` formatea pesos).
import { diasVencidoCartera } from "../cobranza/engine.ts";
import type { CeldaReporte, ColumnaReporte, SeccionReporte } from "../reportes/types.ts";

export const CUBETAS_ANTIGUEDAD = ["corriente", "1-30", "31-60", "61-90", "90+"] as const;
export type CubetaAntiguedad = (typeof CUBETAS_ANTIGUEDAD)[number];

/** A diferencia de `cobranzaAgeBucket` (que junta lo no vencido con 0-30), el reporte separa "corriente" (aun no vence). */
export function cubetaAntiguedad(diasVencido: number): CubetaAntiguedad {
  const d = Number.isFinite(diasVencido) ? Math.trunc(diasVencido) : 0;
  if (d <= 0) return "corriente";
  if (d <= 30) return "1-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "90+";
}

export interface CuentaCartera {
  readonly folioFiscal: string;
  readonly rfcReceptor: string;
  readonly clienteNombre: string | null;
  readonly saldoCentavos: number;
  readonly fechaVencimiento: string;
}

export interface ReporteCartera {
  readonly tipo: "cartera";
  readonly titulo: string;
  /** Fecha de corte "YYYY-MM-DD" (hoy de negocio). */
  readonly periodo: string;
  readonly etiquetaPeriodo: string;
  readonly generadoEn: string;
  readonly contribuyente: { readonly nombre: string; readonly rfc: string | null };
  readonly secciones: readonly SeccionReporte[];
  readonly notas: readonly string[];
  readonly sinDatos: boolean;
  /** Totales en centavos enteros (para la pantalla); las celdas de `secciones` van en pesos. */
  readonly totalesCentavos: Readonly<Record<CubetaAntiguedad | "total", number>>;
}

const pesos = (centavos: number): number => centavos / 100;

const COLUMNAS_RESUMEN: readonly ColumnaReporte[] = [
  { clave: "cliente", titulo: "Cliente", tipo: "texto" },
  { clave: "rfc", titulo: "RFC", tipo: "texto" },
  { clave: "facturas", titulo: "CFDI", tipo: "entero" },
  { clave: "corriente", titulo: "Corriente", tipo: "moneda" },
  { clave: "1-30", titulo: "1-30 días", tipo: "moneda" },
  { clave: "31-60", titulo: "31-60 días", tipo: "moneda" },
  { clave: "61-90", titulo: "61-90 días", tipo: "moneda" },
  { clave: "90+", titulo: "Más de 90", tipo: "moneda" },
  { clave: "total", titulo: "Saldo total", tipo: "moneda" },
];

const COLUMNAS_DETALLE: readonly ColumnaReporte[] = [
  { clave: "folio", titulo: "Folio fiscal (UUID)", tipo: "texto" },
  { clave: "cliente", titulo: "Cliente", tipo: "texto" },
  { clave: "vencimiento", titulo: "Vencimiento", tipo: "texto" },
  { clave: "dias", titulo: "Días de atraso", tipo: "entero" },
  { clave: "cubeta", titulo: "Antigüedad", tipo: "texto" },
  { clave: "saldo", titulo: "Saldo", tipo: "moneda" },
];

const vacio = (): Record<CubetaAntiguedad | "total", number> => ({ corriente: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 });

export function construirReporteCartera(entrada: {
  readonly cuentas: readonly CuentaCartera[];
  readonly hoy: string;
  readonly contribuyente: { readonly nombre: string; readonly rfc: string | null };
}): ReporteCartera {
  const { cuentas, hoy } = entrada;
  const totales = vacio();
  const porCliente = new Map<string, { nombre: string; rfc: string; facturas: number; montos: Record<CubetaAntiguedad | "total", number> }>();
  const detalle = cuentas
    .map((c) => {
      const dias = diasVencidoCartera(c.fechaVencimiento, hoy);
      return { c, dias, cubeta: cubetaAntiguedad(dias) };
    })
    .sort((a, b) => b.dias - a.dias || (a.c.folioFiscal < b.c.folioFiscal ? -1 : 1));

  for (const { c, cubeta } of detalle) {
    totales[cubeta] += c.saldoCentavos;
    totales.total += c.saldoCentavos;
    const previo = porCliente.get(c.rfcReceptor);
    const fila = previo ?? { nombre: c.clienteNombre ?? "Cliente sin nombre capturado", rfc: c.rfcReceptor, facturas: 0, montos: vacio() };
    if (previo === undefined) porCliente.set(c.rfcReceptor, fila);
    else if (fila.nombre === "Cliente sin nombre capturado" && c.clienteNombre) fila.nombre = c.clienteNombre;
    fila.facturas += 1;
    fila.montos[cubeta] += c.saldoCentavos;
    fila.montos.total += c.saldoCentavos;
  }

  const clientes = [...porCliente.values()].sort((a, b) => b.montos.total - a.montos.total || (a.rfc < b.rfc ? -1 : 1));
  const celdasMontos = (m: Record<CubetaAntiguedad | "total", number>): Record<string, CeldaReporte> => ({
    corriente: pesos(m.corriente),
    "1-30": pesos(m["1-30"]),
    "31-60": pesos(m["31-60"]),
    "61-90": pesos(m["61-90"]),
    "90+": pesos(m["90+"]),
    total: pesos(m.total),
  });

  const sinDatos = cuentas.length === 0;
  const motivo = "No hay cuentas por cobrar pendientes registradas en la cartera de este cliente.";
  const secciones: SeccionReporte[] = [
    {
      titulo: "Antigüedad de saldos por cliente",
      columnas: COLUMNAS_RESUMEN,
      filas: clientes.map((cl) => ({ cliente: cl.nombre, rfc: cl.rfc, facturas: cl.facturas, ...celdasMontos(cl.montos) })),
      totales: sinDatos ? null : { cliente: "Total cartera", rfc: null, facturas: cuentas.length, ...celdasMontos(totales) },
      sinDatosMotivo: sinDatos ? motivo : null,
    },
    {
      titulo: "Detalle por CFDI",
      columnas: COLUMNAS_DETALLE,
      filas: detalle.map(({ c, dias, cubeta }) => ({
        folio: c.folioFiscal,
        cliente: c.clienteNombre ?? c.rfcReceptor,
        vencimiento: c.fechaVencimiento,
        dias,
        cubeta,
        saldo: pesos(c.saldoCentavos),
      })),
      totales: sinDatos ? null : { folio: "Total", cliente: null, vencimiento: null, dias: null, cubeta: null, saldo: pesos(totales.total) },
      sinDatosMotivo: sinDatos ? motivo : null,
    },
  ];

  return {
    tipo: "cartera",
    titulo: "Cartera y antigüedad de saldos",
    periodo: hoy,
    etiquetaPeriodo: `Corte al ${hoy}`,
    generadoEn: hoy,
    contribuyente: entrada.contribuyente,
    secciones,
    notas: [
      "Montos en pesos mexicanos (MXN), calculados en centavos enteros.",
      "La antigüedad se mide en días naturales desde la fecha de vencimiento registrada, con la fecha de corte en la zona horaria de negocio de la cuenta (por omisión America/Mexico_City). Corriente = aún no vence.",
      "Solo incluye cuentas por cobrar pendientes (CFDI de ingreso con reloj de cobranza activo). Un CFDI sin fecha de vencimiento registrada no aparece aquí.",
      "El saldo es el total del CFDI; los pagos parciales no se modelan (una cuenta se cierra completa al marcarse pagada).",
    ],
    sinDatos,
    totalesCentavos: totales,
  };
}

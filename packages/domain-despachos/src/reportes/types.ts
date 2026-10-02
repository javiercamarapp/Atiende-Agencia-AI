// Modelo neutro de un reporte de cliente (D-01): una estructura tabular ya calculada desde
// datos reales del modelo, independiente del formato de salida (JSON para la pantalla,
// XLSX desde `xlsx.ts`, PDF desde la capa de API). Un reporte NUNCA inventa una cifra:
// cuando el dato fuente no existe en el modelo, la sección lo declara con
// `sinDatosMotivo` y NO trae filas (la pantalla/PDF/Excel muestran "sin datos" + el porqué).
export const TIPOS_REPORTE_CLIENTE = ["balanza", "diot", "nomina", "impuestos"] as const;
export type TipoReporteCliente = (typeof TIPOS_REPORTE_CLIENTE)[number];

export type TipoColumnaReporte = "texto" | "moneda" | "entero" | "porcentaje";

export interface ColumnaReporte {
  readonly clave: string;
  readonly titulo: string;
  readonly tipo: TipoColumnaReporte;
}

export type CeldaReporte = string | number | null;

export interface SeccionReporte {
  readonly titulo: string;
  readonly columnas: readonly ColumnaReporte[];
  readonly filas: readonly Readonly<Record<string, CeldaReporte>>[];
  /** Fila de totales con las mismas claves de columna; `null` si la sección no suma. */
  readonly totales: Readonly<Record<string, CeldaReporte>> | null;
  /** Presente SOLO cuando la sección no tiene datos fuente: el porqué, en lenguaje de negocio. */
  readonly sinDatosMotivo: string | null;
}

export interface ReporteCliente {
  readonly tipo: TipoReporteCliente;
  readonly titulo: string;
  /** "YYYY-MM". */
  readonly periodo: string;
  /** Fecha de negocio "YYYY-MM-DD" de generación (inyectada, no `now()`). */
  readonly generadoEn: string;
  readonly contribuyente: { readonly nombre: string; readonly rfc: string | null };
  readonly secciones: readonly SeccionReporte[];
  /** Advertencias de alcance/interpretación (qué no cubre el reporte y por qué). */
  readonly notas: readonly string[];
  /** `true` si NINGUNA sección trae filas: el reporte entero está "sin datos". */
  readonly sinDatos: boolean;
}

/** Cualquier reporte tabular con la forma de `ReporteCliente` (p. ej. cartera D-11, pagos provisionales D-25): `tipo` libre. */
export type ReporteTabular = Omit<ReporteCliente, "tipo"> & { readonly tipo: string };

export const ETIQUETA_TIPO_REPORTE: Readonly<Record<TipoReporteCliente, string>> = {
  balanza: "Balanza de comprobación",
  diot: "DIOT (Declaración Informativa de Operaciones con Terceros)",
  nomina: "Nómina",
  impuestos: "Impuestos (IVA, ISR) y obligaciones fiscales",
};

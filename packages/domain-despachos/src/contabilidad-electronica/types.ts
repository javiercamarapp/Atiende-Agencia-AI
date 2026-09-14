// Tipos de contabilidad electrónica del SAT (Anexo 24) — puerto de
// `b2b_ai/services/catalogo_cuentas.py` + `b2b_ai/services/balanza.py` +
// `b2b_ai/services/contabilidad_electronica.py`. Cierra el gap de auditoría
// "Motor de contabilidad electrónica SAT (catálogo/balanza/pólizas, XML
// Anexo 24)": el checklist de cierre mensual (`cierre-mensual/templates.ts`,
// tarea `contabilidad_elect`) solo comprobaba un booleano manual
// (`autoCheckQuery: "contabilidad_electronica"`, predicado `(v) => v ===
// true` en `cierre-mensual/engine.ts`) sin que existiera ningún generador
// real del paquete XML que ese booleano representa. Este módulo es ese
// generador; el booleano de `AUTO_CHECK_PASS` sigue siendo responsabilidad
// de la capa que orquesta el cierre (fuera de alcance de este archivo,
// mismo patrón que el resto de `cierre-mensual/`), que ahora puede
// calcularlo a partir de `PaqueteContabilidadElectronica.estado`.
//
// NOTA SOBRE "PÓLIZAS" DEL TÍTULO DEL GAP: verificado leyendo el origen
// completo (`b2b_ai/services/`, `b2b_ai/templates/`) — el Python NO tiene
// ningún generador de XML de pólizas Anexo 24 (no existe
// `polizas.py`/`PolizasContables.xsd` ni plantilla equivalente a
// `balanza_comprobacion.xml` para pólizas; solo hay archivos de tests sobre
// "polizas" en `migracion_catalogo`, que es un dominio distinto — matching
// de cuentas entre dos catálogos, ya cubierto por
// `migracion-catalogo/matching.ts`). Portar ese generador inventaría una
// regla fiscal que no existe en el origen, violando la instrucción de nunca
// fabricar comportamiento SAT. Este módulo cierra la parte REAL y verificada
// del gap: catálogo de cuentas + balanza de comprobación (los dos XML que sí
// genera el origen) + el orquestador de estado del paquete.
export type NaturalezaCuenta = "D" | "A"; // D = deudora, A = acreedora

/** `Cuenta` del origen (`catalogo_cuentas.py`) — una cuenta del catálogo
 * Anexo 24 (código de 4 dígitos + nivel + naturaleza), DISTINTO del catálogo
 * de `bookkeeping/types.ts::AccountMapping` (código agrupador de 7 dígitos,
 * usado para mapear categoría de CFDI -> cuenta al generar pólizas de
 * `bookkeeping/rules-engine.ts`). Son dos catálogos separados también en el
 * origen: `balanza.py` importa de `catalogo_cuentas.py`, nunca de
 * `bookkeeping/rules_engine.py`, y viceversa. */
export interface CuentaAnexo24 {
  readonly codigo: string;
  readonly descripcion: string;
  readonly nivel: number;
  readonly naturaleza: NaturalezaCuenta;
  readonly grupo: string;
}

/** Un asiento contable de entrada — puerto de los dicts `{cuenta, debe,
 * haber, fecha?}` que consume `BalanzaComprobacion.acumular`/`generar`. */
export interface AsientoContable {
  readonly cuenta: string;
  readonly debe?: number | string | null;
  readonly haber?: number | string | null;
  /** "YYYY-MM-DD" (o cualquier string cuyos primeros 7 caracteres sean
   * "YYYY-MM"). Si se omite, el asiento nunca se excluye por período —
   * mismo criterio que el origen (`if fecha is None or str(fecha)[:7] ==
   * p`). */
  readonly fecha?: string | null;
}

/** Una línea de la balanza de comprobación — puerto de las líneas que arma
 * `BalanzaComprobacion.generar`. Los montos quedan como string con 2
 * decimales fijos (igual que el origen: `_fmt` sobre `Decimal`), para que el
 * XML y el resumen muestren EXACTAMENTE los mismos dígitos que se calcularon
 * (nunca reformatear en el punto de salida). */
export interface LineaBalanza {
  readonly cuenta: string;
  readonly descripcion: string;
  readonly nivel: number;
  readonly naturaleza: NaturalezaCuenta;
  readonly saldoInicial: string;
  readonly debe: string;
  readonly haber: string;
  readonly saldoFinal: string;
}

/** Una línea con saldo anómalo — puerto de los dicts que devuelve
 * `detectar_saldos_anomalos` (`{**linea, "razon": ...}`). */
export interface LineaBalanzaAnomala extends LineaBalanza {
  readonly razon: string;
}

/** Resumen de la balanza — puerto del dict que devuelve
 * `BalanzaComprobacion.resumen()` / `.generar()`. */
export interface ResumenBalanza {
  readonly periodo: string | null;
  readonly cuentas: number;
  readonly totalDebe: string;
  readonly totalHaber: string;
  readonly cuadrada: boolean;
  readonly saldosAnomalos: readonly string[];
  readonly lineas: readonly LineaBalanza[];
}

/** `ESTADOS` del origen — ciclo de vida del paquete de contabilidad
 * electrónica. */
export const ESTADOS_PAQUETE_CONTABILIDAD = ["borrador", "listo_para_timbrar", "timbrado", "enviado"] as const;
export type EstadoPaqueteContabilidad = (typeof ESTADOS_PAQUETE_CONTABILIDAD)[number];

/** `ESTADO_INICIAL` del origen. */
export const ESTADO_INICIAL_PAQUETE_CONTABILIDAD: EstadoPaqueteContabilidad = "borrador";

export interface ArchivoContabilidadElectronica {
  readonly xml: string;
  readonly sha1: string;
}

/** El paquete completo — puerto del dict que devuelve
 * `ContabilidadElectronica.generar_paquete`. */
export interface PaqueteContabilidadElectronica {
  readonly periodo: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly catalogo: ArchivoContabilidadElectronica & { readonly cuentas: number };
  readonly balanza: ArchivoContabilidadElectronica & { readonly cuadrada: boolean; readonly cuentas: number };
  readonly resumenBalanza: ResumenBalanza;
  readonly estado: EstadoPaqueteContabilidad;
  readonly generadoEn: string;
}

/** Puerto del dict que devuelve `generar_resumen_mensual`. */
export interface ResumenMensualContabilidad {
  readonly periodo: string;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly cuentas: number;
  readonly totalDebe: string;
  readonly totalHaber: string;
  readonly cuadrada: boolean;
  readonly saldosAnomalos: readonly string[];
  readonly estado: EstadoPaqueteContabilidad;
}

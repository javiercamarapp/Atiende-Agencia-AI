// CFO-04 · segmentos de clientes (diseño §4.2): activo / dormido / perdido y frecuente, según `CfoConfig`.
//
// Definiciones (los umbrales son configurables y vienen de `cfo_config`):
//  - activo   : último pedido hace ≤ `activoDias` días          (60 por omisión)
//  - dormido  : último pedido hace entre `activoDias`+1 y `perdidoDias` días
//  - perdido  : último pedido hace > `perdidoDias` días          (120 por omisión)
//  - frecuente: ≥ `frecuenteN` pedidos en los últimos `frecuenteDias` días (3 en 90 por omisión)
//  - nuevo    : su primer pedido histórico cae dentro del rango
//  - recurrente: tiene pedido previo al rango
// Precedencia en `segmentoCliente`: frecuente > nuevo > recurrente.
// Sin datos personales: este módulo no recibe nombres, teléfonos ni direcciones; solo conteos y días.
import type { CfoConfig, Cifra, FilaClientesResumen } from "./tipos.ts";
import { frecuentesPct } from "./formulas.ts";
import { formatoEntero } from "./util.ts";

export type SegmentoActividad = "activo" | "dormido" | "perdido" | "sin_pedidos";
export type SegmentoCliente = "nuevo" | "recurrente" | "frecuente";

type UmbralesActividad = Pick<CfoConfig, "activoDias" | "perdidoDias">;
type UmbralesFrecuente = Pick<CfoConfig, "frecuenteN" | "frecuenteDias">;

/** Valida que los umbrales tengan sentido (activo < perdido). Lanza RangeError si no. */
export function validarUmbralesActividad(c: UmbralesActividad): void {
  if (!(c.activoDias >= 1) || !(c.perdidoDias > c.activoDias)) {
    throw new RangeError(`Umbrales inválidos: activoDias (${c.activoDias}) debe ser ≥ 1 y menor que perdidoDias (${c.perdidoDias})`);
  }
}

/** Días desde el último pedido -> activo / dormido / perdido. null = el cliente nunca pidió. */
export function clasificarActividad(diasDesdeUltimoPedido: number | null, config: UmbralesActividad): SegmentoActividad {
  validarUmbralesActividad(config);
  if (diasDesdeUltimoPedido == null) return "sin_pedidos";
  if (diasDesdeUltimoPedido <= config.activoDias) return "activo";
  if (diasDesdeUltimoPedido <= config.perdidoDias) return "dormido";
  return "perdido";
}

/** ≥ `frecuenteN` pedidos en la ventana `frecuenteDias` (el conteo ya viene de la ventana). */
export function esFrecuente(pedidosEnVentana: number, config: UmbralesFrecuente): boolean {
  return pedidosEnVentana >= config.frecuenteN;
}

export function segmentoCliente(e: { pedidosEnVentana: number; primerPedidoEnRango: boolean }, config: UmbralesFrecuente): SegmentoCliente {
  if (esFrecuente(e.pedidosEnVentana, config)) return "frecuente";
  return e.primerPedidoEnRango ? "nuevo" : "recurrente";
}

export function etiquetaActividad(s: SegmentoActividad): string {
  switch (s) {
    case "activo": return "Activo";
    case "dormido": return "Dormido";
    case "perdido": return "Perdido";
    case "sin_pedidos": return "Sin pedidos";
  }
}

export function etiquetaSegmento(s: SegmentoCliente): string {
  switch (s) {
    case "nuevo": return "Nuevo";
    case "recurrente": return "Recurrente";
    case "frecuente": return "Frecuente";
  }
}

/** Definiciones legibles, con los umbrales vigentes, para mostrarlas junto a las cifras. */
export function definicionesSegmentos(config: UmbralesActividad & UmbralesFrecuente): Readonly<Record<SegmentoActividad | SegmentoCliente, string>> {
  return {
    activo: `Activo: pidió en los últimos ${config.activoDias} días.`,
    dormido: `Dormido: su último pedido fue hace ${config.activoDias + 1} a ${config.perdidoDias} días.`,
    perdido: `Perdido: no pide hace más de ${config.perdidoDias} días.`,
    sin_pedidos: "Sin pedidos: aún no ha comprado.",
    frecuente: `Frecuente: ${config.frecuenteN} o más pedidos en ${config.frecuenteDias} días.`,
    nuevo: "Nuevo: su primer pedido está dentro del periodo.",
    recurrente: "Recurrente: ya tenía pedidos antes del periodo.",
  };
}

export interface ResumenSegmentos {
  readonly activos: number;
  readonly dormidos: number;
  readonly perdidos: number;
  readonly frecuentes: number;
  readonly frecuentesPct: Cifra;
  /** Cuántos clientes caen en los tres segmentos de actividad (para verificar que cuadra con la base). */
  readonly totalClasificados: number;
  readonly etiquetas: readonly string[];
}

/** Resume una fila de `cfo_clientes_resumen` (sucursal o conjunto) con etiquetas legibles. */
export function resumirSegmentos(f: Pick<FilaClientesResumen, "activos" | "dormidos" | "perdidos" | "frecuentes">): ResumenSegmentos {
  return {
    activos: f.activos,
    dormidos: f.dormidos,
    perdidos: f.perdidos,
    frecuentes: f.frecuentes,
    frecuentesPct: frecuentesPct(f.frecuentes, f.activos),
    totalClasificados: f.activos + f.dormidos + f.perdidos,
    etiquetas: [
      `${formatoEntero(f.activos)} activos`,
      `${formatoEntero(f.dormidos)} dormidos`,
      `${formatoEntero(f.perdidos)} perdidos`,
      `${formatoEntero(f.frecuentes)} frecuentes`,
    ],
  };
}

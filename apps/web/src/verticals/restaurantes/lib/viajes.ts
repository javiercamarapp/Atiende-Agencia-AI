// Reglas puras de la pantalla Viajes del encargado: seleccion de lote (maximo 6), chofer por omision y texto de carga. Sin DOM ni red.
import type { ViajesSalida } from "@atiende/domain-restaurantes/operacion";

export const MAX_LOTE = 6;
export const ETA_POR_OMISION_MIN = 35;

export type Chofer = ViajesSalida["repartidores"][number];

/** Agrega o quita `id` del lote. Si el lote ya tiene 6, un septimo se ignora (la pantalla lo avisa). */
export function alternarSeleccion(actual: readonly string[], id: string): readonly string[] {
  if (actual.includes(id)) return actual.filter((x) => x !== id);
  return actual.length >= MAX_LOTE ? actual : [...actual, id];
}

/** Quita de la seleccion lo que ya no esta por salir (otro encargado lo despacho, se cancelo). */
export function depurarSeleccion(actual: readonly string[], porSalirIds: readonly string[]): readonly string[] {
  const vigentes = new Set(porSalirIds);
  const nueva = actual.filter((id) => vigentes.has(id));
  return nueva.length === actual.length ? actual : nueva;
}

/** Chofer inicial: el sugerido por el servidor; si no hay, el primero disponible; si no, ninguno (la persona elige). */
export function choferInicial(repartidores: readonly Chofer[]): string | null {
  return repartidores.find((r) => r.sugerido && r.disponible)?.id ?? repartidores.find((r) => r.disponible)?.id ?? null;
}

export function etiquetaChofer(c: Chofer): string {
  const carga = c.activos === 1 ? "1 activo" : `${c.activos} activos`;
  return `${c.nombre} (${carga})${c.sugerido ? " · sugerido" : ""}${c.disponible ? "" : " · fuera de turno"}`;
}

export function textoBotonSalio(n: number): string {
  return n === 1 ? "Salió (1 pedido)" : `Salió (${n} pedidos)`;
}

// Regla de fusion de renglones (compartida por el repositorio en memoria y el de Postgres).
import type { PersistedOrderItem } from "../types.ts";

/** Une renglones iguales (mismo id, nombre y precio) sumando cantidades; es la misma regla de fusion del repositorio en memoria. */
export function fusionarRenglones(actuales: readonly PersistedOrderItem[], nuevos: readonly PersistedOrderItem[]): PersistedOrderItem[] {
  const salida = actuales.map((i) => ({ ...i }));
  for (const n of nuevos) {
    const igual = salida.find((x) => x.id === n.id && x.name === n.name && x.price === n.price);
    if (igual) salida[salida.indexOf(igual)] = { ...igual, quantity: igual.quantity + n.quantity };
    else salida.push({ ...n });
  }
  return salida;
}


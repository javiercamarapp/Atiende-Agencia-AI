// Repartidor sugerido (autopiloto, semiautomatico): al pasar a `preparando` un pedido a domicilio, el panel muestra
// "Asignar a X" con un clic. El sistema SUGIERE; nunca asigna solo (la asignacion automatica la decide PM y aqui no existe).
//
// Regla determinista (misma entrada = misma sugerencia, sin azar ni reloj):
//   1. solo repartidores de la organizacion con alcance a la sucursal del pedido (`propertyIds` nulo = toda la organizacion);
//   2. menor carga = menos pedidos `en_camino` asignados;
//   3. empate: el que lleva mas tiempo sin que le asignen un pedido (fecha del pedido asignado mas reciente; sin ninguno = primero);
//   4. empate: el menor userId (orden estable).
import type { Order } from "./types.ts";

export interface CandidatoRepartidor {
  readonly userId: string;
  readonly nombre: string;
  /** null = alcance a toda la organizacion. */
  readonly propertyIds: readonly string[] | null;
}

export interface CargaRepartidor {
  /** Pedidos `en_camino` asignados hoy a este repartidor. */
  readonly enCamino: number;
  /** ISO del pedido asignado mas reciente (cualquier estado), null si nunca le han asignado uno. */
  readonly ultimaAsignacionAt: string | null;
}

export interface SugerenciaRepartidor {
  readonly repartidorId: string;
  readonly nombre: string;
  readonly enCamino: number;
}

/** Carga de un repartidor a partir de sus pedidos asignados (`RestaurantesRepository.listOrdersForRepartidor`). Funcion pura. */
export function cargaDeRepartidor(pedidosAsignados: readonly Pick<Order, "status" | "createdAt">[]): CargaRepartidor {
  let enCamino = 0;
  let ultima: string | null = null;
  for (const p of pedidosAsignados) {
    if (p.status === "en_camino") enCamino += 1;
    if (ultima === null || p.createdAt > ultima) ultima = p.createdAt;
  }
  return { enCamino, ultimaAsignacionAt: ultima };
}

export function sugerirRepartidor(propertyId: string, candidatos: readonly CandidatoRepartidor[], cargas: ReadonlyMap<string, CargaRepartidor>): SugerenciaRepartidor | null {
  const elegibles = candidatos.filter((c) => c.propertyIds === null || c.propertyIds.includes(propertyId));
  if (elegibles.length === 0) return null;
  const ordenados = [...elegibles].sort((a, b) => {
    const ca = cargas.get(a.userId) ?? { enCamino: 0, ultimaAsignacionAt: null };
    const cb = cargas.get(b.userId) ?? { enCamino: 0, ultimaAsignacionAt: null };
    if (ca.enCamino !== cb.enCamino) return ca.enCamino - cb.enCamino;
    if (ca.ultimaAsignacionAt !== cb.ultimaAsignacionAt) {
      if (ca.ultimaAsignacionAt === null) return -1;
      if (cb.ultimaAsignacionAt === null) return 1;
      return ca.ultimaAsignacionAt < cb.ultimaAsignacionAt ? -1 : 1;
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
  const ganador = ordenados[0]!;
  return { repartidorId: ganador.userId, nombre: ganador.nombre, enCamino: (cargas.get(ganador.userId) ?? { enCamino: 0 }).enCamino };
}

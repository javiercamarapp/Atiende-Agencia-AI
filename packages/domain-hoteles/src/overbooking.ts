// Port literal de hoteles/packages/domain-hotel/src/overbooking.ts (H4). H02-010:
// sobreventa controlada solo dentro de reglas explícitas y configurables (máximo de
// habitaciones + umbral de ocupación), nunca ilimitada. Espejo de la fórmula que en
// el origen vive en la función SQL `book_availability` (packages/db/migrations/
// 0013_tarifas_avanzadas_y_politicas.sql) — la autoridad final sigue siendo la función
// SQL equivalente (`hoteles.book_availability`, ver migrations/003_availability.sql de
// este paquete); este módulo sirve para explicar/probar la regla sin DB y para que el
// frontend pueda mostrar la capacidad efectiva en la grilla de disponibilidad.
export interface OverbookingConfig {
  maxOverbookRooms: number;
  occupancyThresholdPct: number;
}

export function occupancyPct(totalRooms: number, bookedRooms: number): number {
  return totalRooms > 0 ? (bookedRooms / totalRooms) * 100 : 100;
}

export function effectiveCapacity(totalRooms: number, bookedRooms: number, config: OverbookingConfig): number {
  const overbookAllowed = occupancyPct(totalRooms, bookedRooms) >= config.occupancyThresholdPct;
  return totalRooms + (overbookAllowed ? config.maxOverbookRooms : 0);
}

export function canBook(totalRooms: number, bookedRooms: number, qty: number, config: OverbookingConfig): boolean {
  return bookedRooms + qty <= effectiveCapacity(totalRooms, bookedRooms, config);
}

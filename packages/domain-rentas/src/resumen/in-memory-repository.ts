// Doble en memoria del repositorio del Resumen. Llegadas/salidas y tareas se DERIVAN del mismo `InMemoryRentasCalendarStore`
// que usan los repos de reservas y limpieza (así un test crea reservas/tareas por la API real y el Resumen debe coincidir,
// igual que la SQL real lee las mismas tablas); borradores y acceso son contenedores sembrables. La SQL real vive en
// postgres-repository.ts y se prueba con AbortAwareFakeSession.
import type { InMemoryRentasCalendarStore } from "../calendar-store.ts";
import type { AccesoResumen, BorradoresResumen, LlegadasSalidasHoy, RentasResumenRepository, TareasResumen } from "./repository.ts";

export class InMemoryRentasResumenRepository implements RentasResumenRepository {
  readonly borradoresPorProperty = new Map<string, BorradoresResumen>();
  readonly accesoPorProperty = new Map<string, AccesoResumen>();
  /** Bloques que simulan una base sin migrar (devuelven `null`). */
  readonly noDisponibles = new Set<"llegadasSalidas" | "borradores" | "tareas" | "acceso">();

  constructor(private readonly store: InMemoryRentasCalendarStore) {}

  async llegadasSalidas(propertyId: string, fecha: string): Promise<LlegadasSalidasHoy | null> {
    if (this.noDisponibles.has("llegadasSalidas")) return null;
    const reservas = [...this.store.ocupaciones.values()].filter((o) => o.propertyId === propertyId && o.capa === "reserva" && o.estado === "confirmado");
    return { llegadas: reservas.filter((o) => o.inicio === fecha).length, salidas: reservas.filter((o) => o.fin === fecha).length };
  }

  async borradores(propertyId: string): Promise<BorradoresResumen | null> {
    if (this.noDisponibles.has("borradores")) return null;
    return this.borradoresPorProperty.get(propertyId) ?? { pendientes: 0, ultimoBorradorIaEn: null };
  }

  async tareas(propertyId: string, ahoraIso: string): Promise<TareasResumen | null> {
    if (this.noDisponibles.has("tareas")) return null;
    const abiertas = [...this.store.tareas.values()].filter((t) => t.propertyId === propertyId && t.estado !== "completada" && t.estado !== "cancelada");
    const deCheckout = [...this.store.tareas.values()].filter((t) => t.propertyId === propertyId && t.ocupacionUnidadId !== null).map((t) => t.creadoEn);
    return {
      pendientes: abiertas.length,
      vencidas: abiertas.filter((t) => t.slaVenceEn !== null && Date.parse(t.slaVenceEn) < Date.parse(ahoraIso)).length,
      ultimaTareaPorCheckoutEn: deCheckout.length === 0 ? null : deCheckout.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)),
    };
  }

  async acceso(propertyId: string): Promise<AccesoResumen | null> {
    if (this.noDisponibles.has("acceso")) return null;
    return this.accesoPorProperty.get(propertyId) ?? { politicaActiva: false, ultimaLiberacionEn: null };
  }
}

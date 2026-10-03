// Memoria del agente guionado de hoteles: recuerda los tipos de cuarto de `consultar_disponibilidad`, el ultimo total cotizado y la pre-reserva creada, para
// que los pasos del guion armen los argumentos del siguiente paso.
import type { MemoriaHoteles } from "./tipos.ts";

class Memoria implements MemoriaHoteles {
  private readonly porTool = new Map<string, unknown>();
  private readonly tipos = new Map<string, string>();
  private total: number | undefined;
  private preReserva: string | undefined;

  observar(nombre: string, resultado: unknown): void {
    this.porTool.set(nombre, resultado);
    const r = (typeof resultado === "object" && resultado !== null ? resultado : {}) as Record<string, unknown>;
    if (nombre === "consultar_disponibilidad" && Array.isArray(r.opciones)) {
      for (const o of r.opciones as { tipo?: unknown; tipo_habitacion_id?: unknown }[]) if (typeof o.tipo === "string" && typeof o.tipo_habitacion_id === "string") this.tipos.set(o.tipo, o.tipo_habitacion_id);
    }
    if (nombre === "cotizar_estancia") {
      const c = r.cotizacion as { estado?: unknown; total_centavos?: unknown } | undefined;
      if (c?.estado === "ok" && typeof c.total_centavos === "number") this.total = c.total_centavos;
    }
    if (nombre === "crear_pre_reserva" && typeof r.pre_reserva_id === "string") this.preReserva = r.pre_reserva_id;
  }
  ultimo(nombre: string): unknown {
    return this.porTool.get(nombre);
  }
  tipo(nombre: string): string {
    const id = this.tipos.get(nombre);
    if (!id) throw new Error(`El guion usa un tipo de cuarto que no se consulto antes: ${nombre}`);
    return id;
  }
  totalCotizado(): number {
    if (this.total === undefined) throw new Error("El guion usa un total que no se cotizo antes.");
    return this.total;
  }
  preReservaId(): string {
    if (!this.preReserva) throw new Error("El guion usa una pre-reserva que no se creo antes.");
    return this.preReserva;
  }
}

export function crearMemoriaHoteles(): MemoriaHoteles {
  return new Memoria();
}

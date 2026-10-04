// Memoria del agente guionado de citas: recuerda los ids de servicios y proveedores de `listar_*`, los horarios de `consultar_disponibilidad` y la cita
// de `buscar_mis_citas` / `crear_cita`, para que los pasos del guion armen los argumentos del siguiente paso.
import type { MemoriaCitas, ProveedorSim, ServicioSim } from "./tipos.ts";

const NOMBRE_SERVICIO: Readonly<Record<ServicioSim, string>> = { valoracion: "Consulta de valoración", seguimiento: "Sesión de seguimiento" };
const NOMBRE_PROVEEDOR: Readonly<Record<ProveedorSim, string>> = { lucia: "Dra. Lucía Pech", mario: "Dr. Mario Canul" };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const lista = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);

class Memoria implements MemoriaCitas {
  private readonly porTool = new Map<string, unknown>();
  private readonly servicios = new Map<string, string>();
  private readonly proveedores = new Map<string, string>();
  private horarios: string[] = [];
  private cita: string | undefined;

  observar(nombre: string, resultado: unknown): void {
    this.porTool.set(nombre, resultado);
    const r = obj(resultado);
    if (nombre === "listar_servicios") for (const s of lista(r.servicios)) if (typeof s.name === "string" && typeof s.id === "string") this.servicios.set(s.name, s.id);
    if (nombre === "listar_proveedores") for (const p of lista(r.proveedores)) if (typeof p.display_name === "string" && typeof p.id === "string") this.proveedores.set(p.display_name, p.id);
    if (nombre === "consultar_disponibilidad") this.horarios = lista(r.slots).flatMap((s) => (typeof s.starts_at === "string" ? [s.starts_at] : []));
    if (nombre === "buscar_mis_citas") {
      const primera = lista(r.appointments)[0];
      if (primera && typeof primera.appointment_id === "string") this.cita = primera.appointment_id;
    }
    if (nombre === "crear_cita") {
      const id = obj(r.appointment).appointment_id;
      if (typeof id === "string") this.cita = id;
    }
  }
  ultimo(nombre: string): unknown {
    return this.porTool.get(nombre);
  }
  servicio(nombre: ServicioSim): string {
    const id = this.servicios.get(NOMBRE_SERVICIO[nombre]);
    if (!id) throw new Error(`El guion usa un servicio que no se listo antes: ${nombre}`);
    return id;
  }
  proveedor(nombre: ProveedorSim): string {
    const id = this.proveedores.get(NOMBRE_PROVEEDOR[nombre]);
    if (!id) throw new Error(`El guion usa un proveedor que no se listo antes: ${nombre}`);
    return id;
  }
  horario(indice = 0): string {
    const h = this.horarios.at(indice);
    if (!h) throw new Error(`El guion usa un horario (${indice}) que la disponibilidad no ofrecio.`);
    return h;
  }
  citaId(): string {
    if (!this.cita) throw new Error("El guion usa una cita que no se busco ni se creo antes.");
    return this.cita;
  }
}

export function crearMemoriaCitas(): MemoriaCitas {
  return new Memoria();
}

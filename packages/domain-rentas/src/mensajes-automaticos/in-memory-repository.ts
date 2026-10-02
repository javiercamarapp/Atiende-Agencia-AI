// Doble en memoria del repositorio de mensajes automaticos. `listarCandidatos` NO re-implementa
// la ventana ni los filtros de plantilla (eso es SQL, verificado contra Postgres real en
// scripts/verify-rentas-mensajes-automaticos): entrega las `candidatas` sembradas que no tengan
// marca. Si modela la idempotencia (marca por reserva+evento) y la disponibilidad de la migracion.
import type { RentasMensajesAutomaticosRepository } from "./repository.ts";
import type { CandidatoMensajeAutomatico, EntradaProgramacion, EventoAutomatico, ProgramacionMensaje, ResultadoMensajesAutomaticos } from "./tipos.ts";

export interface BorradorAutomaticoEnMemoria {
  readonly id: string;
  readonly ocupacionId: string;
  readonly evento: EventoAutomatico;
  readonly plantillaId: string;
  readonly texto: string;
  readonly estado: "pendiente_aprobacion";
}

export class InMemoryRentasMensajesAutomaticosRepository implements RentasMensajesAutomaticosRepository {
  migracion029Disponible = true;
  readonly candidatas: CandidatoMensajeAutomatico[] = [];
  readonly programaciones = new Map<string, ProgramacionMensaje>();
  readonly borradores: BorradorAutomaticoEnMemoria[] = [];
  readonly omitidos: { ocupacionId: string; evento: EventoAutomatico }[] = [];
  /** Llamadas hechas al motor (para afirmar que un camino no llego a tocarlo). */
  readonly llamadas: string[] = [];
  /** Hace fallar `crearBorradorAutomatico` para ocupaciones concretas (error SQL simulado). */
  readonly fallaAlCrearPara = new Set<string>();
  private seq = 0;

  private requiere(): void {
    if (!this.migracion029Disponible) {
      const e = new Error("function rentas.sistema_listar_mensajes_automaticos(timestamp with time zone, integer) does not exist") as Error & { code: string };
      e.code = "42883";
      throw e;
    }
  }

  private tieneMarca(ocupacionId: string, evento: EventoAutomatico): boolean {
    return this.borradores.some((b) => b.ocupacionId === ocupacionId && b.evento === evento) || this.omitidos.some((o) => o.ocupacionId === ocupacionId && o.evento === evento);
  }

  async listarProgramaciones(propertyId: string): Promise<ResultadoMensajesAutomaticos<readonly ProgramacionMensaje[]>> {
    if (!this.migracion029Disponible) return { disponible: false };
    return { disponible: true, valor: [...this.programaciones.values()].filter((p) => p.propertyId === propertyId) };
  }

  async guardarProgramacion(e: EntradaProgramacion): Promise<ResultadoMensajesAutomaticos<ProgramacionMensaje>> {
    if (!this.migracion029Disponible) return { disponible: false };
    const valor: ProgramacionMensaje = { propertyId: e.propertyId, evento: e.evento, plantillaId: e.plantillaId, offsetHoras: e.offsetHoras, activo: e.activo, actualizadoEn: new Date().toISOString() };
    this.programaciones.set(`${e.propertyId}:${e.evento}`, valor);
    return { disponible: true, valor };
  }

  async listarCandidatos(_ahora: Date, limite: number): Promise<readonly CandidatoMensajeAutomatico[]> {
    this.llamadas.push("listarCandidatos");
    this.requiere();
    return this.candidatas.filter((c) => !this.tieneMarca(c.ocupacionId, c.evento)).slice(0, limite);
  }

  async crearBorradorAutomatico(e: { ocupacionId: string; evento: EventoAutomatico; plantillaId: string; texto: string }): Promise<string | null> {
    this.llamadas.push("crearBorradorAutomatico");
    this.requiere();
    if (this.fallaAlCrearPara.has(e.ocupacionId)) {
      const err = new Error("deadlock detected") as Error & { code: string };
      err.code = "40P01";
      throw err;
    }
    if (this.tieneMarca(e.ocupacionId, e.evento)) return null;
    const id = `borrador-auto-${++this.seq}`;
    this.borradores.push({ id, ocupacionId: e.ocupacionId, evento: e.evento, plantillaId: e.plantillaId, texto: e.texto, estado: "pendiente_aprobacion" });
    return id;
  }

  async registrarOmitido(e: { ocupacionId: string; evento: EventoAutomatico; plantillaId: string }): Promise<boolean> {
    this.llamadas.push("registrarOmitido");
    this.requiere();
    if (this.tieneMarca(e.ocupacionId, e.evento)) return false;
    this.omitidos.push({ ocupacionId: e.ocupacionId, evento: e.evento });
    return true;
  }
}

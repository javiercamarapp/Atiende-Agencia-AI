// Doble en memoria del repositorio de acceso. `siguienteLiberacion` NO re-implementa la
// ventana/pago (eso es SQL, verificado contra Postgres real en
// scripts/verify-rentas-reportes-acceso): entrega las `pendientes` sembradas que no estén
// excluidas ni ya liberadas. Sí modela la idempotencia, el dedupe de la bitácora y la
// disponibilidad de la migración.
import type { RentasAccesoRepository } from "./repository.ts";
import { POLITICA_ACCESO_POR_DEFECTO } from "./tipos.ts";
import type { EventoAccesoRecord, EventoOmitidoAcceso, InstruccionAcceso, LiberacionPendiente, PoliticaAcceso, ResultadoAcceso, ResultadoConfirmarPago } from "./tipos.ts";
import type { EntradaInstruccion, EntradaPolitica } from "./validacion.ts";

export class InMemoryRentasAccesoRepository implements RentasAccesoRepository {
  migracion025Disponible = true;
  readonly pendientes: LiberacionPendiente[] = [];
  readonly liberadas = new Set<string>();
  readonly pagosConfirmados = new Set<string>();
  readonly reservasConocidas = new Set<string>();
  readonly politicas = new Map<string, PoliticaAcceso>();
  readonly instrucciones = new Map<string, InstruccionAcceso & { propertyId: string }>();
  readonly unidadesPorProperty = new Map<string, Set<string>>();
  readonly bitacora: (EventoAccesoRecord & { propertyId: string })[] = [];
  /** Llamadas hechas al motor (para afirmar que un camino no llegó a tocarlo). */
  readonly llamadas: string[] = [];
  private seq = 0;

  private requiere(): void {
    if (!this.migracion025Disponible) {
      const e = new Error("function rentas.acceso_siguiente_liberacion(uuid[], timestamp with time zone) does not exist") as Error & { code: string };
      e.code = "42883";
      throw e;
    }
  }

  async obtenerPolitica(propertyId: string): Promise<ResultadoAcceso<PoliticaAcceso | null>> {
    if (!this.migracion025Disponible) return { disponible: false };
    return { disponible: true, valor: this.politicas.get(propertyId) ?? null };
  }

  async guardarPolitica(_org: string, propertyId: string, entrada: EntradaPolitica): Promise<ResultadoAcceso<PoliticaAcceso>> {
    if (!this.migracion025Disponible) return { disponible: false };
    const p: PoliticaAcceso = { propertyId, ...entrada };
    this.politicas.set(propertyId, p);
    return { disponible: true, valor: p };
  }

  async obtenerInstruccion(propertyId: string, unidadId: string): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    if (!this.migracion025Disponible) return { disponible: false };
    const i = this.instrucciones.get(unidadId);
    return { disponible: true, valor: i && i.propertyId === propertyId ? { unidadId: i.unidadId, direccionExacta: i.direccionExacta, codigoAcceso: i.codigoAcceso, instrucciones: i.instrucciones } : null };
  }

  async guardarInstruccion(_org: string, propertyId: string, unidadId: string, entrada: EntradaInstruccion): Promise<ResultadoAcceso<InstruccionAcceso | null>> {
    if (!this.migracion025Disponible) return { disponible: false };
    if (!this.unidadesPorProperty.get(propertyId)?.has(unidadId)) return { disponible: true, valor: null };
    const i = { unidadId, propertyId, ...entrada };
    this.instrucciones.set(unidadId, i);
    return { disponible: true, valor: { unidadId, ...entrada } };
  }

  async confirmarPago(ocupacionId: string, confirmado: boolean): Promise<ResultadoConfirmarPago> {
    if (!this.migracion025Disponible) return "no_disponible";
    if (!this.reservasConocidas.has(ocupacionId)) return "no_encontrada";
    if (confirmado) this.pagosConfirmados.add(ocupacionId);
    else this.pagosConfirmados.delete(ocupacionId);
    return confirmado ? "confirmado" : "revocado";
  }

  async listarBitacora(propertyId: string, limite: number): Promise<ResultadoAcceso<readonly EventoAccesoRecord[]>> {
    if (!this.migracion025Disponible) return { disponible: false };
    return { disponible: true, valor: this.bitacora.filter((b) => b.propertyId === propertyId).slice(-limite).reverse() };
  }

  async siguienteLiberacion(excluir: readonly string[]): Promise<LiberacionPendiente | null> {
    this.llamadas.push("siguienteLiberacion");
    this.requiere();
    return this.pendientes.find((p) => !this.liberadas.has(p.ocupacionId) && !excluir.includes(p.ocupacionId)) ?? null;
  }

  async marcarLiberada(ocupacionId: string): Promise<boolean> {
    this.llamadas.push("marcarLiberada");
    this.requiere();
    if (this.liberadas.has(ocupacionId)) return false;
    this.liberadas.add(ocupacionId);
    const p = this.pendientes.find((x) => x.ocupacionId === ocupacionId);
    this.bitacora.push({ id: `b${++this.seq}`, propertyId: p?.propertyId ?? "", ocupacionId, evento: "liberada", canal: "email", creadoEn: new Date().toISOString() });
    return true;
  }

  async registrarEvento(ocupacionId: string, evento: EventoOmitidoAcceso): Promise<boolean> {
    this.llamadas.push(`registrarEvento:${evento}`);
    this.requiere();
    if (this.bitacora.some((b) => b.ocupacionId === ocupacionId && b.evento === evento)) return false;
    const p = this.pendientes.find((x) => x.ocupacionId === ocupacionId);
    this.bitacora.push({ id: `b${++this.seq}`, propertyId: p?.propertyId ?? "", ocupacionId, evento, canal: null, creadoEn: new Date().toISOString() });
    return true;
  }
}

export { POLITICA_ACCESO_POR_DEFECTO };

// Almacen en memoria del conocimiento del negocio y del interruptor del agente de WhatsApp: mismo contrato que `postgres.ts`
// (incluido el aislamiento por organizacion y la sustitucion `reemplazaId` solo hacia una entrada general de la misma organizacion).
import { RestaurantesConfigUnavailableError } from "../repository.ts";
import type { ConocimientoEntrada, ConocimientoLectura, ConocimientoPatch, NuevaConocimientoEntrada } from "./types.ts";

export class InMemoryConocimientoStore {
  private readonly entradas = new Map<string, ConocimientoEntrada>();
  private readonly agentesApagados = new Map<string, string>(); // propertyId -> organizationId
  private seq = 0;
  /** Simula la base SIN migrar: lecturas vacias y escrituras `RestaurantesConfigUnavailableError`. */
  noDisponible = false;

  constructor(private readonly ahora: () => Date = () => new Date(), private readonly propiedadDeOrganizacion: (organizationId: string, propertyId: string) => boolean = () => true) {}

  listar(organizationId: string): ConocimientoLectura {
    if (this.noDisponible) return { disponible: false, entradas: [] };
    return { disponible: true, entradas: [...this.entradas.values()].filter((e) => e.organizationId === organizationId).sort((a, b) => b.prioridad - a.prioridad || b.updatedAt.localeCompare(a.updatedAt)) };
  }

  listarPublicado(organizationId: string, propertyId: string | null): readonly ConocimientoEntrada[] {
    if (this.noDisponible) return [];
    return this.listar(organizationId).entradas.filter((e) => e.activo && e.estado === "publicado" && (e.propertyId === null || e.propertyId === propertyId));
  }

  crear(organizationId: string, actorId: string, input: NuevaConocimientoEntrada): ConocimientoEntrada {
    if (this.noDisponible) throw new RestaurantesConfigUnavailableError();
    if (input.propertyId && !this.propiedadDeOrganizacion(organizationId, input.propertyId)) throw new Error("conocimiento: la sucursal no pertenece a la organizacion.");
    this.validarReemplazo(organizationId, input.propertyId ?? null, input.reemplazaId ?? null);
    const ahora = this.ahora().toISOString();
    this.seq += 1;
    const entrada: ConocimientoEntrada = {
      id: `cono-${this.seq}`,
      organizationId,
      propertyId: input.propertyId ?? null,
      reemplazaId: input.reemplazaId ?? null,
      titulo: input.titulo,
      texto: input.texto,
      tipo: input.tipo,
      prioridad: input.prioridad ?? 50,
      vigenteDesde: input.vigenteDesde ?? null,
      vigenteHasta: input.vigenteHasta ?? null,
      activo: input.activo ?? true,
      estado: input.estado ?? "publicado",
      origen: input.origen ?? "manual",
      version: 1,
      creadoPor: actorId,
      actualizadoPor: actorId,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.entradas.set(entrada.id, entrada);
    return entrada;
  }

  actualizar(organizationId: string, actorId: string, id: string, patch: ConocimientoPatch): ConocimientoEntrada | null {
    if (this.noDisponible) throw new RestaurantesConfigUnavailableError();
    const actual = this.entradas.get(id);
    if (!actual || actual.organizationId !== organizationId) return null;
    if (patch.reemplazaId !== undefined) this.validarReemplazo(organizationId, actual.propertyId, patch.reemplazaId);
    const definidos = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const nueva: ConocimientoEntrada = { ...actual, ...definidos, version: actual.version + 1, actualizadoPor: actorId, updatedAt: this.ahora().toISOString() };
    this.entradas.set(id, nueva);
    return nueva;
  }

  borrar(organizationId: string, id: string): boolean {
    if (this.noDisponible) throw new RestaurantesConfigUnavailableError();
    const actual = this.entradas.get(id);
    if (!actual || actual.organizationId !== organizationId) return false;
    this.entradas.delete(id);
    return true;
  }

  agenteActivo(propertyId: string): boolean {
    if (this.noDisponible) return true;
    return !this.agentesApagados.has(propertyId);
  }

  agentesApagadosDe(organizationId: string): { readonly disponible: boolean; readonly propertyIdsApagados: readonly string[] } {
    if (this.noDisponible) return { disponible: false, propertyIdsApagados: [] };
    return { disponible: true, propertyIdsApagados: [...this.agentesApagados].filter(([, org]) => org === organizationId).map(([p]) => p) };
  }

  fijarAgenteActivo(organizationId: string, propertyId: string, activo: boolean): void {
    if (this.noDisponible) throw new RestaurantesConfigUnavailableError();
    if (!this.propiedadDeOrganizacion(organizationId, propertyId)) throw new Error("conocimiento: la sucursal no pertenece a la organizacion.");
    if (activo) this.agentesApagados.delete(propertyId);
    else this.agentesApagados.set(propertyId, organizationId);
  }

  private validarReemplazo(organizationId: string, propertyId: string | null, reemplazaId: string | null): void {
    if (reemplazaId === null) return;
    const general = this.entradas.get(reemplazaId);
    // Mismo contrato que el CHECK (reemplaza_id solo con sucursal) y el trigger de la base (entrada GENERAL de la misma organizacion).
    if (propertyId === null || !general || general.organizationId !== organizationId || general.propertyId !== null) throw new Error("conocimiento: reemplaza_id debe apuntar a una entrada general de la misma organizacion.");
  }
}

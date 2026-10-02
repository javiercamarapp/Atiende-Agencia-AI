// Espejo en memoria de PostgresListaEsperaRepository (H-12) para tests de ruta. NO emula RLS/GRANT/triggers (eso lo cubre
// scripts/verify-hoteles-fechas-lista-espera contra Postgres real); SI replica las transiciones validas, el vencimiento de la
// oferta y la degradacion "base sin migrar" (`migrated: false` => lecturas vacias con `disponible:false`, escrituras 503).
import { randomUUID } from "node:crypto";
import type { ListaEsperaRepository } from "./repository.ts";
import {
  ListaEsperaConflictError,
  ListaEsperaInvalidInputError,
  ListaEsperaNotFoundError,
  ListaEsperaUnavailableError,
  type EntradaListaEspera,
  type EstadoListaEspera,
  type ListadoListaEspera,
  type NuevaEntradaListaEspera,
} from "./tipos.ts";

export class InMemoryListaEsperaRepository implements ListaEsperaRepository {
  /** `false` simula una base SIN la migracion 041. */
  migrated: boolean;
  private readonly entradas = new Map<string, EntradaListaEspera>();
  /** Orden de insercion: desempata entradas con la misma marca de tiempo (el reloj de las pruebas puede estar congelado). */
  private readonly orden = new Map<string, number>();

  constructor(opts: { readonly migrated?: boolean } = {}) {
    this.migrated = opts.migrated ?? true;
  }

  private requerir(operation: string): void {
    if (!this.migrated) throw new ListaEsperaUnavailableError(operation);
  }

  seed(entrada: EntradaListaEspera): void {
    this.entradas.set(entrada.id, entrada);
    this.orden.set(entrada.id, this.orden.size);
  }

  todas(): readonly EntradaListaEspera[] {
    return [...this.entradas.values()];
  }

  async listar(propertyId: string, estado: EstadoListaEspera | null): Promise<ListadoListaEspera> {
    if (!this.migrated) return { disponible: false, entradas: [] };
    const entradas = this.todas()
      .filter((e) => e.propertyId === propertyId && (estado === null || e.estado === estado))
      .sort((a, b) => (a.creadaEn < b.creadaEn ? -1 : a.creadaEn > b.creadaEn ? 1 : (this.orden.get(a.id) ?? 0) - (this.orden.get(b.id) ?? 0)));
    return { disponible: true, entradas };
  }

  async buscar(propertyId: string, id: string): Promise<EntradaListaEspera | null> {
    this.requerir("consultar la lista de espera");
    const e = this.entradas.get(id);
    return e && e.propertyId === propertyId ? e : null;
  }

  async crear(i: NuevaEntradaListaEspera): Promise<EntradaListaEspera> {
    this.requerir("agregar a la lista de espera");
    if (i.checkOutDate <= i.checkInDate || (!i.telefono && !i.email)) throw new ListaEsperaInvalidInputError("Datos invalidos: revisa fechas, huespedes y que haya telefono o correo.");
    const e: EntradaListaEspera = {
      id: randomUUID(),
      propertyId: i.propertyId,
      roomTypeId: i.roomTypeId,
      checkInDate: i.checkInDate,
      checkOutDate: i.checkOutDate,
      huespedes: i.huespedes,
      nombre: i.nombre,
      telefono: i.telefono,
      email: i.email,
      notas: i.notas,
      estado: "activa",
      ofrecidaEn: null,
      ofertaVenceEn: null,
      reservaId: null,
      creadaEn: new Date().toISOString(),
    };
    this.entradas.set(e.id, e);
    this.orden.set(e.id, this.orden.size);
    return e;
  }

  private mover(propertyId: string, id: string, desde: readonly EstadoListaEspera[], parche: Partial<EntradaListaEspera>, operation: string): EntradaListaEspera {
    this.requerir(operation);
    const e = this.entradas.get(id);
    if (!e || e.propertyId !== propertyId) throw new ListaEsperaNotFoundError("Entrada de la lista de espera");
    if (!desde.includes(e.estado)) throw new ListaEsperaConflictError(`transicion_invalida: ${e.estado} -> ${String(parche.estado)}`, "transicion_invalida");
    const nueva = { ...e, ...parche };
    this.entradas.set(id, nueva);
    return nueva;
  }

  async cancelar(propertyId: string, id: string): Promise<EntradaListaEspera> {
    return this.mover(propertyId, id, ["activa", "ofrecida"], { estado: "cancelada" }, "cancelar la entrada");
  }

  async ofrecer(propertyId: string, id: string, venceEn: Date): Promise<EntradaListaEspera> {
    const ahora = Date.now();
    if (venceEn.getTime() <= ahora || venceEn.getTime() > ahora + 7 * 86_400_000) throw new ListaEsperaInvalidInputError("La oferta debe vencer entre ahora y 7 dias.");
    return this.mover(propertyId, id, ["activa"], { estado: "ofrecida", ofrecidaEn: new Date(ahora).toISOString(), ofertaVenceEn: venceEn.toISOString() }, "ofrecer lugar");
  }

  async marcarAceptada(propertyId: string, id: string, reservationId: string): Promise<EntradaListaEspera> {
    const e = this.entradas.get(id);
    if (e && e.ofertaVenceEn !== null && new Date(e.ofertaVenceEn).getTime() <= Date.now()) throw new ListaEsperaConflictError("La oferta ya vencio.", "oferta_vencida");
    return this.mover(propertyId, id, ["ofrecida"], { estado: "aceptada", reservaId: reservationId }, "aceptar la oferta");
  }

  async expirarVencidas(propertyId: string, ahora: Date): Promise<number> {
    if (!this.migrated) return 0;
    let n = 0;
    for (const e of this.entradas.values()) {
      if (e.propertyId === propertyId && e.estado === "ofrecida" && e.ofertaVenceEn !== null && new Date(e.ofertaVenceEn).getTime() <= ahora.getTime()) {
        this.entradas.set(e.id, { ...e, estado: "expirada" });
        n += 1;
      }
    }
    return n;
  }

  async listarActivasCompatibles(propertyId: string, roomTypeId: string, desde: string, hasta: string): Promise<readonly EntradaListaEspera[]> {
    if (!this.migrated) return [];
    return this.todas()
      .filter((e) => e.propertyId === propertyId && e.roomTypeId === roomTypeId && e.estado === "activa" && e.checkInDate < hasta && e.checkOutDate > desde)
      .sort((a, b) => (a.creadaEn < b.creadaEn ? -1 : a.creadaEn > b.creadaEn ? 1 : (this.orden.get(a.id) ?? 0) - (this.orden.get(b.id) ?? 0)));
  }
}

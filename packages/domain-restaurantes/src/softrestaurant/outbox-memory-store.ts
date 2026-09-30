// Implementacion en memoria de ComandaOutboxStore: misma semantica que las funciones
// SQL de la migracion 024 (kill switch por bandera, lease, transiciones permitidas,
// captura manual que corta reintentos). La usan las pruebas de dominio y de rutas.
import { randomUUID } from "node:crypto";
import { esModoSoftRestaurant, resumenVacio } from "./outbox-store.ts";
import type {
  ComandaOutboxStore,
  EntradaEncolar,
  FilaComandaOutbox,
  FiltroListarComandas,
  ModoSoftRestaurant,
  ResultadoCaptura,
  ResultadoEncolar,
  ResultadoListar,
  ResumenComandas,
} from "./outbox-store.ts";
import type { DecisionTransicion, EstadoComanda } from "./outbox-state.ts";

interface FilaInterna {
  fila: FilaComandaOutbox;
  reclamadaEn: Date | null;
}

export interface OpcionesMemoryStore {
  readonly ahora?: () => Date;
  /** false = simula la base SIN la migracion 024 (todo devuelve "no disponible"/apagado). */
  readonly disponible?: boolean;
}

export class InMemoryComandaOutboxStore implements ComandaOutboxStore {
  private readonly modos = new Map<string, ModoSoftRestaurant>();
  private readonly filas = new Map<string, FilaInterna>();
  private readonly ahora: () => Date;
  disponible: boolean;

  constructor(opciones: OpcionesMemoryStore = {}) {
    this.ahora = opciones.ahora ?? (() => new Date());
    this.disponible = opciones.disponible ?? true;
  }

  /** Helper de pruebas: fija el modo sin pasar por el chequeo de rol. */
  ponerModo(organizationId: string, modo: ModoSoftRestaurant): void {
    this.modos.set(organizationId, modo);
  }

  /** Helper de pruebas: lee una fila tal cual. */
  fila(id: string): FilaComandaOutbox | undefined {
    return this.filas.get(id)?.fila;
  }

  todas(): FilaComandaOutbox[] {
    return [...this.filas.values()].map((f) => f.fila);
  }

  async leerModo(organizationId: string): Promise<ModoSoftRestaurant> {
    if (!this.disponible) return "apagado";
    const m = this.modos.get(organizationId);
    return esModoSoftRestaurant(m) ? m : "apagado";
  }

  async fijarModo(organizationId: string, modo: ModoSoftRestaurant): Promise<{ disponible: boolean }> {
    if (!this.disponible) return { disponible: false };
    this.modos.set(organizationId, modo);
    return { disponible: true };
  }

  async encolar(e: EntradaEncolar): Promise<ResultadoEncolar> {
    if (!this.disponible) return { disponible: false };
    const existente = [...this.filas.values()].find((f) => f.fila.organizationId === e.organizationId && f.fila.orderId === e.orderId);
    if (existente) return { disponible: true, fila: existente.fila };
    const ahora = this.ahora().toISOString();
    const fila: FilaComandaOutbox = {
      id: randomUUID(),
      organizationId: e.organizationId,
      propertyId: e.propertyId,
      orderId: e.orderId,
      estado: "pendiente",
      modo: e.modo,
      payload: e.payload,
      intentos: 0,
      maxIntentos: e.maxIntentos,
      proximoIntentoEn: ahora,
      folio: null,
      ultimoError: null,
      capturadoPor: null,
      capturadoEn: null,
      notaCaptura: null,
      creadoEn: ahora,
      actualizadoEn: ahora,
    };
    this.filas.set(fila.id, { fila, reclamadaEn: null });
    return { disponible: true, fila };
  }

  private reclamable(f: FilaInterna, ahora: Date, leaseMs: number): boolean {
    if (this.modos.get(f.fila.organizationId) === undefined || this.modos.get(f.fila.organizationId) === "apagado") return false;
    if (f.fila.estado === "pendiente" || f.fila.estado === "fallida") return new Date(f.fila.proximoIntentoEn).getTime() <= ahora.getTime();
    if (f.fila.estado === "enviada") return f.reclamadaEn !== null && f.reclamadaEn.getTime() + leaseMs <= ahora.getTime();
    return false;
  }

  private reclamar(f: FilaInterna, ahora: Date): FilaComandaOutbox {
    const nueva: FilaComandaOutbox = { ...f.fila, estado: "enviada", intentos: f.fila.intentos + 1, actualizadoEn: ahora.toISOString() };
    f.fila = nueva;
    f.reclamadaEn = ahora;
    return nueva;
  }

  /** Un envio muerto en su ULTIMO intento no se reclama otra vez: pasa a captura manual (igual que la funcion SQL). */
  private barrerAgotadas(ahora: Date, leaseMs: number, soloId?: string): void {
    for (const f of this.filas.values()) {
      if (soloId && f.fila.id !== soloId) continue;
      if (f.fila.estado === "enviada" && f.reclamadaEn && f.reclamadaEn.getTime() + leaseMs <= ahora.getTime() && f.fila.intentos >= f.fila.maxIntentos) {
        f.fila = { ...f.fila, estado: "captura_manual", ultimoError: "lease_vencido:intentos_agotados", actualizadoEn: ahora.toISOString() };
        f.reclamadaEn = null;
      }
    }
  }

  async reclamarPorId(id: string, ahora: Date, leaseMs: number): Promise<FilaComandaOutbox | null> {
    if (!this.disponible) return null;
    this.barrerAgotadas(ahora, leaseMs, id);
    const f = this.filas.get(id);
    if (!f || !this.reclamable(f, ahora, leaseMs)) return null;
    return this.reclamar(f, ahora);
  }

  async reclamarLote(limite: number, ahora: Date, leaseMs: number): Promise<readonly FilaComandaOutbox[]> {
    if (!this.disponible) return [];
    this.barrerAgotadas(ahora, leaseMs);
    const listas = [...this.filas.values()]
      .filter((f) => this.reclamable(f, ahora, leaseMs))
      .sort((a, b) => a.fila.proximoIntentoEn.localeCompare(b.fila.proximoIntentoEn) || a.fila.creadoEn.localeCompare(b.fila.creadoEn))
      .slice(0, limite);
    return listas.map((f) => this.reclamar(f, ahora));
  }

  async completar(id: string, d: DecisionTransicion): Promise<boolean> {
    if (!this.disponible) return false;
    const f = this.filas.get(id);
    if (!f || f.fila.estado !== "enviada") return false;
    if (d.estado === "confirmada" && (!d.folio || d.folio.trim() === "")) throw new Error("completar: una comanda confirmada requiere folio");
    f.fila = {
      ...f.fila,
      estado: d.estado,
      folio: d.estado === "confirmada" ? d.folio : null,
      ultimoError: d.ultimoError,
      proximoIntentoEn: d.estado === "fallida" && d.proximoIntentoEn ? d.proximoIntentoEn.toISOString() : f.fila.proximoIntentoEn,
      actualizadoEn: this.ahora().toISOString(),
    };
    f.reclamadaEn = null;
    return true;
  }

  async listar(organizationId: string, filtro: FiltroListarComandas): Promise<ResultadoListar> {
    if (!this.disponible) return { disponible: false, filas: [] };
    const filas = [...this.filas.values()]
      .map((f) => f.fila)
      .filter((f) => f.organizationId === organizationId)
      .filter((f) => filtro.propertyIds === null || filtro.propertyIds.includes(f.propertyId))
      .filter((f) => !filtro.estados || filtro.estados.includes(f.estado))
      .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn) || b.id.localeCompare(a.id))
      .slice(filtro.offset, filtro.offset + filtro.limite);
    return { disponible: true, filas };
  }

  async resumen(organizationId: string, propertyIds: readonly string[] | null): Promise<ResumenComandas> {
    const porEstado = resumenVacio();
    if (!this.disponible) return { disponible: false, porEstado };
    for (const f of this.filas.values()) {
      if (f.fila.organizationId !== organizationId) continue;
      if (propertyIds !== null && !propertyIds.includes(f.fila.propertyId)) continue;
      porEstado[f.fila.estado as EstadoComanda] += 1;
    }
    return { disponible: true, porEstado };
  }

  async marcarCapturada(organizationId: string, id: string, actorUserId: string, nota: string | null): Promise<ResultadoCaptura> {
    if (!this.disponible) return { resultado: "no_disponible" };
    const f = this.filas.get(id);
    if (!f || f.fila.organizationId !== organizationId) return { resultado: "no_encontrada" };
    if (f.fila.estado !== "pendiente" && f.fila.estado !== "fallida" && f.fila.estado !== "captura_manual") return { resultado: "estado_invalido" };
    const ahora = this.ahora().toISOString();
    f.fila = { ...f.fila, estado: "capturada_manual", capturadoPor: actorUserId, capturadoEn: ahora, notaCaptura: nota ? nota.slice(0, 500) : null, actualizadoEn: ahora };
    f.reclamadaEn = null;
    return { resultado: "ok", fila: f.fila };
  }
}

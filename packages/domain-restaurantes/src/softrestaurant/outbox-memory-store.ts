// Implementacion en memoria de ComandaOutboxStore: misma semantica que las funciones
// SQL de la migracion 024 (kill switch por bandera, lease, transiciones permitidas,
// captura manual que corta reintentos). La usan las pruebas de dominio y de rutas.
import { randomUUID } from "node:crypto";
import { esModoSoftRestaurant, resumenVacio } from "./outbox-store.ts";
import { UMBRAL_CAPTURA_MANUAL_POR_OMISION_MIN } from "./outbox-store.ts";
import type {
  ComandaOutboxStore,
  ComandaVencida,
  ResultadoEstadosPorPedido,
  ResultadoUmbrales,
  ResultadoVencidas,
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
      .filter((f) => filtro.orderId === undefined || f.orderId === filtro.orderId)
      .sort((a, b) => b.creadoEn.localeCompare(a.creadoEn) || b.id.localeCompare(a.id))
      .slice(filtro.offset, filtro.offset + filtro.limite);
    return { disponible: true, filas };
  }

  async obtener(organizationId: string, id: string): Promise<FilaComandaOutbox | null> {
    if (!this.disponible) return null;
    const f = this.filas.get(id)?.fila;
    return f && f.organizationId === organizationId ? f : null;
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

  private readonly umbrales = new Map<string, { organizationId: string; minutos: number }>();
  private readonly organizacionDeSucursal = new Map<string, string>();

  /** Helper de pruebas: la sucursal pertenece a la organizacion (en SQL lo deriva core.property). */
  registrarSucursal(propertyId: string, organizationId: string): void {
    this.organizacionDeSucursal.set(propertyId, organizationId);
  }

  async listarCapturaManualVencidas(ahora: Date): Promise<ResultadoVencidas> {
    if (!this.disponible) return { disponible: false, filas: [] };
    const filas: ComandaVencida[] = [];
    for (const f of this.filas.values()) {
      if (f.fila.estado !== "captura_manual") continue;
      const umbral = this.umbrales.get(f.fila.propertyId)?.minutos ?? UMBRAL_CAPTURA_MANUAL_POR_OMISION_MIN;
      const desde = new Date(f.fila.actualizadoEn).getTime();
      if (desde > ahora.getTime() - umbral * 60_000) continue;
      filas.push({ comandaId: f.fila.id, orderId: f.fila.orderId, organizationId: f.fila.organizationId, propertyId: f.fila.propertyId, minutos: Math.max(0, Math.floor((ahora.getTime() - desde) / 60_000)) });
    }
    return { disponible: true, filas: filas.sort((a, b) => b.minutos - a.minutos).slice(0, 200) };
  }

  async leerUmbralesCapturaManual(organizationId: string): Promise<ResultadoUmbrales> {
    if (!this.disponible) return { disponible: false, porSucursal: {} };
    const porSucursal: Record<string, number> = {};
    for (const [propertyId, u] of this.umbrales) if (u.organizationId === organizationId) porSucursal[propertyId] = u.minutos;
    return { disponible: true, porSucursal };
  }

  async fijarUmbralCapturaManual(propertyId: string, minutos: number): Promise<{ readonly disponible: boolean }> {
    if (!this.disponible) return { disponible: false };
    const organizationId = this.organizacionDeSucursal.get(propertyId) ?? [...this.filas.values()].find((f) => f.fila.propertyId === propertyId)?.fila.organizationId;
    if (!organizationId) throw Object.assign(new Error("set_umbral_captura_manual: sucursal desconocida"), { code: "42501" });
    this.umbrales.set(propertyId, { organizationId, minutos });
    return { disponible: true };
  }

  async estadosPorPedidos(organizationId: string, orderIds: readonly string[]): Promise<ResultadoEstadosPorPedido> {
    if (!this.disponible) return { disponible: false, estados: {} };
    const pedidos = new Set(orderIds);
    const estados: Record<string, EstadoComanda> = {};
    for (const f of this.filas.values()) if (f.fila.organizationId === organizationId && pedidos.has(f.fila.orderId)) estados[f.fila.orderId] = f.fila.estado as EstadoComanda;
    return { disponible: true, estados };
  }
}

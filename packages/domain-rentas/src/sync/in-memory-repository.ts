// InMemoryRentasCalendarSyncRepository — implementación real (no un mock) de
// `RentasCalendarSyncRepository`, para tests determinísticos del motor de
// sincronización (./motor.ts). Lee/escribe la MISMA instancia de
// `InMemoryRentasCalendarStore` que ya usa `InMemoryRentasRepository`/
// `InMemoryRentasTenancyEngine` para `rentas.ocupacion` (ver calendar-store.ts) — en
// Postgres real, las lecturas de export/recuperación de bookkeeping de abajo también
// leen `rentas.ocupacion` directamente, así que esta fixture reproduce esa misma
// propiedad en vez de mantener una copia divergente.
import { randomUUID } from "node:crypto";
import type { InMemoryRentasCalendarStore, StoredOcupacion } from "../calendar-store.ts";
import type { RangoFechas } from "../tipos.ts";
import type { UidActivoInterno } from "./reconciliacion.ts";
import { ESTADO_FEED_INICIAL, type EstadoFeedCanal } from "./cuarentena.ts";
import type { RentasCalendarSyncRepository } from "./repository.ts";
import { calcularBackoffFeedSegundos, type EventoBitacora, type OpcionesReclamo, type ResultadoReclamo } from "./lease.ts";
import { calcularSolape, type AccionConflicto } from "./conflictos.ts";
import type { AlertaSyncRecord, ConflictoMonitorRecord, EntradaHistorialConflicto, EstadoConflicto, FeedMonitorRecord, FiltroEstadoConflictos, HistorialConflicto, ListadoBitacora, ListadoConflictos, OcupacionConflictoRecord, ResultadoDecisionConflicto, ResultadoMarcarResuelto } from "./monitor.ts";
import type { BloqueoExportadoPrevio, EntradaUpsertBloqueoExportado, EntradaUpsertEventoImportado, FeedExternoRecord, NewFeedExternoInput, OcupacionActivaExportable, VersionPreviaAlmacenada } from "./tipos.ts";

interface StoredFeedExterno {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  canalId: string;
  urlImportacion: string;
  activo: boolean;
  estadoSync: EstadoFeedCanal;
  etagImport: string | null;
  ultimaModificacionHttpImport: string | null;
  driftUltimaReconciliacionCompleta: number;
  ultimoResumen: unknown;
  /** Rn-01 -- espejo de las columnas de lease/backoff de la migración 024. */
  leaseHasta: number | null;
  leaseToken: string | null;
  ultimoIntentoEn: number | null;
  proximoIntentoEn: number | null;
}

interface StoredBitacora {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  feedId: string;
  canalId: string;
  evento: EventoBitacora;
  creadoEn: string;
  atendidaEn: string | null;
  atendidaPor: string | null;
}

interface StoredEventoImportado {
  unidadId: string;
  canalId: string;
  uidEvento: string;
  sequence: number | null;
  dtstamp: string;
  hashContenido: string;
  ocupacionId: string | null;
  ultimaAccion: EntradaUpsertEventoImportado["ultimaAccion"];
}

interface StoredBloqueoExportado {
  ocupacionId: string;
  canalId: string;
  uidExportado: string;
  hashContenido: string;
  sequence: number;
}

function seSolapan(aInicio: string, aFin: string, bInicio: string, bFin: string): boolean {
  return aInicio < bFin && bInicio < aFin;
}

export class InMemoryRentasCalendarSyncRepository implements RentasCalendarSyncRepository {
  private readonly feeds = new Map<string, StoredFeedExterno>();
  private readonly eventosImportados = new Map<string, StoredEventoImportado>(); // key: unidadId:canalId:uid
  private readonly bloqueosExportados = new Map<string, StoredBloqueoExportado>(); // key: ocupacionId:canalId
  private readonly zonasHorarias = new Map<string, string>(); // key: propertyId
  private readonly bitacora = new Map<string, StoredBitacora>();

  /** Reloj inyectable (ms epoch) para probar lease/backoff de forma determinística. */
  reloj: () => number = () => Date.now();

  /** Contadores de llamadas a los métodos BATCH de export -- expuestos para que los
   * tests de rendimiento (ver domain-rentas/tests/sync-motor.spec.ts) verifiquen que
   * `exportarFeedParaUnidad` ejecuta un número de llamadas al repositorio FIJO, sin
   * importar cuántas ocupaciones tenga la unidad (hallazgo de auditoría, rubro 10
   * "performance y escalabilidad": "feed iCal público... ejecuta 3+2N queries por
   * request"). No forman parte del contrato `RentasCalendarSyncRepository`. */
  llamadasFindBloqueosExportadosPrevios = 0;
  llamadasUpsertBloqueosExportadosBatch = 0;

  constructor(private readonly calendarStore: InMemoryRentasCalendarStore) {}

  /** Para fixtures de prueba -- `rentas.property_config.zona_horaria` no vive en
   * `InMemoryRentasCalendarStore` (fuera del alcance angosto de ese store, ver su
   * comentario de cabecera). Sin sembrar, `findZonaHorariaPropiedad` cae a `"UTC"`. */
  seedZonaHoraria(propertyId: string, zonaHoraria: string): void {
    this.zonasHorarias.set(propertyId, zonaHoraria);
  }

  async findZonaHorariaPropiedad(propertyId: string): Promise<string> {
    return this.zonasHorarias.get(propertyId) ?? "UTC";
  }

  private toRecord(f: StoredFeedExterno): FeedExternoRecord {
    const canal = [...this.calendarStore.canales.values()].find((c) => c.id === f.canalId);
    return {
      id: f.id,
      organizationId: f.organizationId,
      propertyId: f.propertyId,
      unidadId: f.unidadId,
      canalId: f.canalId,
      canalCodigo: canal?.codigo ?? "desconocido",
      urlImportacion: f.urlImportacion,
      activo: f.activo,
      estadoSync: f.estadoSync,
      etagImport: f.etagImport,
      ultimaModificacionHttpImport: f.ultimaModificacionHttpImport,
      driftUltimaReconciliacionCompleta: f.driftUltimaReconciliacionCompleta,
      ultimoResumen: f.ultimoResumen,
    };
  }

  async connectFeed(input: NewFeedExternoInput): Promise<{ id: string }> {
    const existente = [...this.feeds.values()].find((f) => f.unidadId === input.unidadId && f.canalId === input.canalId);
    if (existente) {
      existente.urlImportacion = input.urlImportacion;
      existente.activo = true;
      return { id: existente.id };
    }
    const id = randomUUID();
    this.feeds.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      canalId: input.canalId,
      urlImportacion: input.urlImportacion,
      activo: true,
      estadoSync: ESTADO_FEED_INICIAL,
      etagImport: null,
      ultimaModificacionHttpImport: null,
      driftUltimaReconciliacionCompleta: 0,
      ultimoResumen: null,
      leaseHasta: null,
      leaseToken: null,
      ultimoIntentoEn: null,
      proximoIntentoEn: null,
    });
    return { id };
  }

  async disconnectFeed(propertyId: string, unidadId: string, canalId: string): Promise<boolean> {
    const fila = [...this.feeds.values()].find((f) => f.propertyId === propertyId && f.unidadId === unidadId && f.canalId === canalId && f.activo);
    if (!fila) return false;
    fila.activo = false;
    return true;
  }

  async findFeed(propertyId: string, unidadId: string, canalId: string): Promise<FeedExternoRecord | null> {
    const fila = [...this.feeds.values()].find((f) => f.propertyId === propertyId && f.unidadId === unidadId && f.canalId === canalId);
    return fila ? this.toRecord(fila) : null;
  }

  async findFeedById(propertyId: string, feedId: string): Promise<FeedExternoRecord | null> {
    const fila = this.feeds.get(feedId);
    if (!fila || fila.propertyId !== propertyId) return null;
    return this.toRecord(fila);
  }

  async listFeedsForUnidad(propertyId: string, unidadId: string): Promise<FeedExternoRecord[]> {
    return [...this.feeds.values()]
      .filter((f) => f.propertyId === propertyId && f.unidadId === unidadId)
      .map((f) => this.toRecord(f));
  }

  async listFeedsActivos(): Promise<FeedExternoRecord[]> {
    return [...this.feeds.values()].filter((f) => f.activo).map((f) => this.toRecord(f));
  }

  async persistFeedSyncState(feedId: string, estado: EstadoFeedCanal, etag: string | null, ultimaModificacionHttp: string | null, drift: number | undefined, ultimoResumen: unknown): Promise<void> {
    const fila = this.feeds.get(feedId);
    if (!fila) throw new Error(`rentas.canal_feed_externo ${feedId} no existe`);
    fila.estadoSync = estado;
    fila.etagImport = etag;
    fila.ultimaModificacionHttpImport = ultimaModificacionHttp;
    if (drift !== undefined) fila.driftUltimaReconciliacionCompleta = drift;
    fila.ultimoResumen = ultimoResumen;
  }

  async findVersionPrevia(unidadId: string, canalId: string, uid: string): Promise<VersionPreviaAlmacenada | null> {
    const fila = this.eventosImportados.get(`${unidadId}:${canalId}:${uid}`);
    if (!fila) return null;
    const ocupacion = fila.ocupacionId ? this.calendarStore.getOcupacion(fila.ocupacionId) : null;
    return {
      sequence: fila.sequence,
      dtstamp: fila.dtstamp,
      hashContenido: fila.hashContenido,
      ocupacionId: fila.ocupacionId,
      rango: ocupacion ? { inicio: ocupacion.inicio, fin: ocupacion.fin } : null,
    };
  }

  async upsertEventoImportado(unidadId: string, canalId: string, entrada: EntradaUpsertEventoImportado): Promise<void> {
    const clave = `${unidadId}:${canalId}:${entrada.uid}`;
    const existente = this.eventosImportados.get(clave);
    if (entrada.sobrescribirVersion || !existente) {
      this.eventosImportados.set(clave, {
        unidadId,
        canalId,
        uidEvento: entrada.uid,
        sequence: entrada.sequence,
        dtstamp: entrada.dtstamp,
        hashContenido: entrada.hashContenido,
        ocupacionId: entrada.ocupacionId,
        ultimaAccion: entrada.ultimaAccion,
      });
    } else {
      existente.ultimaAccion = entrada.ultimaAccion;
    }
  }

  async listUidsActivosInternos(unidadId: string, canalId: string): Promise<UidActivoInterno[]> {
    const resultado: UidActivoInterno[] = [];
    for (const fila of this.eventosImportados.values()) {
      if (fila.unidadId !== unidadId || fila.canalId !== canalId || !fila.ocupacionId) continue;
      const ocupacion = this.calendarStore.getOcupacion(fila.ocupacionId);
      if (ocupacion && ocupacion.estado !== "cancelado") {
        resultado.push({ ocupacionId: fila.ocupacionId, uidCanal: fila.uidEvento });
      }
    }
    return resultado;
  }

  async buscarOcupacionActivaParaRecuperarBookkeeping(unidadId: string, canalId: string, externalId: string, rango: RangoFechas): Promise<string | null> {
    const filas: StoredOcupacion[] = [...this.calendarStore.ocupaciones.values()];
    const encontrada = filas
      .filter((o) => o.unidadId === unidadId && o.canalOrigenId === canalId && o.externalId === externalId && o.estado !== "cancelado" && o.inicio === rango.inicio && o.fin === rango.fin)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    return encontrada ? encontrada.id : null;
  }

  async guardarDatosCanalOcupacion(ocupacionId: string, datos: { readonly codigoConfirmacion: string | null; readonly telefonoUltimos4: string | null }): Promise<boolean> {
    if (datos.codigoConfirmacion === null && datos.telefonoUltimos4 === null) return false;
    const ocupacion = this.calendarStore.getOcupacion(ocupacionId);
    if (!ocupacion) return false;
    const codigo = datos.codigoConfirmacion ?? ocupacion.codigoConfirmacion ?? null;
    const telefono = datos.telefonoUltimos4 ?? ocupacion.telefonoUltimos4 ?? null;
    if (codigo === (ocupacion.codigoConfirmacion ?? null) && telefono === (ocupacion.telefonoUltimos4 ?? null)) return false;
    ocupacion.codigoConfirmacion = codigo;
    ocupacion.telefonoUltimos4 = telefono;
    return true;
  }

  async contarOcupacionesActivasDelCanal(unidadId: string, canalId: string): Promise<number> {
    return [...this.calendarStore.ocupaciones.values()].filter((o) => o.unidadId === unidadId && o.canalOrigenId === canalId && o.estado !== "cancelado" && o.bloqueante && o.capa === "reserva").length;
  }

  async listHashesExportadosRecientes(unidadId: string): Promise<string[]> {
    const resultado: string[] = [];
    for (const fila of this.bloqueosExportados.values()) {
      const ocupacion = this.calendarStore.getOcupacion(fila.ocupacionId);
      if (ocupacion && ocupacion.unidadId === unidadId) resultado.push(fila.hashContenido);
    }
    return resultado;
  }

  async listCanalesExportadosDeRango(unidadId: string, rango: RangoFechas): Promise<string[]> {
    const resultado: string[] = [];
    for (const fila of this.bloqueosExportados.values()) {
      const ocupacion = this.calendarStore.getOcupacion(fila.ocupacionId);
      if (ocupacion && ocupacion.unidadId === unidadId && ocupacion.inicio === rango.inicio && ocupacion.fin === rango.fin) {
        resultado.push(fila.canalId);
      }
    }
    return resultado;
  }

  async listOcupacionesActivasBloqueantes(unidadId: string): Promise<OcupacionActivaExportable[]> {
    return [...this.calendarStore.ocupaciones.values()]
      .filter((o) => o.unidadId === unidadId && o.estado !== "cancelado" && o.bloqueante)
      .map((o) => ({ id: o.id, inicio: o.inicio, fin: o.fin, razon: o.razon }));
  }

  async findBloqueosExportadosPrevios(ocupacionIds: readonly string[], canalId: string): Promise<Map<string, BloqueoExportadoPrevio>> {
    this.llamadasFindBloqueosExportadosPrevios += 1;
    const resultado = new Map<string, BloqueoExportadoPrevio>();
    for (const ocupacionId of ocupacionIds) {
      const fila = this.bloqueosExportados.get(`${ocupacionId}:${canalId}`);
      if (fila) resultado.set(ocupacionId, { hashContenido: fila.hashContenido, sequence: fila.sequence });
    }
    return resultado;
  }

  async upsertBloqueosExportadosBatch(_organizationId: string, _propertyId: string, canalId: string, entradas: readonly EntradaUpsertBloqueoExportado[]): Promise<void> {
    this.llamadasUpsertBloqueosExportadosBatch += 1;
    for (const entrada of entradas) {
      this.bloqueosExportados.set(`${entrada.ocupacionId}:${canalId}`, { ocupacionId: entrada.ocupacionId, canalId, uidExportado: entrada.uidExportado, hashContenido: entrada.hashContenido, sequence: entrada.sequence });
    }
  }

  // ---- Rn-01: claim/lease por feed, backoff y bitácora (espejo de migrations/024) ----
  /** Contador de llamadas a `reclamarFeeds` -- para pruebas de la orquestación. */
  llamadasReclamarFeeds = 0;
  /** Simula una base SIN la migración 024: `reclamarFeeds` devuelve `disponible: false`. */
  migracion024Disponible = true;

  async reclamarFeeds(opciones: OpcionesReclamo): Promise<ResultadoReclamo> {
    this.llamadasReclamarFeeds += 1;
    if (!this.migracion024Disponible) return { disponible: false };
    const ahora = this.reloj();
    const limite = Math.min(Math.max(opciones.limite, 1), 50);
    const lease = Math.min(Math.max(opciones.leaseSegundos, 30), 900);
    const minimo = Math.min(Math.max(opciones.intervaloMinimoSegundos, 0), 3600);
    const candidatos = [...this.feeds.values()]
      .filter(
        (f) =>
          f.activo &&
          (f.leaseHasta === null || f.leaseHasta <= ahora) &&
          (f.proximoIntentoEn === null || f.proximoIntentoEn <= ahora) &&
          (f.ultimoIntentoEn === null || f.ultimoIntentoEn <= ahora - minimo * 1000),
      )
      .sort((a, b) => (a.ultimoIntentoEn ?? -Infinity) - (b.ultimoIntentoEn ?? -Infinity) || (a.id < b.id ? -1 : 1))
      .slice(0, limite);
    const feeds = candidatos.map((f) => {
      f.leaseHasta = ahora + lease * 1000;
      f.leaseToken = randomUUID();
      f.ultimoIntentoEn = ahora;
      return { feed: this.toRecord(f), leaseToken: f.leaseToken };
    });
    return { disponible: true, feeds };
  }

  async liberarFeed(feedId: string, leaseToken: string, exito: boolean): Promise<boolean> {
    if (!this.migracion024Disponible) return false;
    const f = this.feeds.get(feedId);
    if (!f || f.leaseToken === null || f.leaseToken !== leaseToken) return false;
    f.leaseHasta = null;
    f.leaseToken = null;
    f.proximoIntentoEn = exito ? null : this.reloj() + calcularBackoffFeedSegundos(f.estadoSync.intentosFallidosConsecutivos) * 1000;
    return true;
  }

  async registrarEventoBitacora(feedId: string, evento: EventoBitacora): Promise<boolean> {
    if (!this.migracion024Disponible) return false;
    const f = this.feeds.get(feedId);
    if (!f) throw new Error(`rentas.canal_feed_externo ${feedId} no existe`);
    const id = randomUUID();
    this.bitacora.set(id, { id, organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, feedId, canalId: f.canalId, evento: { ...evento, detalle: evento.detalle.slice(0, 500) }, creadoEn: new Date(this.reloj()).toISOString(), atendidaEn: null, atendidaPor: null });
    return true;
  }

  async reiniciarBackoffFeed(feedId: string): Promise<void> {
    const f = this.feeds.get(feedId);
    if (f) f.proximoIntentoEn = null;
  }

  // ---- Rn-01/Rn-02: monitor ----
  private nombreUnidad(unidadId: string): string | null {
    return this.calendarStore.unidades.get(unidadId)?.name ?? null;
  }

  private codigoCanal(canalId: string | null): string | null {
    if (!canalId) return null;
    return [...this.calendarStore.canales.values()].find((c) => c.id === canalId)?.codigo ?? null;
  }

  async listarFeedsMonitor(propertyId: string): Promise<FeedMonitorRecord[]> {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return [...this.feeds.values()]
      .filter((f) => f.propertyId === propertyId)
      .map((f) => ({
        id: f.id,
        unidadId: f.unidadId,
        unidadNombre: this.nombreUnidad(f.unidadId),
        canalCodigo: this.codigoCanal(f.canalId) ?? "desconocido",
        activo: f.activo,
        ultimaSincronizacionExitosaEn: f.estadoSync.ultimaSincronizacionExitosaEn,
        enCuarentenaDesde: f.estadoSync.enCuarentenaDesde,
        intentosFallidosConsecutivos: f.estadoSync.intentosFallidosConsecutivos,
        motivoCuarentena: f.estadoSync.motivoCuarentena,
        ultimoIntentoEn: this.migracion024Disponible ? iso(f.ultimoIntentoEn) : null,
        proximoIntentoEn: this.migracion024Disponible ? iso(f.proximoIntentoEn) : null,
        leaseHasta: this.migracion024Disponible ? iso(f.leaseHasta) : null,
      }))
      .sort((a, b) => (a.unidadNombre ?? "").localeCompare(b.unidadNombre ?? "") || a.canalCodigo.localeCompare(b.canalCodigo));
  }

  private ocupacionConflicto(id: string | null): OcupacionConflictoRecord | null {
    if (!id) return null;
    const o = this.calendarStore.getOcupacion(id);
    if (!o) return null;
    return { id: o.id, inicio: o.inicio, fin: o.fin, estado: o.estado, capa: o.capa, canalCodigo: this.codigoCanal(o.canalOrigenId) };
  }

  /** Simula una base SIN la migración 026: no hay `ignorado`, motivo ni bitácora de conflictos. */
  migracion026Disponible = true;
  private readonly historialConflictos = new Map<string, EntradaHistorialConflicto[]>();

  private estadoConflicto(k: { resueltoEn: string | null; resolucion: "resuelto" | "ignorado" | null }): EstadoConflicto {
    if (k.resueltoEn === null) return "abierto";
    return this.migracion026Disponible && k.resolucion === "ignorado" ? "ignorado" : "resuelto";
  }

  async listarConflictos(propertyId: string, opciones: { estado: FiltroEstadoConflictos; limite: number }): Promise<ListadoConflictos> {
    const delaProperty = [...this.calendarStore.conflictos.values()].filter((k) => k.propertyId === propertyId);
    const totalAbiertos = delaProperty.filter((k) => k.resueltoEn === null).length;
    const filtro: Record<FiltroEstadoConflictos, (e: EstadoConflicto) => boolean> = {
      abiertos: (e) => e === "abierto",
      resueltos: (e) => e === "resuelto",
      ignorados: (e) => e === "ignorado",
      todos: () => true,
    };
    const conflictos: ConflictoMonitorRecord[] = [];
    for (const k of delaProperty
      .filter((c) => filtro[opciones.estado](this.estadoConflicto(c)))
      .sort((a, b) => Number(a.resueltoEn !== null) - Number(b.resueltoEn !== null) || (a.detectadoEn < b.detectadoEn ? 1 : a.detectadoEn > b.detectadoEn ? -1 : a.id < b.id ? -1 : 1))
      .slice(0, opciones.limite)) {
      const a = this.ocupacionConflicto(k.ocupacionAId);
      if (!a) continue;
      conflictos.push({
        id: k.id,
        estado: this.estadoConflicto(k),
        motivoResolucion: this.migracion026Disponible ? k.motivoResolucion : null,
        unidadId: k.unidadId,
        unidadNombre: this.nombreUnidad(k.unidadId),
        tipo: k.tipo,
        detectadoEn: k.detectadoEn,
        resueltoEn: k.resueltoEn,
        resueltoPor: k.resueltoPor,
        ocupacionA: a,
        ocupacionB: this.ocupacionConflicto(k.ocupacionBId),
      });
    }
    return { conflictos, totalAbiertos };
  }

  async decidirConflicto(propertyId: string, conflictoId: string, actorUserId: string, decision: { accion: AccionConflicto; motivo: string | null }): Promise<ResultadoDecisionConflicto> {
    if (!this.migracion024Disponible) return "no_disponible";
    if (!this.migracion026Disponible && decision.accion === "ignorado") return "no_disponible";
    const k = this.calendarStore.conflictos.get(conflictoId);
    if (!k || k.propertyId !== propertyId || k.resueltoEn !== null) return "no_encontrado";
    if (this.migracion026Disponible && decision.accion === "resuelto") {
      // Misma regla que rentas.resolver_conflicto_calendario: "resuelto" exige que el solape ya no exista.
      const a = this.calendarStore.getOcupacion(k.ocupacionAId);
      const b = k.ocupacionBId ? this.calendarStore.getOcupacion(k.ocupacionBId) : undefined;
      if (a && b && a.estado !== "cancelado" && b.estado !== "cancelado" && calcularSolape({ inicio: a.inicio, fin: a.fin }, { inicio: b.inicio, fin: b.fin }) !== null) return "solape_vigente";
    }
    const ahora = new Date(this.reloj()).toISOString();
    k.resueltoEn = ahora;
    k.resueltoPor = actorUserId;
    if (this.migracion026Disponible) {
      k.resolucion = decision.accion;
      k.motivoResolucion = decision.motivo;
      const previas = this.historialConflictos.get(conflictoId) ?? [];
      previas.push({ id: randomUUID(), accion: decision.accion, motivo: decision.motivo, actorUserId, creadoEn: ahora });
      this.historialConflictos.set(conflictoId, previas);
    }
    return decision.accion;
  }

  async listarHistorialConflicto(propertyId: string, conflictoId: string): Promise<HistorialConflicto> {
    if (!this.migracion026Disponible) return { disponible: false, entradas: [] };
    const k = this.calendarStore.conflictos.get(conflictoId);
    if (!k || k.propertyId !== propertyId) return { disponible: true, entradas: [] };
    return { disponible: true, entradas: [...(this.historialConflictos.get(conflictoId) ?? [])] };
  }

  async listarBitacora(propertyId: string, opciones: { soloAlertasAbiertas: boolean; limite: number }): Promise<ListadoBitacora> {
    if (!this.migracion024Disponible) return { disponible: false, alertas: [] };
    const alertas: AlertaSyncRecord[] = [...this.bitacora.values()]
      .filter((b) => b.propertyId === propertyId && (!opciones.soloAlertasAbiertas || (b.atendidaEn === null && (b.evento.severidad === "aviso" || b.evento.severidad === "critica"))))
      .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : a.creadoEn > b.creadoEn ? -1 : a.id < b.id ? -1 : 1))
      .slice(0, opciones.limite)
      .map((b) => ({
        id: b.id,
        unidadId: b.unidadId,
        unidadNombre: this.nombreUnidad(b.unidadId),
        canalCodigo: this.codigoCanal(b.canalId) ?? "desconocido",
        tipo: b.evento.tipo,
        severidad: b.evento.severidad,
        detalle: b.evento.detalle,
        eventosAplicados: b.evento.eventosAplicados,
        conflictos: b.evento.conflictos,
        creadoEn: b.creadoEn,
        atendidaEn: b.atendidaEn,
      }));
    return { disponible: true, alertas };
  }

  async atenderAlerta(propertyId: string, alertaId: string, actorUserId: string): Promise<ResultadoMarcarResuelto> {
    if (!this.migracion024Disponible) return "no_disponible";
    const b = this.bitacora.get(alertaId);
    if (!b || b.propertyId !== propertyId || b.atendidaEn !== null) return "no_encontrado";
    b.atendidaEn = new Date(this.reloj()).toISOString();
    b.atendidaPor = actorUserId;
    return "resuelto";
  }

  /** Espejo del solape usado por reservas/bloqueos, expuesto por si alguna prueba de
   * este paquete lo necesita para armar fixtures — no forma parte del contrato
   * `RentasCalendarSyncRepository`. */
  static seSolapan = seSolapan;
}

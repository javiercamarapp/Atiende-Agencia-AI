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

  /** Espejo del solape usado por reservas/bloqueos, expuesto por si alguna prueba de
   * este paquete lo necesita para armar fixtures — no forma parte del contrato
   * `RentasCalendarSyncRepository`. */
  static seSolapan = seSolapan;
}

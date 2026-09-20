// InMemoryRentasCalendarStore — implementación real (no un mock) del estado de
// `rentas.unidad`/`rentas.ocupacion`/`rentas.conflicto_calendario`/`rentas.canal`/
// `rentas.guest_minimo`, con las MISMAS restricciones de integridad que el DDL real de
// migrations/001_rentas_schema.sql (el EXCLUDE `capa='reserva' AND estado<>'cancelado'
// AND bloqueante`, el advisory lock por unidad). Es el backing store compartido por:
//  - `InMemoryRentasTenancyEngine` (in-memory-tenancy-engine.ts): expone esta forma
//    como un `TenantDbSession` real vía un dispatcher de texto SQL, para que
//    `aplicacion/reservas.ts` (que recibe un `EjecutorTransaccional` genérico, nunca
//    este store directo) pueda ejecutarse SIN CAMBIOS contra un motor que no es
//    Postgres — igual que `InMemoryHotelesRepository` respeta el mismo DDL que las
//    migraciones reales sin ser Postgres.
//  - `InMemoryRentasRepository` (in-memory-repository.ts): lee/escribe esta MISMA
//    instancia directamente (sin pasar por SQL) para findUnidad/findOcupacion/
//    insertGuestMinimo/etc — en producción ambos caminos (la transacción cruda de
//    aplicacion/reservas.ts y el repository) apuntan a las mismas tablas Postgres;
//    aquí comparten la misma instancia de este store por la misma razón.
//
// Simplificación deliberada frente a un motor SQL de propósito general (mismo criterio
// que @atiende/db::InMemoryTenancyEngine, "alcance angosto a propósito"): las
// restricciones de integridad (EXCLUDE) se verifican ANTES de mutar el mapa
// subyacente, nunca después — así, exactamente como en Postgres real, un INSERT/UPDATE
// que violaría el EXCLUDE simplemente no persiste ningún cambio, lo que hace que
// `ROLLBACK TO SAVEPOINT` no necesite deshacer nada (no hay nada que deshacer): el
// avisory lock (aquí, un mutex real por unidadId) es lo que de verdad importa
// verificar en un test de concurrencia, y sí se implementa como until real (una
// segunda adquisición espera a que la primera libere).
import { randomUUID } from "node:crypto";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { EstadoOcupacion, Razon } from "./tipos.ts";
import type {
  BloqueoRecord,
  CanalRecord,
  IncidenciaMantenimientoRecord,
  ItemInventarioRecord,
  NewGuestMinimoInput,
  OcupacionCalendarioItem,
  OcupacionParaMovimiento,
  OcupacionResumen,
  TareaListFiltro,
  TareaOperativaDetalle,
  TareaOperativaRecord,
  UnidadRecord,
} from "./types.ts";
import type { ChecklistItemTarea, EstadoIncidencia, EstadoTareaOperativa, PrioridadTareaOperativa, SeveridadIncidencia, TipoTareaOperativa } from "./limpieza/tipos.ts";

export interface StoredOcupacion {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  inicio: string;
  fin: string;
  capa: "reserva" | "bloqueo";
  razon: string;
  estado: EstadoOcupacion;
  bloqueante: boolean;
  canalOrigenId: string | null;
  externalId: string | null;
  huespedMinimoId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Fase 9 -- espejo de `rentas.ocupacion.recordatorio_checkin_enviado_en` (belt-
   *  and-suspenders sobre el dedupe_key real del outbox, ver migrations/011). */
  recordatorioCheckinEnviadoEn: string | null;
}

/** Todo lo que `InMemoryRentasRepository.findOcupacionParaCorreo` necesita, MENOS el
 *  nombre del tenant (`organization.name` no vive en este store -- lo agrega el
 *  repository, que sí guarda un mapa `organizaciones`, mismo criterio que
 *  `domain-citas::InMemoryCitasRepository.organizations`). */
export interface DatosOcupacionParaCorreo {
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly capa: "reserva" | "bloqueo";
  readonly estado: EstadoOcupacion;
  readonly rango: { readonly inicio: string; readonly fin: string };
  readonly unidadNombre: string;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
}

export interface StoredConflicto {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  ocupacionAId: string;
  ocupacionBId: string | null;
  tipo: "capa_cruzada" | "overbooking_confirmado";
  detectadoEn: string;
}

interface StoredGuestMinimo {
  id: string;
  organizationId: string;
  propertyId: string;
  nombre: string | null;
  contacto: string | null;
}

// ---------------------------------------------------------------------------
// Fase 17 -- módulo operativo de limpieza/mantenimiento (rentas.tarea_operativa/
// checklist_item_tarea/item_inventario/movimiento_inventario/
// incidencia_mantenimiento/notificacion_tarea, ver migrations/010). Comparte
// instancia con `InMemoryRentasTenancyEngine` por la MISMA razón que
// unidades/ocupaciones arriba: ../limpieza/aplicacion/tareas.ts recibe el
// `EjecutorTransaccional` del request DIRECTO (nunca pasa por este repository), así
// que las filas que crea/actualiza deben ser visibles para
// `InMemoryRentasRepository.listTareas`/`findTareaDetalle`/etc. exactamente como en
// Postgres real ambos caminos leen/escriben la misma tabla.
export interface StoredTareaOperativa {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  ocupacionUnidadId: string | null;
  tipo: TipoTareaOperativa;
  estado: EstadoTareaOperativa;
  prioridad: PrioridadTareaOperativa;
  asignadoA: string | null;
  esProveedorExterno: boolean;
  programadaPara: string;
  slaVenceEn: string | null;
  bufferOcupacionId: string | null;
  completadaEn: string | null;
  creadoEn: string;
  actualizadoEn: string;
}

export interface StoredChecklistItemTarea {
  id: string;
  tareaId: string;
  descripcion: string;
  orden: number;
  completado: boolean;
  completadoEn: string | null;
  completadoPor: string | null;
}

export interface StoredFotoChecklistItem {
  id: string;
  checklistItemId: string;
  rutaAlmacenamiento: string;
  subidaPor: string | null;
}

export interface StoredItemInventario {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  nombre: string;
  categoria: ItemInventarioRecord["categoria"];
  cantidadActual: number;
  umbralMinimo: number;
  unidadMedida: string;
}

export interface StoredMovimientoInventario {
  id: string;
  itemInventarioId: string;
  tareaId: string | null;
  cantidad: number;
  motivo: string;
  creadoEn: string;
}

export interface StoredIncidenciaMantenimiento {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  tareaOrigenId: string | null;
  severidad: SeveridadIncidencia;
  titulo: string;
  descripcion: string | null;
  estado: EstadoIncidencia;
  propuestaBloqueoInicio: string | null;
  propuestaBloqueoFin: string | null;
  bloqueoOcupacionId: string | null;
  reportadoPor: string | null;
  confirmadoPor: string | null;
  creadoEn: string;
}

export interface StoredNotificacionTarea {
  id: string;
  tareaId: string;
  evento: "asignada" | "completada";
}

/** Serializa operaciones por clave — equivalente en memoria de
 * `pg_advisory_xact_lock`. Mismo patrón que `KeyedMutex` de
 * `domain-hoteles::in-memory-repository.ts`. */
class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.chains.set(
      key,
      previous.then(() => gate),
    );
    await previous;
    return release;
  }
}

/** `true` si dos rangos semiabiertos `[inicio, fin)` se solapan — comparación de
 * strings `YYYY-MM-DD` es válida porque el formato es de ancho fijo. */
function seSolapan(aInicio: string, aFin: string, bInicio: string, bFin: string): boolean {
  return aInicio < bFin && bInicio < aFin;
}

/** Error con `.code = "23P01"` — mismo shape que un error real de `pg`/PGlite para
 * `esViolacionExclusion()` de ejecutor.ts. */
class ExclusionViolationError extends Error {
  readonly code = "23P01";
  constructor() {
    super("duplicate key value violates exclusion constraint (simulado)");
  }
}

export class InMemoryRentasCalendarStore {
  readonly unidades = new Map<string, UnidadRecord>();
  readonly canales = new Map<string, CanalRecord>();
  readonly ocupaciones = new Map<string, StoredOcupacion>();
  readonly conflictos = new Map<string, StoredConflicto>();
  readonly huespedes = new Map<string, StoredGuestMinimo>();
  readonly locks = new KeyedMutex();

  // ---- Fase 17 -- módulo operativo de limpieza/mantenimiento ----
  readonly tareas = new Map<string, StoredTareaOperativa>();
  readonly checklistItems = new Map<string, StoredChecklistItemTarea>();
  readonly fotosChecklist = new Map<string, StoredFotoChecklistItem>();
  readonly itemsInventario = new Map<string, StoredItemInventario>();
  readonly movimientosInventario = new Map<string, StoredMovimientoInventario>();
  readonly incidencias = new Map<string, StoredIncidenciaMantenimiento>();
  readonly notificacionesTarea = new Map<string, StoredNotificacionTarea>();
  /** Ronda que expuso `crearTareaLimpiezaPorCheckout`/`procesarCheckoutsPendientes`/
   *  `crearTareaOperativaManual` por HTTP (ver in-memory-tenancy-engine.ts) --
   *  `rentas.property_config.buffer_limpieza_noches`/`sla_*_horas` (migración 010).
   *  Sin fila sembrada para una property, `obtenerConfiguracion` usa
   *  `CONFIGURACION_OPERATIVA_DEFECTO`, igual que un `SELECT` sin filas en Postgres
   *  real. */
  readonly configuracionesOperativas = new Map<string, { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number }>();

  constructor() {
    // Mismo catálogo semilla que migrations/001_rentas_schema.sql.
    for (const codigo of ["airbnb", "vrbo", "booking", "manual"]) {
      const id = randomUUID();
      this.canales.set(codigo, { id, codigo });
    }
  }

  // ---- seeding ----

  seedUnidad(unidad: UnidadRecord): void {
    this.unidades.set(unidad.id, unidad);
  }

  // ---- lecturas usadas por RentasRepository ----

  findUnidad(propertyId: string, unidadId: string): UnidadRecord | null {
    const unidad = this.unidades.get(unidadId);
    if (!unidad || unidad.propertyId !== propertyId) return null;
    return unidad;
  }

  /** Fase 13 -- selector de unidad del calendario visual, ordenadas por nombre (mismo
   *  criterio de orden estable que usaría la query real `order by name`). */
  listUnidades(propertyId: string): UnidadRecord[] {
    return [...this.unidades.values()].filter((u) => u.propertyId === propertyId).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  findCanalPorCodigo(codigo: string): CanalRecord | null {
    return this.canales.get(codigo) ?? null;
  }

  findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): OcupacionResumen | null {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila || fila.propertyId !== propertyId || fila.unidadId !== unidadId) return null;
    return { id: fila.id, unidadId: fila.unidadId, capa: fila.capa, estado: fila.estado, canalOrigenId: fila.canalOrigenId };
  }

  findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): OcupacionParaMovimiento | null {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila || fila.propertyId !== propertyId) return null;
    return { id: fila.id, capa: fila.capa, canalId: fila.canalOrigenId };
  }

  /** Fase 4 -- `GET .../bloqueos`: lista bloqueos activos y cancelados de una unidad
   * (capa='bloqueo' únicamente), ordenados por fecha de inicio. */
  listBloqueos(propertyId: string, unidadId: string): BloqueoRecord[] {
    return [...this.ocupaciones.values()]
      .filter((o) => o.propertyId === propertyId && o.unidadId === unidadId && o.capa === "bloqueo")
      .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0))
      .map((o) => ({
        id: o.id,
        unidadId: o.unidadId,
        rango: { inicio: o.inicio, fin: o.fin },
        razon: o.razon as BloqueoRecord["razon"],
        estado: o.estado,
      }));
  }

  /** Fase 13 -- `GET .../ocupaciones`: TODA ocupación de la unidad (capa='reserva' Y
   *  capa='bloqueo', activa Y cancelada), ordenadas por fecha de inicio -- el listado
   *  unificado que le faltaba al calendario (a diferencia de `listBloqueos` arriba,
   *  acotado a una sola capa). */
  listOcupaciones(propertyId: string, unidadId: string): OcupacionCalendarioItem[] {
    const codigoPorCanalId = new Map([...this.canales.values()].map((c) => [c.id, c.codigo]));
    return [...this.ocupaciones.values()]
      .filter((o) => o.propertyId === propertyId && o.unidadId === unidadId)
      .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0))
      .map((o) => {
        const huesped = o.huespedMinimoId ? (this.huespedes.get(o.huespedMinimoId) ?? null) : null;
        return {
          id: o.id,
          unidadId: o.unidadId,
          capa: o.capa,
          rango: { inicio: o.inicio, fin: o.fin },
          razon: o.razon as Razon,
          estado: o.estado,
          canalCodigo: o.canalOrigenId ? (codigoPorCanalId.get(o.canalOrigenId) ?? null) : null,
          huespedNombre: huesped?.nombre ?? null,
          huespedContacto: huesped?.contacto ?? null,
          createdAt: o.createdAt,
        };
      });
  }

  insertGuestMinimo(input: NewGuestMinimoInput): { id: string } {
    const id = randomUUID();
    this.huespedes.set(id, { id, organizationId: input.organizationId, propertyId: input.propertyId, nombre: input.nombre, contacto: input.contacto });
    return { id };
  }

  attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): void {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila) throw new Error(`rentas.ocupacion ${ocupacionId} no existe`);
    if (!this.huespedes.has(guestMinimoId)) throw new Error(`rentas.guest_minimo ${guestMinimoId} no existe`);
    fila.huespedMinimoId = guestMinimoId;
  }

  // ---- primitivas de calendario, espejo de las queries reales de
  // aplicacion/reservas.ts (usadas por InMemoryRentasTenancyEngine) ----

  async acquireUnidadLock(unidadId: string): Promise<() => void> {
    return this.locks.acquire(unidadId);
  }

  getUnidadDuracionMinima(unidadId: string, propertyId: string): number | null {
    const unidad = this.unidades.get(unidadId);
    if (!unidad || unidad.propertyId !== propertyId) return null;
    return unidad.duracionMinimaNoches;
  }

  getOcupacion(ocupacionId: string): StoredOcupacion | null {
    return this.ocupaciones.get(ocupacionId) ?? null;
  }

  /** Inserta una fila `capa='reserva'` verificando el EXCLUDE ANTES de mutar
   * (`capa='reserva' AND estado<>'cancelado' AND bloqueante`) — lanza
   * `ExclusionViolationError` (`.code = "23P01"`) sin persistir nada si viola. */
  insertOcupacionReserva(input: {
    organizationId: string;
    propertyId: string;
    unidadId: string;
    inicio: string;
    fin: string;
    estado: EstadoOcupacion;
    bloqueante: boolean;
    canalOrigenId: string | null;
    externalId: string | null;
  }): { id: string } {
    if (input.bloqueante) {
      const violacion = [...this.ocupaciones.values()].some(
        (o) => o.unidadId === input.unidadId && o.capa === "reserva" && o.estado !== "cancelado" && o.bloqueante && seSolapan(o.inicio, o.fin, input.inicio, input.fin),
      );
      if (violacion) throw new ExclusionViolationError();
    }
    const id = randomUUID();
    const ahora = new Date().toISOString();
    this.ocupaciones.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      inicio: input.inicio,
      fin: input.fin,
      capa: "reserva",
      razon: "RESERVA_CANAL",
      estado: input.estado,
      bloqueante: input.bloqueante,
      canalOrigenId: input.canalOrigenId,
      externalId: input.externalId,
      huespedMinimoId: null,
      version: 1,
      createdAt: ahora,
      updatedAt: ahora,
      recordatorioCheckinEnviadoEn: null,
    });
    return { id };
  }

  insertOcupacionBloqueo(input: { organizationId: string; propertyId: string; unidadId: string; inicio: string; fin: string; razon: string }): { id: string } {
    const id = randomUUID();
    const ahora = new Date().toISOString();
    this.ocupaciones.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      inicio: input.inicio,
      fin: input.fin,
      capa: "bloqueo",
      razon: input.razon,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
      huespedMinimoId: null,
      version: 1,
      createdAt: ahora,
      updatedAt: ahora,
      recordatorioCheckinEnviadoEn: null,
    });
    return { id };
  }

  findOverlappingReservaBloqueante(unidadId: string, excludeId: string | null, inicio: string, fin: string): { id: string } | null {
    const fila = [...this.ocupaciones.values()].find(
      (o) => o.unidadId === unidadId && o.id !== excludeId && o.capa === "reserva" && o.estado !== "cancelado" && o.bloqueante && seSolapan(o.inicio, o.fin, inicio, fin),
    );
    return fila ? { id: fila.id } : null;
  }

  findOverlappingBloqueos(unidadId: string, excludeId: string, inicio: string, fin: string): { id: string }[] {
    return [...this.ocupaciones.values()]
      .filter((o) => o.unidadId === unidadId && o.id !== excludeId && o.estado !== "cancelado" && o.capa === "bloqueo" && seSolapan(o.inicio, o.fin, inicio, fin))
      .map((o) => ({ id: o.id }));
  }

  findAnyOverlapping(unidadId: string, excludeId: string, inicio: string, fin: string): { id: string }[] {
    return [...this.ocupaciones.values()]
      .filter((o) => o.unidadId === unidadId && o.id !== excludeId && o.estado !== "cancelado" && seSolapan(o.inicio, o.fin, inicio, fin))
      .map((o) => ({ id: o.id }));
  }

  insertConflicto(input: { organizationId: string; propertyId: string; unidadId: string; ocupacionAId: string; ocupacionBId: string | null; tipo: "capa_cruzada" | "overbooking_confirmado" }): {
    id: string;
  } {
    const id = randomUUID();
    this.conflictos.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      ocupacionAId: input.ocupacionAId,
      ocupacionBId: input.ocupacionBId,
      tipo: input.tipo,
      detectadoEn: new Date().toISOString(),
    });
    return { id };
  }

  marcarCancelada(ocupacionId: string): void {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila) throw new Error(`rentas.ocupacion ${ocupacionId} no existe`);
    fila.estado = "cancelado";
    fila.updatedAt = new Date().toISOString();
  }

  /** Actualiza el rango verificando el EXCLUDE antes de mutar, igual que
   * `insertOcupacionReserva`. Lanza `ExclusionViolationError` sin persistir nada si
   * el nuevo rango solaparía otra reserva bloqueante activa de la misma unidad. */
  actualizarRango(ocupacionId: string, inicio: string, fin: string): void {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila) throw new Error(`rentas.ocupacion ${ocupacionId} no existe`);
    if (fila.bloqueante && fila.estado !== "cancelado") {
      const violacion = this.findOverlappingReservaBloqueante(fila.unidadId, ocupacionId, inicio, fin) !== null;
      if (violacion) throw new ExclusionViolationError();
    }
    fila.inicio = inicio;
    fila.fin = fin;
    fila.version += 1;
    fila.updatedAt = new Date().toISOString();
  }

  // ---- Fase 9 -- correo transaccional al huésped (ver reserva-email-notifications.ts/
  // checkin-reminders.ts). El nombre del tenant NO vive aquí -- lo agrega
  // InMemoryRentasRepository.findOcupacionParaCorreo con su propio mapa
  // `organizaciones`, mismo criterio que domain-citas. ----

  findOcupacionParaCorreoDatos(organizationId: string, ocupacionId: string): DatosOcupacionParaCorreo | null {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila || fila.organizationId !== organizationId) return null;
    const unidad = this.unidades.get(fila.unidadId);
    const huesped = fila.huespedMinimoId ? (this.huespedes.get(fila.huespedMinimoId) ?? null) : null;
    return {
      ocupacionId: fila.id,
      propertyId: fila.propertyId,
      organizationId: fila.organizationId,
      capa: fila.capa,
      estado: fila.estado,
      rango: { inicio: fila.inicio, fin: fila.fin },
      unidadNombre: unidad?.name ?? "tu alojamiento",
      huespedNombre: huesped?.nombre ?? null,
      huespedContacto: huesped?.contacto ?? null,
    };
  }

  /** Reservas directas confirmadas cuyo check-in cae en `[desdeFecha, hastaFecha]`
   *  (ambos extremos inclusivos) y que todavía no recibieron el recordatorio -- mismo
   *  filtro que `rentas.claim_email_outbox_batch`/`listReservasProximasACheckIn` real
   *  (ver migrations/011). */
  listReservasProximasACheckIn(desdeFecha: string, hastaFecha: string): { id: string; organizationId: string }[] {
    return [...this.ocupaciones.values()]
      .filter((o) => o.capa === "reserva" && o.estado === "confirmado" && o.recordatorioCheckinEnviadoEn === null && o.inicio >= desdeFecha && o.inicio <= hastaFecha)
      .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0))
      .map((o) => ({ id: o.id, organizationId: o.organizationId }));
  }

  marcarRecordatorioCheckInEnviado(ocupacionId: string, enviadoEnIso: string): void {
    const fila = this.ocupaciones.get(ocupacionId);
    if (!fila) throw new Error(`rentas.ocupacion ${ocupacionId} no existe`);
    fila.recordatorioCheckinEnviadoEn = enviadoEnIso;
  }

  // ---------------------------------------------------------------------------
  // Fase 17 -- módulo operativo de limpieza/mantenimiento. `seedTareaOperativa`/
  // `seedItemInventario` son las únicas escrituras de este bloque pensadas para
  // TESTS (mismo rol que `seedUnidad` arriba) -- en producción una tarea real nace
  // de `crearTareaLimpiezaPorCheckout` (Fase 8, fuera de alcance de esta fase, ver
  // README de este paquete) y un item de inventario, de un endpoint de catálogo que
  // tampoco existe todavía (mismo "Fuera de fase" documentado). Todo lo demás de
  // este bloque son las primitivas que `InMemoryRentasTenancyEngine` despacha desde
  // el texto SQL literal de ../limpieza/aplicacion/tareas.ts (asignarTarea/
  // completarChecklistItem/completarTarea/registrarIncidencia) y las lecturas que
  // usa `InMemoryRentasRepository` (listTareas/findTareaDetalle/etc).
  // ---------------------------------------------------------------------------

  /** Siembra una tarea operativa + su checklist para tests -- salta a propósito toda
   *  la orquestación de `crearTareaLimpiezaPorCheckout` (buffer de calendario,
   *  property_config, plantilla de checklist por tipo) porque los tests de este
   *  módulo solo necesitan una fila `tarea_operativa` ya existente sobre la que
   *  ejercitar asignar/completar checklist/completar/reportar incidencia. */
  seedTareaOperativa(input: {
    organizationId: string;
    propertyId: string;
    unidadId: string;
    tipo?: TipoTareaOperativa;
    estado?: EstadoTareaOperativa;
    prioridad?: PrioridadTareaOperativa;
    asignadoA?: string | null;
    esProveedorExterno?: boolean;
    programadaPara: string;
    slaVenceEn?: string | null;
    checklist?: readonly string[];
  }): StoredTareaOperativa {
    const id = randomUUID();
    const ahora = new Date().toISOString();
    const fila: StoredTareaOperativa = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      ocupacionUnidadId: null,
      tipo: input.tipo ?? "limpieza",
      estado: input.estado ?? "pendiente",
      prioridad: input.prioridad ?? "media",
      asignadoA: input.asignadoA ?? null,
      esProveedorExterno: input.esProveedorExterno ?? false,
      programadaPara: input.programadaPara,
      slaVenceEn: input.slaVenceEn ?? null,
      bufferOcupacionId: null,
      completadaEn: null,
      creadoEn: ahora,
      actualizadoEn: ahora,
    };
    this.tareas.set(id, fila);
    (input.checklist ?? []).forEach((descripcion, orden) => {
      const itemId = randomUUID();
      this.checklistItems.set(itemId, { id: itemId, tareaId: id, descripcion, orden, completado: false, completadoEn: null, completadoPor: null });
    });
    return fila;
  }

  /** Siembra un ítem de inventario de una unidad para tests -- ver comentario de
   *  `seedTareaOperativa` arriba. */
  seedItemInventario(input: {
    organizationId: string;
    propertyId: string;
    unidadId: string;
    nombre: string;
    categoria: ItemInventarioRecord["categoria"];
    cantidadActual: number;
    umbralMinimo: number;
    unidadMedida?: string;
  }): StoredItemInventario {
    const id = randomUUID();
    const fila: StoredItemInventario = {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      nombre: input.nombre,
      categoria: input.categoria,
      cantidadActual: input.cantidadActual,
      umbralMinimo: input.umbralMinimo,
      unidadMedida: input.unidadMedida ?? "unidad",
    };
    this.itemsInventario.set(id, fila);
    return fila;
  }

  /** `SELECT organization_id, property_id FROM rentas.unidad WHERE id = $1` --
   *  a diferencia de `findUnidad` (que exige conocer ya el `propertyId`), esta
   *  primitiva resuelve la unidad a partir SOLO de su id (usada por
   *  `obtenerConfiguracion`/`registrarIncidencia` de aplicacion/tareas.ts). */
  getUnidadById(unidadId: string): UnidadRecord | null {
    return this.unidades.get(unidadId) ?? null;
  }

  /** Siembra `rentas.property_config.buffer_limpieza_noches`/`sla_*_horas` para
   *  tests -- ver comentario de `configuracionesOperativas` arriba. */
  seedConfiguracionOperativa(propertyId: string, config: { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number }): void {
    this.configuracionesOperativas.set(propertyId, config);
  }

  /** `SELECT buffer_limpieza_noches, sla_limpieza_horas, sla_mantenimiento_horas
   *  FROM rentas.property_config WHERE property_id = $1` (obtenerConfiguracion). */
  getConfiguracionOperativa(propertyId: string): { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number } | null {
    return this.configuracionesOperativas.get(propertyId) ?? null;
  }

  /** `INSERT INTO rentas.tarea_operativa (...)` real -- a diferencia de
   *  `seedTareaOperativa` (atajo de test que salta toda la orquestación), esta es la
   *  primitiva que `crearTareaLimpiezaPorCheckout`/`crearTareaOperativaManual`
   *  disparan de verdad. `ocupacionUnidadId: null` para una tarea manual (H-049
   *  desviación, ver migración 010: "NULL para tareas creadas manualmente
   *  (mantenimiento/inspección ad-hoc)"). Siempre nace `estado: 'pendiente'` y
   *  `bufferOcupacionId: null` -- el caller vincula el buffer aparte, ver
   *  `actualizarBufferOcupacionTarea`. */
  insertTareaOperativa(input: {
    organizationId: string;
    propertyId: string;
    unidadId: string;
    ocupacionUnidadId: string | null;
    tipo: TipoTareaOperativa;
    prioridad: PrioridadTareaOperativa;
    programadaPara: string;
    slaVenceEn: string | null;
  }): { id: string } {
    const id = randomUUID();
    const ahora = new Date().toISOString();
    this.tareas.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      ocupacionUnidadId: input.ocupacionUnidadId,
      tipo: input.tipo,
      estado: "pendiente",
      prioridad: input.prioridad,
      asignadoA: null,
      esProveedorExterno: false,
      programadaPara: input.programadaPara,
      slaVenceEn: input.slaVenceEn,
      bufferOcupacionId: null,
      completadaEn: null,
      creadoEn: ahora,
      actualizadoEn: ahora,
    });
    return { id };
  }

  /** `INSERT INTO rentas.checklist_item_tarea (tarea_id, descripcion, orden)` real --
   *  disparada una vez por ítem de plantilla por `insertarChecklistPlantilla` de
   *  aplicacion/tareas.ts (a diferencia de `seedTareaOperativa`, que siembra su
   *  propio checklist de una vez para tests). */
  insertChecklistItemTarea(tareaId: string, descripcion: string, orden: number): void {
    const id = randomUUID();
    this.checklistItems.set(id, { id, tareaId, descripcion, orden, completado: false, completadoEn: null, completadoPor: null });
  }

  /** `UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE id = $2` --
   *  vincula (o desvincula, `null`) el bloqueo `BUFFER_LIMPIEZA` de calendario que
   *  `crearTareaLimpiezaPorCheckout`/`reprogramarTareaPorCambioReserva` crean aparte
   *  (después del COMMIT de la tarea, ver comentario de cabecera de
   *  aplicacion/tareas.ts). */
  actualizarBufferOcupacionTarea(tareaId: string, bufferOcupacionId: string | null): void {
    const fila = this.tareas.get(tareaId);
    if (fila) {
      fila.bufferOcupacionId = bufferOcupacionId;
      fila.actualizadoEn = new Date().toISOString();
    }
  }

  /** `procesarCheckoutsPendientes` (H-049 desviación, ver comentario de cabecera de
   *  aplicacion/tareas.ts, punto 5): reservas confirmadas y bloqueantes cuyo checkout
   *  (`upper(rango)`) ya llegó y que todavía no tienen ninguna tarea `tipo='limpieza'`
   *  vinculada por `ocupacion_unidad_id` -- idempotente por construcción (una
   *  reserva con tarea ya creada nunca vuelve a aparecer aquí). */
  // Paridad con `PostgresRentasRepository`/`procesarCheckoutsPendientes` (ver su
  // comentario de cabecera): el default de "hoy" es el día de NEGOCIO
  // (`hoyFechaNegocio()`), nunca el día UTC crudo del proceso -- este store respalda
  // el `TenantDbSession` real de `InMemoryRentasTenancyEngine`, que SÍ recibe el
  // `asOfDate` ya resuelto como parámetro (`$2`) en producción; el default de aquí
  // solo cubre un caller directo de este store que lo omitiera.
  findOcupacionesCheckoutPendientes(limite: number, hoyIso: string = hoyFechaNegocio()): { ocupacionId: string; unidadId: string; fin: string }[] {
    return [...this.ocupaciones.values()]
      .filter((o) => o.capa === "reserva" && o.estado === "confirmado" && o.bloqueante && o.fin <= hoyIso)
      .filter((o) => ![...this.tareas.values()].some((t) => t.tipo === "limpieza" && t.ocupacionUnidadId === o.id))
      .sort((a, b) => (a.fin < b.fin ? -1 : a.fin > b.fin ? 1 : 0))
      .slice(0, limite)
      .map((o) => ({ ocupacionId: o.id, unidadId: o.unidadId, fin: o.fin }));
  }

  getTareaOperativa(tareaId: string): StoredTareaOperativa | null {
    return this.tareas.get(tareaId) ?? null;
  }

  /** `GET .../tareas`: tareas de una property, opcionalmente filtradas por
   *  asignación (`asignadoA: null` = solo sin asignar, ausente = sin filtro) y/o
   *  estado -- ver types.ts::TareaListFiltro. */
  listTareas(propertyId: string, filtro: TareaListFiltro = {}): TareaOperativaRecord[] {
    const filtraAsignacion = Object.prototype.hasOwnProperty.call(filtro, "asignadoA");
    return [...this.tareas.values()]
      .filter((t) => t.propertyId === propertyId)
      .filter((t) => !filtraAsignacion || t.asignadoA === (filtro.asignadoA ?? null))
      .filter((t) => !filtro.estados || filtro.estados.includes(t.estado))
      .sort((a, b) => (a.programadaPara < b.programadaPara ? -1 : a.programadaPara > b.programadaPara ? 1 : a.creadoEn < b.creadoEn ? -1 : 1))
      .map((t) => this.tareaToRecord(t));
  }

  findTareaDetalle(propertyId: string, tareaId: string): TareaOperativaDetalle | null {
    const fila = this.tareas.get(tareaId);
    if (!fila || fila.propertyId !== propertyId) return null;
    return { ...this.tareaToRecord(fila), checklist: this.listChecklistPorTarea(tareaId) };
  }

  private tareaToRecord(t: StoredTareaOperativa): TareaOperativaRecord {
    const unidad = this.unidades.get(t.unidadId);
    return {
      id: t.id,
      propertyId: t.propertyId,
      unidadId: t.unidadId,
      unidadNombre: unidad?.name ?? t.unidadId,
      tipo: t.tipo,
      estado: t.estado,
      prioridad: t.prioridad,
      asignadoA: t.asignadoA,
      esProveedorExterno: t.esProveedorExterno,
      programadaPara: t.programadaPara,
      slaVenceEn: t.slaVenceEn,
      completadaEn: t.completadaEn,
      creadoEn: t.creadoEn,
    };
  }

  listChecklistPorTarea(tareaId: string): ChecklistItemTarea[] {
    return [...this.checklistItems.values()]
      .filter((c) => c.tareaId === tareaId)
      .sort((a, b) => a.orden - b.orden)
      .map((c) => ({ id: c.id, tareaId: c.tareaId, descripcion: c.descripcion, orden: c.orden, completado: c.completado, completadoEn: c.completadoEn, completadoPor: c.completadoPor }));
  }

  findChecklistItem(propertyId: string, tareaId: string, itemId: string): { id: string } | null {
    const item = this.checklistItems.get(itemId);
    if (!item || item.tareaId !== tareaId) return null;
    const tarea = this.tareas.get(tareaId);
    if (!tarea || tarea.propertyId !== propertyId) return null;
    return { id: item.id };
  }

  // ---- primitivas despachadas por InMemoryRentasTenancyEngine (texto SQL literal
  // de ../limpieza/aplicacion/tareas.ts) ----

  asignarTareaOperativa(tareaId: string, asignadoA: string, esProveedorExterno: boolean): { id: string } | null {
    const fila = this.tareas.get(tareaId);
    if (!fila) return null;
    fila.asignadoA = asignadoA;
    fila.esProveedorExterno = esProveedorExterno;
    if (fila.estado === "pendiente") fila.estado = "asignada";
    fila.actualizadoEn = new Date().toISOString();
    return { id: tareaId };
  }

  insertNotificacionTarea(tareaId: string, evento: "asignada" | "completada"): void {
    const id = randomUUID();
    this.notificacionesTarea.set(id, { id, tareaId, evento });
  }

  completarChecklistItemTarea(checklistItemId: string, completadoPor: string): { id: string } | null {
    const item = this.checklistItems.get(checklistItemId);
    if (!item) return null;
    item.completado = true;
    item.completadoEn = new Date().toISOString();
    item.completadoPor = completadoPor;
    return { id: checklistItemId };
  }

  insertFotoChecklistItem(checklistItemId: string, rutaAlmacenamiento: string, subidaPor: string | null): void {
    const id = randomUUID();
    this.fotosChecklist.set(id, { id, checklistItemId, rutaAlmacenamiento, subidaPor });
  }

  listChecklistCompletadoPorTarea(tareaId: string): { completado: boolean }[] {
    return [...this.checklistItems.values()].filter((c) => c.tareaId === tareaId).map((c) => ({ completado: c.completado }));
  }

  marcarTareaBloqueada(tareaId: string): void {
    const fila = this.tareas.get(tareaId);
    if (fila) {
      fila.estado = "bloqueada";
      fila.actualizadoEn = new Date().toISOString();
    }
  }

  marcarTareaCompletada(tareaId: string): void {
    const fila = this.tareas.get(tareaId);
    if (fila) {
      fila.estado = "completada";
      fila.completadaEn = new Date().toISOString();
      fila.actualizadoEn = new Date().toISOString();
    }
  }

  getItemInventario(id: string): StoredItemInventario | null {
    return this.itemsInventario.get(id) ?? null;
  }

  actualizarCantidadInventario(id: string, cantidadNueva: number): void {
    const fila = this.itemsInventario.get(id);
    if (fila) fila.cantidadActual = cantidadNueva;
  }

  insertMovimientoInventario(itemInventarioId: string, tareaId: string | null, cantidad: number, motivo: string): void {
    const id = randomUUID();
    this.movimientosInventario.set(id, { id, itemInventarioId, tareaId, cantidad, motivo, creadoEn: new Date().toISOString() });
  }

  listItemsInventario(propertyId: string, unidadId: string): ItemInventarioRecord[] {
    return [...this.itemsInventario.values()]
      .filter((i) => i.propertyId === propertyId && i.unidadId === unidadId)
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((i) => ({ id: i.id, unidadId: i.unidadId, nombre: i.nombre, categoria: i.categoria, cantidadActual: i.cantidadActual, umbralMinimo: i.umbralMinimo, unidadMedida: i.unidadMedida }));
  }

  insertIncidenciaMantenimiento(input: {
    organizationId: string;
    propertyId: string;
    unidadId: string;
    tareaOrigenId: string | null;
    severidad: SeveridadIncidencia;
    titulo: string;
    descripcion: string | null;
    reportadoPor: string;
    estado: EstadoIncidencia;
    propuestaBloqueoInicio: string | null;
    propuestaBloqueoFin: string | null;
  }): { id: string } {
    const id = randomUUID();
    this.incidencias.set(id, {
      id,
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      unidadId: input.unidadId,
      tareaOrigenId: input.tareaOrigenId,
      severidad: input.severidad,
      titulo: input.titulo,
      descripcion: input.descripcion,
      estado: input.estado,
      propuestaBloqueoInicio: input.propuestaBloqueoInicio,
      propuestaBloqueoFin: input.propuestaBloqueoFin,
      bloqueoOcupacionId: null,
      reportadoPor: input.reportadoPor,
      confirmadoPor: null,
      creadoEn: new Date().toISOString(),
    });
    return { id };
  }

  listIncidencias(propertyId: string, unidadId: string): IncidenciaMantenimientoRecord[] {
    return [...this.incidencias.values()]
      .filter((i) => i.propertyId === propertyId && i.unidadId === unidadId)
      .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1))
      .map((i) => ({
        id: i.id,
        propertyId: i.propertyId,
        unidadId: i.unidadId,
        tareaOrigenId: i.tareaOrigenId,
        severidad: i.severidad,
        titulo: i.titulo,
        descripcion: i.descripcion,
        estado: i.estado,
        propuestaBloqueoRango: i.propuestaBloqueoInicio && i.propuestaBloqueoFin ? { inicio: i.propuestaBloqueoInicio, fin: i.propuestaBloqueoFin } : null,
        reportadoPor: i.reportadoPor,
        creadoEn: i.creadoEn,
      }));
  }
}

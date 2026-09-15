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
import type { EstadoOcupacion, Razon } from "./tipos.ts";
import type { BloqueoRecord, CanalRecord, NewGuestMinimoInput, OcupacionCalendarioItem, OcupacionParaMovimiento, OcupacionResumen, UnidadRecord } from "./types.ts";

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
}

// InMemoryRentasTenancyEngine — implementación real (no un mock) de
// `@atiende/core-tenancy::TenancyEngine`/`TenantDbSession`, ESPECÍFICA de rentas: a
// diferencia de `@atiende/db::InMemoryTenancyEngine` (alcance angosto a propósito,
// solo entiende el join `core.membership`/`core.property` que usa
// `requirePropertyMembership`), esta también entiende el texto SQL literal de
// `aplicacion/reservas.ts` — necesario porque el flujo 1 (reservas) es el ÚNICO de los
// tres elegidos en Fase 1 donde la ruta HTTP pasa el `TenantDbSession` del request
// DIRECTO a una función de dominio que gestiona su propia transacción
// (BEGIN/SAVEPOINT/COMMIT), en vez de pasar por `RentasRepository` (ver el comentario
// de cabecera de repository.ts).
//
// El dispatcher de texto es "alcance angosto a propósito" del mismo tipo que
// `@atiende/db::InMemoryTenancyEngine`: reconoce EXACTAMENTE las queries que emite
// `aplicacion/reservas.ts` (ver ese archivo) y el join de membership — no es un motor
// SQL de propósito general. Toda la lógica de invariantes reales (EXCLUDE, advisory
// lock) vive en `InMemoryRentasCalendarStore`, compartida con `InMemoryRentasRepository`
// para que un `ocupacionId` creado por la transacción cruda sea visible para
// `attachGuestToOcupacion`/`findOcupacionParaMovimiento` del repository, exactamente
// como en Postgres real ambos caminos leen/escriben la misma tabla.
import type { PlatformRole, TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRentasCalendarStore } from "./calendar-store.ts";
import type { EstadoIncidencia, PrioridadTareaOperativa, SeveridadIncidencia, TipoTareaOperativa } from "./limpieza/tipos.ts";

export interface SeedTenancyProperty {
  readonly id: string;
  readonly organizationId: string;
}

export interface SeedTenancyMembership {
  readonly userId: string;
  readonly organizationId: string;
  readonly propertyIds: readonly string[] | null;
  readonly platformRole: PlatformRole;
  readonly verticalRole: string;
  /** `core.staff_user.full_name`, solo para `rentas.listar_asignables_limpieza`; sin el, se usa el id. */
  readonly fullName?: string;
}

interface MembershipQueryRow {
  organization_id: string;
  platform_role: PlatformRole;
  vertical_role: string;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Roles que `rentas.es_miembro_operativo_limpieza` (migracion 033) acepta como responsable/asignado de una tarea. */
const ROLES_OPERATIVOS_LIMPIEZA: readonly string[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "limpieza"];

export class InMemoryRentasTenancyEngine implements TenancyEngine {
  private readonly properties = new Map<string, SeedTenancyProperty>();
  private readonly memberships: SeedTenancyMembership[] = [];

  constructor(readonly calendarStore: InMemoryRentasCalendarStore = new InMemoryRentasCalendarStore()) {}

  seedProperty(property: SeedTenancyProperty): void {
    this.properties.set(property.id, property);
  }

  seedMembership(membership: SeedTenancyMembership): void {
    this.memberships.push(membership);
  }

  async withAppSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
    // Locks adquiridos durante ESTA sesión (la transacción EXTERNA de la request,
    // ver managed-postgres-engine.ts::withAppSession) — el advisory lock real es
    // xact-scoped (se libera automáticamente al terminar la transacción EXTERNA,
    // nunca antes), así que aquí solo se libera en el `finally` de abajo, una vez por
    // clave (ver `heldKeys`), nunca desde `exec()`.
    const heldLocks: Array<() => void> = [];
    // `pg_advisory_xact_lock` es reentrante DENTRO de la misma sesión/transacción
    // real: Postgres documenta que una sesión que ya sostiene un advisory lock puede
    // volver a pedirlo sin bloquearse contra sí misma (a diferencia de dos sesiones
    // distintas). Varias funciones de aplicación (crearReservaConfirmada,
    // modificarFechasReserva, crearBloqueo, crearTareaLimpiezaPorCheckout, …) piden el
    // MISMO advisory lock de `unidad_id` en SUB-transacciones (SAVEPOINT) distintas
    // pero dentro de la MISMA sesión real — sin esta reentrancia, la segunda petición
    // se pondría en la cola de `KeyedMutex` detrás de sí misma y nunca se
    // resolvería (deadlock del propio test/request).
    const heldKeys = new Set<string>();

    const releaseAllLocks = () => {
      while (heldLocks.length > 0) heldLocks.pop()!();
      heldKeys.clear();
    };

    const store = this.calendarStore;

    const session: TenantDbSession = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const n = normalize(sql);

        // ---- join de membership (requirePropertyMembership) ----
        if (n.includes("from core.membership") && n.includes("join core.property")) {
          const propertyId = params[0] as string | undefined;
          if (!propertyId) return { rows: [] };
          const property = this.properties.get(propertyId);
          if (!property || claims.userId == null) return { rows: [] };
          const rows: MembershipQueryRow[] = this.memberships
            .filter((m) => m.userId === claims.userId && m.organizationId === property.organizationId && (m.propertyIds === null || m.propertyIds.includes(propertyId)))
            .map((m) => ({ organization_id: m.organizationId, platform_role: m.platformRole, vertical_role: m.verticalRole }));
          return { rows: rows as unknown as R[] };
        }

        // ---- pg_advisory_xact_lock (bloquearUnidadEnTransaccion Y
        // bloquearOwnerStatementEnTransaccion emiten el mismo texto SQL, distintas
        // claves de negocio -- ambas pasan por aquí indistintamente) ----
        if (n.startsWith("select pg_advisory_xact_lock")) {
          const key = params[0] as string;
          // Reentrante por sesión (ver comentario de `heldKeys` arriba): si ESTA
          // sesión ya sostiene el lock de `key`, Postgres real lo concede de
          // inmediato sin volver a encolarse.
          if (!heldKeys.has(key)) {
            const release = await store.acquireUnidadLock(key);
            heldLocks.push(release);
            heldKeys.add(key);
          }
          return { rows: [] as R[] };
        }

        // ---- SELECT duracion_minima_noches FROM rentas.unidad ----
        if (n.includes("select duracion_minima_noches from rentas.unidad")) {
          const [unidadId, propertyId] = params as [string, string];
          const duracion = store.getUnidadDuracionMinima(unidadId, propertyId);
          if (duracion === null) return { rows: [] as R[] };
          return { rows: [{ duracion_minima_noches: duracion }] as unknown as R[] };
        }

        // ---- INSERT INTO rentas.ocupacion (... capa='reserva' ...) ----
        if (n.includes("insert into rentas.ocupacion") && n.includes("'reserva'")) {
          if (n.includes("'conflicto_pendiente', false")) {
            const [organizationId, propertyId, unidadId, inicio, fin, canalOrigenId, externalId] = params as [string, string, string, string, string, string | null, string | null];
            const { id } = store.insertOcupacionReserva({
              organizationId,
              propertyId,
              unidadId,
              inicio,
              fin,
              estado: "conflicto_pendiente",
              bloqueante: false,
              canalOrigenId: canalOrigenId ?? null,
              externalId: externalId ?? null,
            });
            return { rows: [{ id }] as unknown as R[] };
          }
          const [organizationId, propertyId, unidadId, inicio, fin, estado, bloqueante, canalOrigenId, externalId] = params as [
            string,
            string,
            string,
            string,
            string,
            "confirmado" | "provisional",
            boolean,
            string | null,
            string | null,
          ];
          const { id } = store.insertOcupacionReserva({ organizationId, propertyId, unidadId, inicio, fin, estado, bloqueante, canalOrigenId: canalOrigenId ?? null, externalId: externalId ?? null });
          return { rows: [{ id }] as unknown as R[] };
        }

        // ---- INSERT INTO rentas.ocupacion (... capa='bloqueo' ...) — crearBloqueo,
        // fuera de fase por HTTP pero conservado para tests del motor puro. ----
        if (n.includes("insert into rentas.ocupacion") && n.includes("'bloqueo'")) {
          const [organizationId, propertyId, unidadId, inicio, fin, razon] = params as [string, string, string, string, string, string];
          const { id } = store.insertOcupacionBloqueo({ organizationId, propertyId, unidadId, inicio, fin, razon });
          return { rows: [{ id }] as unknown as R[] };
        }

        // ---- SELECT id FROM rentas.ocupacion ... overlapping ----
        if (n.startsWith("select id from rentas.ocupacion")) {
          if (n.includes("capa = 'bloqueo'")) {
            // detectarYRegistrarConflictosCapaCruzada: WHERE unidad_id=$1 AND id<>$2 AND ... rango && daterange($3,$4,...)
            const [unidadId, excludeId, inicio, fin] = params as [string, string, string, string];
            const rows = store.findOverlappingBloqueos(unidadId, excludeId, inicio, fin);
            return { rows: rows as unknown as R[] };
          }
          if (n.includes("capa = 'reserva'") && n.includes("bloqueante")) {
            if (n.includes("id <> $2")) {
              // modificarFechasReserva: WHERE unidad_id=$1 AND id<>$2 AND capa='reserva' ...
              const [unidadId, excludeId, inicio, fin] = params as [string, string, string, string];
              const fila = store.findOverlappingReservaBloqueante(unidadId, excludeId, inicio, fin);
              return { rows: (fila ? [fila] : []) as unknown as R[] };
            }
            // crearReservaConfirmada: WHERE unidad_id=$1 AND capa='reserva' ... (sin excludeId, fila nueva aún sin id)
            const [unidadId, inicio, fin] = params as [string, string, string];
            const fila = store.findOverlappingReservaBloqueante(unidadId, null, inicio, fin);
            return { rows: (fila ? [fila] : []) as unknown as R[] };
          }
          // crearBloqueo: WHERE unidad_id=$1 AND id<>$2 AND estado<>'cancelado' AND rango && ... (sin filtro de capa)
          const [unidadId, excludeId, inicio, fin] = params as [string, string, string, string];
          const rows = store.findAnyOverlapping(unidadId, excludeId, inicio, fin);
          return { rows: rows as unknown as R[] };
        }

        // ---- SELECT unidad_id, organization_id, property_id FROM rentas.ocupacion WHERE id = $1 ----
        if (n.startsWith("select unidad_id, organization_id, property_id from rentas.ocupacion")) {
          const [id] = params as [string];
          const fila = store.getOcupacion(id);
          if (!fila) return { rows: [] as R[] };
          return { rows: [{ unidad_id: fila.unidadId, organization_id: fila.organizationId, property_id: fila.propertyId }] as unknown as R[] };
        }

        // ---- SELECT lower(rango)::text AS inicio, upper(rango)::text AS fin, capa FROM rentas.ocupacion WHERE id = $1 FOR UPDATE ----
        if (n.includes("lower(rango)") && n.includes("upper(rango)")) {
          const [id] = params as [string];
          const fila = store.getOcupacion(id);
          if (!fila) return { rows: [] as R[] };
          return { rows: [{ inicio: fila.inicio, fin: fila.fin, capa: fila.capa }] as unknown as R[] };
        }

        // ---- SELECT estado FROM rentas.ocupacion WHERE id = $1 FOR UPDATE ----
        if (n.startsWith("select estado from rentas.ocupacion")) {
          const [id] = params as [string];
          const fila = store.getOcupacion(id);
          if (!fila) return { rows: [] as R[] };
          return { rows: [{ estado: fila.estado }] as unknown as R[] };
        }

        // ---- INSERT INTO rentas.conflicto_calendario ----
        if (n.startsWith("insert into rentas.conflicto_calendario")) {
          const [organizationId, propertyId, unidadId, ocupacionAId, ocupacionBId] = params as [string, string, string, string, string | null];
          const tipo = n.includes("'overbooking_confirmado'") ? ("overbooking_confirmado" as const) : ("capa_cruzada" as const);
          const { id } = store.insertConflicto({ organizationId, propertyId, unidadId, ocupacionAId, ocupacionBId: ocupacionBId ?? null, tipo });
          return { rows: [{ id }] as unknown as R[] };
        }

        // ---- UPDATE rentas.ocupacion (emitido vía query(), no exec() — mismo
        // criterio que un `UPDATE ... RETURNING` real, aquí sin RETURNING pero
        // igual de válido pasar por query() en vez de exec()) ----
        if (n.startsWith("update rentas.ocupacion set estado = 'cancelado'")) {
          const [id] = params as [string];
          store.marcarCancelada(id);
          return { rows: [] as R[] };
        }
        if (n.startsWith("update rentas.ocupacion set rango =")) {
          const [id, inicio, fin] = params as [string, string, string];
          store.actualizarRango(id, inicio, fin);
          return { rows: [] as R[] };
        }

        // -------------------------------------------------------------------
        // Fase 17 -- módulo operativo de limpieza/mantenimiento (texto SQL literal
        // emitido por ../limpieza/aplicacion/tareas.ts: asignarTarea/
        // completarChecklistItem/completarTarea/registrarIncidencia -- las 4
        // funciones que apps/api/.../rentas/limpieza.ts invoca con el
        // `TenantDbSession` del request DIRECTO, mismo patrón que
        // crearBloqueo/cancelarOcupacion arriba), MÁS `crearTareaLimpiezaPorCheckout`/
        // `barrerLimpiezaPendiente`/`crearTareaOperativaManual` (ronda que agregó
        // apps/api/.../rentas/checkout-sweep-cron.ts y el POST manual de
        // limpieza.ts) y, desde paridad3, el ciclo de la tarea ligada a la reserva
        // (`crearTareaLimpiezaAlConfirmar`/`reprogramarTareaPorCambioReserva`/
        // `cancelarTareaPorCancelacionReserva`, invocadas por `crearReservaConfirmada`/
        // `modificarFechasReserva`/`cancelarOcupacion`). Los tests que solo
        // necesitan una tarea/inventario ya existente pueden seguir sembrándola
        // directo con `store.seedTareaOperativa`/`store.seedItemInventario`.
        // -------------------------------------------------------------------

        // ---- SELECT organization_id, property_id FROM rentas.unidad WHERE id = $1
        // (registrarIncidencia / obtenerConfiguracion) ----
        if (n.startsWith("select organization_id, property_id from rentas.unidad")) {
          const [unidadId] = params as [string];
          const unidad = store.getUnidadById(unidadId);
          if (!unidad) return { rows: [] as R[] };
          return { rows: [{ organization_id: unidad.organizationId, property_id: unidad.propertyId }] as unknown as R[] };
        }

        // ---- SELECT buffer_limpieza_noches, sla_limpieza_horas,
        // sla_mantenimiento_horas FROM rentas.property_config WHERE property_id = $1
        // (obtenerConfiguracion) ----
        if (n.startsWith("select buffer_limpieza_noches")) {
          const [propertyId] = params as [string];
          const config = store.getConfiguracionOperativa(propertyId);
          if (!config) return { rows: [] as R[] };
          return { rows: [{ buffer_limpieza_noches: config.bufferLimpiezaNoches, sla_limpieza_horas: config.slaLimpiezaHoras, sla_mantenimiento_horas: config.slaMantenimientoHoras }] as unknown as R[] };
        }

        // ---- INSERT INTO rentas.tarea_operativa (...) RETURNING id -- creación real,
        // DOS variantes distinguidas por texto literal: `crearTareaLimpiezaPorCheckout`
        // fija `tipo='limpieza'`/`estado='pendiente'` como literales SQL (params:
        // organizationId, propertyId, unidadId, ocupacionUnidadId, prioridad,
        // programadaPara, slaVenceEn); `crearTareaOperativaManual` fija
        // `ocupacion_unidad_id=NULL`/`estado='pendiente'` como literales y parametriza
        // `tipo` (params: organizationId, propertyId, unidadId, tipo, prioridad,
        // programadaPara, slaVenceEn). ----
        if (n.startsWith("insert into rentas.tarea_operativa") && n.includes("returning id")) {
          if (n.includes("'limpieza', 'pendiente'")) {
            const [organizationId, propertyId, unidadId, ocupacionUnidadId, prioridad, programadaPara, slaVenceEn] = params as [string, string, string, string, PrioridadTareaOperativa, string, string | null];
            const { id } = store.insertTareaOperativa({ organizationId, propertyId, unidadId, ocupacionUnidadId, tipo: "limpieza", prioridad, programadaPara, slaVenceEn });
            return { rows: [{ id }] as unknown as R[] };
          }
          const [organizationId, propertyId, unidadId, tipo, prioridad, programadaPara, slaVenceEn] = params as [string, string, string, TipoTareaOperativa, PrioridadTareaOperativa, string, string | null];
          const { id } = store.insertTareaOperativa({ organizationId, propertyId, unidadId, ocupacionUnidadId: null, tipo, prioridad, programadaPara, slaVenceEn });
          return { rows: [{ id }] as unknown as R[] };
        }

        // ---- INSERT INTO rentas.checklist_item_tarea (tarea_id, descripcion, orden)
        // -- plantilla real, `insertarChecklistPlantilla` (una fila por ítem, sin
        // RETURNING) -- distinta de la fila UPDATE .../completarChecklistItem de
        // abajo. ----
        if (n.startsWith("insert into rentas.checklist_item_tarea")) {
          const [tareaId, descripcion, orden] = params as [string, string, number];
          store.insertChecklistItemTarea(tareaId, descripcion, orden);
          return { rows: [] as R[] };
        }

        // ---- UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE
        // id = $2 (crearTareaLimpiezaPorCheckout, tras crear el buffer aparte) ----
        if (n.startsWith("update rentas.tarea_operativa set buffer_ocupacion_id = null")) {
          const [tareaId] = params as [string];
          store.actualizarBufferOcupacionTarea(tareaId, null);
          return { rows: [] as R[] };
        }
        if (n.startsWith("update rentas.tarea_operativa set buffer_ocupacion_id")) {
          const [bufferOcupacionId, tareaId] = params as [string | null, string];
          store.actualizarBufferOcupacionTarea(tareaId, bufferOcupacionId);
          return { rows: [] as R[] };
        }

        // ---- ciclo de la tarea ligada a la reserva (ganchos de crearReservaConfirmada/modificarFechasReserva/
        // cancelarOcupacion) ----
        // Idempotencia de crearTareaLimpiezaPorCheckout: tarea de limpieza (cualquier estado) de una reserva.
        if (n.startsWith("select id, asignado_a from rentas.tarea_operativa where tipo = 'limpieza'")) {
          const [ocupacionId] = params as [string];
          const fila = store.findTareaLimpiezaPorOcupacion(ocupacionId);
          return { rows: (fila ? [fila] : []) as unknown as R[] };
        }
        // Responsable por omision vigente (funcion definer de la migracion 033): el default de la unidad solo vale mientras
        // siga siendo miembro operativo con acceso a la propiedad -- espejo de `rentas.es_miembro_operativo_limpieza`.
        if (n.startsWith("select rentas.responsable_limpieza_vigente")) {
          const [unidadId] = params as [string];
          const unidad = store.getUnidadById(unidadId);
          const candidato = unidad?.responsableLimpiezaDefaultId ?? null;
          const vigente =
            unidad !== null &&
            candidato !== null &&
            this.memberships.some(
              (m) => m.userId === candidato && m.organizationId === unidad.organizationId && ROLES_OPERATIVOS_LIMPIEZA.includes(m.verticalRole) && (m.propertyIds === null || m.propertyIds.includes(unidad.propertyId)),
            );
          return { rows: [{ responsable: vigente ? candidato : null }] as unknown as R[] };
        }
        // reprogramarTareaPorCambioReserva / cancelarTareaPorCancelacionReserva: tarea viva de la reserva.
        if (n.includes("from rentas.tarea_operativa where ocupacion_unidad_id")) {
          const [ocupacionId] = params as [string];
          const fila = store.findTareaActivaPorOcupacion(ocupacionId);
          if (!fila) return { rows: [] as R[] };
          return { rows: [{ id: fila.id, organization_id: fila.organizationId, property_id: fila.propertyId, unidad_id: fila.unidadId, buffer_ocupacion_id: fila.bufferOcupacionId }] as unknown as R[] };
        }
        if (n.startsWith("update rentas.tarea_operativa set programada_para")) {
          const [programadaPara, tareaId] = params as [string, string];
          store.reprogramarTareaOperativa(tareaId, programadaPara);
          return { rows: [] as R[] };
        }
        if (n.startsWith("update rentas.tarea_operativa set estado = 'cancelada'")) {
          const [tareaId] = params as [string];
          store.cancelarTareaOperativa(tareaId);
          return { rows: [] as R[] };
        }

        // ---- migracion 033: validacion del asignado, lista de asignables y cola de avisos in-app ----
        // `rentas.puede_operar_limpieza(propiedad, usuario)`: quien pregunta debe tener acceso a la propiedad y la persona debe ser miembro
        // operativo de ella (espejo de la funcion definer; el verify de Postgres real prueba la version SQL).
        if (n.startsWith("select rentas.puede_operar_limpieza")) {
          const [propertyId, userId] = params as [string, string];
          const property = this.properties.get(propertyId);
          const quienPregunta = claims.userId === null ? undefined : this.memberships.find((m) => m.userId === claims.userId && property && m.organizationId === property.organizationId && (m.propertyIds === null || m.propertyIds.includes(propertyId)));
          const ok =
            property !== undefined &&
            quienPregunta !== undefined &&
            this.memberships.some((m) => m.userId === userId && m.organizationId === property.organizationId && ROLES_OPERATIVOS_LIMPIEZA.includes(m.verticalRole) && (m.propertyIds === null || m.propertyIds.includes(propertyId)));
          return { rows: [{ ok }] as unknown as R[] };
        }
        if (n.startsWith("select user_id, full_name, vertical_role from rentas.listar_asignables_limpieza")) {
          const [propertyId] = params as [string];
          const property = this.properties.get(propertyId);
          const yo = claims.userId === null || !property ? undefined : this.memberships.find((m) => m.userId === claims.userId && m.organizationId === property.organizationId && (m.propertyIds === null || m.propertyIds.includes(propertyId)));
          if (!property || !yo || !["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"].includes(yo.verticalRole)) {
            throw Object.assign(new Error("rentas.listar_asignables_limpieza: sin permiso para esta propiedad."), { code: "42501" });
          }
          const rows = this.memberships
            .filter((m) => m.organizationId === property.organizationId && ROLES_OPERATIVOS_LIMPIEZA.includes(m.verticalRole) && (m.propertyIds === null || m.propertyIds.includes(propertyId)))
            .map((m) => ({ user_id: m.userId, full_name: m.fullName ?? m.userId, vertical_role: m.verticalRole }));
          return { rows: rows as unknown as R[] };
        }
        if (n.startsWith("select n.id as aviso_id, t.id as tarea_id")) {
          const [limite] = params as [number];
          return { rows: store.listAvisosAsignacionPendientes(limite) as unknown as R[] };
        }
        if (n.startsWith("update rentas.notificacion_tarea set notificada_in_app_en = now() where id = any")) {
          const [ids] = params as [string[]];
          store.marcarAvisosNotificados(ids);
          return { rows: [] as R[] };
        }
        if (n.startsWith("update rentas.notificacion_tarea set notificada_in_app_en = now() where tarea_id")) {
          const [tareaId] = params as [string];
          store.marcarAvisosDeTareaNotificados(tareaId);
          return { rows: [] as R[] };
        }

        // ---- barrerLimpiezaPendiente: fases 1-4 del barrido por propiedad ----
        if (n.startsWith("select o.property_id, pc.zona_horaria, min(upper(o.rango))")) {
          const [cota] = params as [string];
          return { rows: store.propiedadesConCheckoutPendiente(cota) as unknown as R[] };
        }
        if (n.startsWith("select o.id as ocupacion_id, o.unidad_id, upper(o.rango)::text as fin from rentas.ocupacion o where o.property_id")) {
          const [propertyId, hasta, limite] = params as [string, string, number];
          return { rows: store.ocupacionesCheckoutPendientesDePropiedad(propertyId, hasta, limite) as unknown as R[] };
        }
        if (n.startsWith("select t.id as tarea_id, t.unidad_id, t.programada_para::text as fecha")) {
          const [cota, limite] = params as [string, number];
          return { rows: store.tareasLimpiezaSinBuffer(cota, limite) as unknown as R[] };
        }
        if (n.startsWith("select t.ocupacion_unidad_id as ocupacion_id from rentas.tarea_operativa t") && n.includes("o.estado = 'cancelado'")) {
          const [limite] = params as [number];
          return { rows: store.tareasDeReservaCancelada(limite) as unknown as R[] };
        }
        if (n.startsWith("select t.ocupacion_unidad_id as ocupacion_id, upper(o.rango)::text as fin")) {
          const [limite] = params as [number];
          return { rows: store.tareasDesfasadasDeSuReserva(limite) as unknown as R[] };
        }
        if (n.startsWith("select t.organization_id, t.property_id, pc.zona_horaria, t.programada_para::text as fecha, count(*)")) {
          const [desde, hasta] = params as [string, string];
          return { rows: store.tareasSinAsignarEnRango(desde, hasta) as unknown as R[] };
        }

        // ---- UPDATE rentas.tarea_operativa SET asignado_a = ... WHERE id = $1
        // RETURNING id (asignarTarea) ----
        if (n.startsWith("update rentas.tarea_operativa set asignado_a")) {
          const [tareaId, asignadoA, esProveedorExterno] = params as [string, string, boolean];
          const resultado = store.asignarTareaOperativa(tareaId, asignadoA, esProveedorExterno);
          return { rows: (resultado ? [resultado] : []) as unknown as R[] };
        }

        // ---- INSERT INTO rentas.notificacion_tarea (asignarTarea/completarTarea) ----
        if (n.startsWith("insert into rentas.notificacion_tarea")) {
          const [tareaId] = params as [string];
          store.insertNotificacionTarea(tareaId, n.includes("'asignada'") ? "asignada" : "completada");
          return { rows: [] as R[] };
        }

        // ---- UPDATE rentas.checklist_item_tarea SET completado = true ... WHERE
        // id = $1 RETURNING id (completarChecklistItem) ----
        if (n.startsWith("update rentas.checklist_item_tarea set completado")) {
          const [checklistItemId, completadoPor] = params as [string, string];
          const resultado = store.completarChecklistItemTarea(checklistItemId, completadoPor);
          return { rows: (resultado ? [resultado] : []) as unknown as R[] };
        }

        // ---- INSERT INTO rentas.foto_checklist_item (completarChecklistItem) ----
        if (n.startsWith("insert into rentas.foto_checklist_item")) {
          const [checklistItemId, rutaAlmacenamiento, subidaPor] = params as [string, string, string | null];
          store.insertFotoChecklistItem(checklistItemId, rutaAlmacenamiento, subidaPor);
          return { rows: [] as R[] };
        }

        // ---- SELECT completado FROM rentas.checklist_item_tarea WHERE tarea_id = $1
        // (completarTarea) ----
        if (n.startsWith("select completado from rentas.checklist_item_tarea")) {
          const [tareaId] = params as [string];
          return { rows: store.listChecklistCompletadoPorTarea(tareaId) as unknown as R[] };
        }

        // ---- UPDATE rentas.tarea_operativa SET estado = 'bloqueada' ... WHERE
        // id = $1 (completarTarea, checklist incompleto) ----
        if (n.startsWith("update rentas.tarea_operativa set estado = 'bloqueada'")) {
          const [tareaId] = params as [string];
          store.marcarTareaBloqueada(tareaId);
          return { rows: [] as R[] };
        }

        // ---- SELECT id, cantidad_actual, umbral_minimo FROM rentas.item_inventario
        // WHERE id = $1 FOR UPDATE (completarTarea, consumo) ----
        if (n.startsWith("select id, cantidad_actual, umbral_minimo from rentas.item_inventario")) {
          const [id] = params as [string];
          const item = store.getItemInventario(id);
          if (!item) return { rows: [] as R[] };
          return { rows: [{ id: item.id, cantidad_actual: String(item.cantidadActual), umbral_minimo: String(item.umbralMinimo) }] as unknown as R[] };
        }

        // ---- UPDATE rentas.item_inventario SET cantidad_actual = $1 ... WHERE
        // id = $2 (completarTarea, consumo) ----
        if (n.startsWith("update rentas.item_inventario set cantidad_actual")) {
          const [cantidadNueva, id] = params as [number, string];
          store.actualizarCantidadInventario(id, cantidadNueva);
          return { rows: [] as R[] };
        }

        // ---- INSERT INTO rentas.movimiento_inventario (completarTarea, consumo) ----
        if (n.startsWith("insert into rentas.movimiento_inventario")) {
          const [itemInventarioId, tareaId, cantidad] = params as [string, string | null, number];
          store.insertMovimientoInventario(itemInventarioId, tareaId, cantidad, "consumo_checklist");
          return { rows: [] as R[] };
        }

        // ---- UPDATE rentas.tarea_operativa SET estado = 'completada' ... WHERE
        // id = $1 (completarTarea) ----
        if (n.startsWith("update rentas.tarea_operativa set estado = 'completada'")) {
          const [tareaId] = params as [string];
          store.marcarTareaCompletada(tareaId);
          return { rows: [] as R[] };
        }

        // ---- INSERT INTO rentas.incidencia_mantenimiento (registrarIncidencia) ----
        if (n.startsWith("insert into rentas.incidencia_mantenimiento")) {
          const [organizationId, propertyId, unidadId, tareaOrigenId, severidad, titulo, descripcion, reportadoPor, estado, propuestaBloqueoInicio, propuestaBloqueoFin] = params as [
            string,
            string,
            string,
            string | null,
            SeveridadIncidencia,
            string,
            string | null,
            string,
            EstadoIncidencia,
            string | null,
            string | null,
          ];
          const resultado = store.insertIncidenciaMantenimiento({
            organizationId,
            propertyId,
            unidadId,
            tareaOrigenId,
            severidad,
            titulo,
            descripcion,
            reportadoPor,
            estado,
            propuestaBloqueoInicio,
            propuestaBloqueoFin,
          });
          return { rows: [resultado] as unknown as R[] };
        }

        // ---- confirmarBloqueoMantenimiento (Rn-05): SELECT de la incidencia + UPDATE al confirmar ----
        if (n.startsWith("select id, organization_id, property_id, unidad_id, severidad, estado,") && n.includes("from rentas.incidencia_mantenimiento")) {
          const [incidenciaId] = params as [string];
          const inc = store.incidencias.get(incidenciaId);
          if (!inc) return { rows: [] as R[] };
          return {
            rows: [
              {
                id: inc.id,
                organization_id: inc.organizationId,
                property_id: inc.propertyId,
                unidad_id: inc.unidadId,
                severidad: inc.severidad,
                estado: inc.estado,
                inicio: inc.propuestaBloqueoInicio,
                fin: inc.propuestaBloqueoFin,
              },
            ] as unknown as R[],
          };
        }
        if (n.startsWith("update rentas.incidencia_mantenimiento set estado = 'bloqueo_confirmado'")) {
          const [incidenciaId, bloqueoOcupacionId, confirmadoPor, inicio, fin] = params as [string, string, string, string, string];
          const inc = store.incidencias.get(incidenciaId);
          if (inc) {
            inc.estado = "bloqueo_confirmado";
            inc.bloqueoOcupacionId = bloqueoOcupacionId;
            inc.confirmadoPor = confirmadoPor;
            inc.propuestaBloqueoInicio = inicio;
            inc.propuestaBloqueoFin = fin;
          }
          return { rows: [] as R[] };
        }

        // SA-L-46: lista de supresion de plataforma (core.supresion_contacto): en memoria nadie esta suprimido.
        if (n.includes("core.esta_suprimido")) return { rows: [{ suprimido: false }] as unknown as R[] };
        if (n.includes("core.registrar_supresion")) return { rows: [{ nueva: true }] as unknown as R[] };

        throw new Error(`InMemoryRentasTenancyEngine: consulta SQL no soportada (alcance angosto a propósito): ${sql}`);
      },
      exec: async (sql: string) => {
        const n = normalize(sql);
        // BEGIN/COMMIT/ROLLBACK "crudos" NUNCA son válidos aquí -- ver el hallazgo
        // de auditoría documentado en la cabecera de
        // ../aplicacion/reservas.ts: esta sesión SIEMPRE corre DENTRO de la
        // transacción EXTERNA que ya abrió `withAppSession` (mismo patrón que
        // `managed-postgres-engine.ts` en producción: BEGIN + "set local role
        // authenticated" + set_config por transacción de REQUEST, antes de invocar
        // `fn`). Antes de este fix, un `BEGIN`/`COMMIT` propio de la capa de
        // aplicación se toleraba en silencio aquí (no-op / libera locks) -- pero en
        // Postgres REAL ese `COMMIT` interno confirma de verdad la transacción
        // EXTERNA (Postgres no anida transacciones reales) y pierde el contexto de
        // sesión (`set local role`/`set_config`, ambos con alcance de transacción)
        // para todo lo que corra después en el mismo handler. Lanzar aquí es lo que
        // permite que un test que reintroduzca ese bug (un `BEGIN`/`COMMIT` propio
        // en vez de `SAVEPOINT`/`RELEASE SAVEPOINT`) falle en CI en vez de pasar en
        // silencio contra este motor.
        if (n === "begin" || n === "commit" || n === "rollback") {
          throw new Error(
            `InMemoryRentasTenancyEngine: exec("${sql.trim()}") no soportado -- esta sesión ya corre dentro de la transacción externa de la request (ver withAppSession/managed-postgres-engine.ts). Un BEGIN/COMMIT/ROLLBACK propio de la capa de aplicación confirmaría o revertiría ESA transacción externa y perdería "set local role"/"set_config" para el resto del handler. Usa SAVEPOINT/RELEASE SAVEPOINT/ROLLBACK TO SAVEPOINT.`,
          );
        }
        if (n.startsWith("savepoint") || n.startsWith("release savepoint") || n.startsWith("rollback to savepoint")) {
          // Ver comentario de cabecera de calendar-store.ts: las restricciones se
          // verifican ANTES de mutar, así que un intento que viola el EXCLUDE nunca
          // llega a persistir nada — no hay estado que deshacer aquí. El advisory
          // lock tampoco se libera en ningún SAVEPOINT/RELEASE/ROLLBACK TO
          // SAVEPOINT -- es xact-scoped a la transacción EXTERNA, nunca a una
          // sub-transacción (ver `heldKeys`/`releaseAllLocks` arriba).
          return;
        }
        if (n.startsWith("update rentas.ocupacion")) {
          throw new Error(`InMemoryRentasTenancyEngine: exec() no debe recibir un UPDATE — usa query(): ${sql}`);
        }
        throw new Error(`InMemoryRentasTenancyEngine: exec() no soportado: ${sql}`);
      },
    };

    // Espejo de `managed-postgres-engine.ts::withAppSession` (Postgres real): el
    // advisory lock es xact-scoped y SIEMPRE se libera cuando la transacción
    // EXTERNA de la request termina (commit o rollback) -- nunca antes, ni por un
    // SAVEPOINT/RELEASE SAVEPOINT interno de `aplicacion/reservas.ts` /
    // `limpieza/aplicacion/tareas.ts` (ver `heldKeys` arriba: esas funciones
    // reutilizan el MISMO lock ya sostenido por esta sesión en vez de volver a
    // pedirlo). La única liberación real ocurre aquí, en el `finally` que envuelve
    // toda la sesión.
    try {
      return await fn(session);
    } finally {
      releaseAllLocks();
    }
  }
}

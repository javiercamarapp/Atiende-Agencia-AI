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
import type { EstadoIncidencia, SeveridadIncidencia } from "./limpieza/tipos.ts";

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
}

interface MembershipQueryRow {
  organization_id: string;
  platform_role: PlatformRole;
  vertical_role: string;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

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
    // Locks adquiridos durante ESTA sesión (un ciclo BEGIN..COMMIT/ROLLBACK) — el
    // advisory lock real es xact-scoped (se libera automáticamente al terminar la
    // transacción), aquí se libera explícitamente cuando se ve el exec() de cierre.
    const heldLocks: Array<() => void> = [];

    const releaseAllLocks = () => {
      while (heldLocks.length > 0) heldLocks.pop()!();
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

        // ---- pg_advisory_xact_lock ----
        if (n.startsWith("select pg_advisory_xact_lock")) {
          const unidadId = params[0] as string;
          const release = await store.acquireUnidadLock(unidadId);
          heldLocks.push(release);
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
        // crearBloqueo/cancelarOcupacion arriba). `crearTareaLimpiezaPorCheckout`/
        // `procesarCheckoutsPendientes`/`reprogramarTareaPorCambioReserva`/
        // `cancelarTareaPorCancelacionReserva`/`confirmarBloqueoMantenimiento` NO se
        // soportan aquí a propósito -- ningún HTTP route de este lote las invoca
        // todavía (ver README de este paquete, sección "Fuera de fase"); los tests
        // de este módulo siembran la tarea/inventario directo con
        // `store.seedTareaOperativa`/`store.seedItemInventario`.
        // -------------------------------------------------------------------

        // ---- SELECT organization_id, property_id FROM rentas.unidad WHERE id = $1
        // (registrarIncidencia) ----
        if (n.startsWith("select organization_id, property_id from rentas.unidad")) {
          const [unidadId] = params as [string];
          const unidad = store.getUnidadById(unidadId);
          if (!unidad) return { rows: [] as R[] };
          return { rows: [{ organization_id: unidad.organizationId, property_id: unidad.propertyId }] as unknown as R[] };
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

        throw new Error(`InMemoryRentasTenancyEngine: consulta SQL no soportada (alcance angosto a propósito): ${sql}`);
      },
      exec: async (sql: string) => {
        const n = normalize(sql);
        if (n === "begin") return;
        if (n === "commit" || n === "rollback") {
          releaseAllLocks();
          return;
        }
        if (n.startsWith("savepoint") || n.startsWith("rollback to savepoint")) {
          // Ver comentario de cabecera de calendar-store.ts: las restricciones se
          // verifican ANTES de mutar, así que un intento que viola el EXCLUDE nunca
          // llega a persistir nada — no hay estado que deshacer aquí.
          return;
        }
        if (n.startsWith("update rentas.ocupacion")) {
          throw new Error(`InMemoryRentasTenancyEngine: exec() no debe recibir un UPDATE — usa query(): ${sql}`);
        }
        throw new Error(`InMemoryRentasTenancyEngine: exec() no soportado: ${sql}`);
      },
    };

    // Espejo de `managed-postgres-engine.ts::withAppSession` (Postgres real): el
    // advisory lock es xact-scoped y SIEMPRE se libera cuando la transacción de la
    // request termina (commit o rollback), sin que el caller tenga que liberarlo a
    // mano (ver diseño Fase 2 rentas §4.2, "se libera solo al COMMIT/ROLLBACK de la
    // transacción de la request"). `aplicacion/reservas.ts` ya libera explícito antes
    // de esto vía `exec("COMMIT"/"ROLLBACK")` para su propia sub-transacción anidada
    // -- `releaseAllLocks()` es idempotente (vacía el array), así que liberar aquí de
    // nuevo al final es inofensivo para ese caso y es la única liberación real para
    // cualquier otro caller (p. ej. `bloquearOwnerStatementEnTransaccion`) que nunca
    // emite su propio exec de cierre, exactamente como en producción.
    try {
      return await fn(session);
    } finally {
      releaseAllLocks();
    }
  }
}

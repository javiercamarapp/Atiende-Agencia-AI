// Fixture real (no un mock) de EjecutorTransaccional para los tests de
// src/limpieza/aplicacion/tareas.ts — mismo criterio de "alcance angosto a
// propósito" que ../../src/in-memory-tenancy-engine.ts: reconoce EXACTAMENTE las
// queries que emite tareas.ts, delegando todo lo demás (rentas.ocupacion/
// rentas.conflicto_calendario/rentas.unidad de duración mínima, advisory lock) a un
// InMemoryRentasTenancyEngine real compartiendo el MISMO InMemoryRentasCalendarStore
// — así `crearTareaLimpiezaPorCheckout`/`confirmarBloqueoMantenimiento` ejercitan el
// `crearBloqueo`/`cancelarOcupacion` REALES de ../../src/aplicacion/reservas.ts, sin
// reimplementarlos aquí. Deliberadamente autocontenido en tests/ (nunca se toca
// ../../src/in-memory-tenancy-engine.ts / calendar-store.ts compartidos con
// tests/reservas.spec.ts) para no arriesgar ningún otro test de esa fixture.
import { randomUUID } from "node:crypto";
import type { EjecutorTransaccional } from "../../src/ejecutor.ts";
import { InMemoryRentasCalendarStore, type StoredTareaOperativa } from "../../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../../src/in-memory-tenancy-engine.ts";
import type { UnidadRecord } from "../../src/types.ts";
import { CONFIGURACION_OPERATIVA_DEFECTO, type PrioridadTareaOperativa, type TipoTareaOperativa } from "../../src/limpieza/tipos.ts";

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

type TareaRow = StoredTareaOperativa;

interface ChecklistItemRow {
  id: string;
  tareaId: string;
  descripcion: string;
  orden: number;
  completado: boolean;
  completadoEn: string | null;
  completadoPor: string | null;
}

interface ItemInventarioRow {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  nombre: string;
  categoria: string;
  cantidadActual: number;
  umbralMinimo: number;
}

interface MovimientoInventarioRow {
  id: string;
  itemInventarioId: string;
  tareaId: string | null;
  cantidad: number;
  motivo: string;
}

interface IncidenciaRow {
  id: string;
  organizationId: string;
  propertyId: string;
  unidadId: string;
  tareaOrigenId: string | null;
  severidad: string;
  titulo: string;
  descripcion: string | null;
  estado: string;
  propuestaBloqueoInicio: string | null;
  propuestaBloqueoFin: string | null;
  bloqueoOcupacionId: string | null;
  reportadoPor: string | null;
  confirmadoPor: string | null;
}

interface NotificacionRow {
  id: string;
  tareaId: string;
  evento: string;
}

export interface FixtureLimpieza {
  readonly ejecutor: EjecutorTransaccional;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidad: UnidadRecord;
  crearUnidad(duracionMinimaNoches?: number, donde?: { organizationId?: string; propertyId?: string }): UnidadRecord;
  /** `rentas.property_config.zona_horaria` de una propiedad (sin fila, el barrido usa el default de plataforma). */
  seedZonaHoraria(propertyId: string, zonaHoraria: string): void;
  /** `rentas.unidad.responsable_limpieza_default` (migracion 033) de una unidad. En esta fixture no hay membresias: la
   *  vigencia del responsable (miembro operativo con acceso) la prueban el verify de Postgres real y los tests de API. */
  seedResponsablePorOmision(unidadId: string, userId: string | null): void;
  /** Todas las tareas guardadas (para asserts de "no se duplico"). */
  listTareas(): TareaRow[];
  seedPropertyConfig(propertyId: string, config: { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number }): void;
  seedItemInventario(row: { unidadId: string; nombre: string; categoria: string; cantidadActual: number; umbralMinimo: number }): { id: string };
  getItemInventario(id: string): ItemInventarioRow | undefined;
  getTarea(id: string): TareaRow | undefined;
  listChecklistItems(tareaId: string): ChecklistItemRow[];
  listMovimientosInventario(itemInventarioId: string): MovimientoInventarioRow[];
  listNotificaciones(tareaId: string): NotificacionRow[];
  getIncidencia(id: string): IncidenciaRow | undefined;
  seedOcupacionConfirmada(input: { unidadId: string; inicio: string; fin: string }): { id: string };
  /** Cambia la fecha de salida de una reserva SIN pasar por el motor de reservas (como lo haria cualquier otro camino de escritura). */
  moverSalidaPorFuera(ocupacionId: string, nuevaFin: string): void;
}

export async function crearFixtureLimpieza(): Promise<FixtureLimpieza> {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  let calendarSession!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    calendarSession = session;
  });

  const organizationId = randomUUID();
  const propertyId = randomUUID();

  function crearUnidad(duracionMinimaNoches = 1, donde: { organizationId?: string; propertyId?: string } = {}): UnidadRecord {
    const unidad: UnidadRecord = { id: randomUUID(), organizationId: donde.organizationId ?? organizationId, propertyId: donde.propertyId ?? propertyId, duracionMinimaNoches };
    store.seedUnidad(unidad);
    return unidad;
  }

  const unidad = crearUnidad();

  const propertyConfigs = new Map<string, { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number }>();
  // Comparten almacen con el motor de calendario: el SQL del barrido y de los ganchos que esta fixture NO intercepta se resuelve
  // en `InMemoryRentasTenancyEngine` sobre las MISMAS filas.
  const tareas = store.tareas;
  const checklistItems = new Map<string, ChecklistItemRow>();
  const itemsInventario = new Map<string, ItemInventarioRow>();
  const movimientos = new Map<string, MovimientoInventarioRow>();
  const incidencias = new Map<string, IncidenciaRow>();
  const notificaciones: NotificacionRow[] = [];

  function seedPropertyConfig(id: string, config: { bufferLimpiezaNoches: number; slaLimpiezaHoras: number; slaMantenimientoHoras: number }): void {
    propertyConfigs.set(id, config);
    store.seedConfiguracionOperativa(id, config);
  }

  function seedItemInventario(row: { unidadId: string; nombre: string; categoria: string; cantidadActual: number; umbralMinimo: number }): { id: string } {
    const id = randomUUID();
    itemsInventario.set(id, { id, organizationId, propertyId, unidadId: row.unidadId, nombre: row.nombre, categoria: row.categoria, cantidadActual: row.cantidadActual, umbralMinimo: row.umbralMinimo });
    return { id };
  }

  function seedOcupacionConfirmada(input: { unidadId: string; inicio: string; fin: string }): { id: string } {
    const duena = store.unidades.get(input.unidadId);
    return store.insertOcupacionReserva({
      organizationId: duena?.organizationId ?? organizationId,
      propertyId: duena?.propertyId ?? propertyId,
      unidadId: input.unidadId,
      inicio: input.inicio,
      fin: input.fin,
      estado: "confirmado",
      bloqueante: true,
      canalOrigenId: null,
      externalId: null,
    });
  }

  function tareaRowToApi(fila: TareaRow) {
    return {
      id: fila.id,
      organization_id: fila.organizationId,
      property_id: fila.propertyId,
      unidad_id: fila.unidadId,
      ocupacion_unidad_id: fila.ocupacionUnidadId,
      buffer_ocupacion_id: fila.bufferOcupacionId,
    };
  }

  const ejecutor: EjecutorTransaccional = {
    exec: async (sql: string) => {
      await calendarSession.exec(sql);
    },
    query: async <T>(sql: string, params: unknown[] = []) => {
      const n = normalize(sql);

      // ---- rentas.unidad: organization_id/property_id (obtenerConfiguracion / registrarIncidencia) ----
      if (n.startsWith("select organization_id, property_id from rentas.unidad")) {
        const [unidadId] = params as [string];
        const fila = store.unidades.get(unidadId) as UnidadRecord | undefined;
        if (!fila) return { rows: [] as T[] };
        return { rows: [{ organization_id: fila.organizationId, property_id: fila.propertyId }] as unknown as T[] };
      }

      // ---- rentas.property_config: buffer/SLA ----
      if (n.startsWith("select buffer_limpieza_noches")) {
        const [pid] = params as [string];
        const config = propertyConfigs.get(pid);
        if (!config) return { rows: [] as T[] };
        return { rows: [{ buffer_limpieza_noches: config.bufferLimpiezaNoches, sla_limpieza_horas: config.slaLimpiezaHoras, sla_mantenimiento_horas: config.slaMantenimientoHoras }] as unknown as T[] };
      }

      // ---- INSERT rentas.tarea_operativa -- DOS variantes distinguidas por texto
      // literal, mismo criterio que ../../src/in-memory-tenancy-engine.ts:
      // `crearTareaLimpiezaPorCheckout` fija `tipo='limpieza'` como literal SQL
      // (params: organization_id, property_id, unidad_id, ocupacion_unidad_id,
      // prioridad, programada_para, sla_vence_en); `crearTareaOperativaManual` fija
      // `ocupacion_unidad_id=NULL` como literal y parametriza `tipo` (params:
      // organization_id, property_id, unidad_id, tipo, prioridad, programada_para,
      // sla_vence_en). ----
      if (n.startsWith("insert into rentas.tarea_operativa")) {
        const id = randomUUID();
        if (n.includes("'limpieza', 'pendiente'")) {
          const [organization_id, property_id, unidad_id, ocupacion_unidad_id, prioridad, programada_para, sla_vence_en] = params as [string, string, string, string, PrioridadTareaOperativa, string, string | null];
          tareas.set(id, {
            id,
            organizationId: organization_id,
            propertyId: property_id,
            unidadId: unidad_id,
            ocupacionUnidadId: ocupacion_unidad_id,
            tipo: "limpieza",
            estado: "pendiente",
            prioridad,
            asignadoA: null,
            esProveedorExterno: false,
            programadaPara: programada_para,
            slaVenceEn: sla_vence_en,
            bufferOcupacionId: null,
            completadaEn: null,
            creadoEn: new Date().toISOString(),
            actualizadoEn: new Date().toISOString(),
          });
          return { rows: [{ id }] as unknown as T[] };
        }
        const [organization_id, property_id, unidad_id, tipo, prioridad, programada_para, sla_vence_en] = params as [string, string, string, TipoTareaOperativa, PrioridadTareaOperativa, string, string | null];
        tareas.set(id, {
          id,
          organizationId: organization_id,
          propertyId: property_id,
          unidadId: unidad_id,
          ocupacionUnidadId: null,
          tipo,
          estado: "pendiente",
          prioridad,
          asignadoA: null,
          esProveedorExterno: false,
          programadaPara: programada_para,
          slaVenceEn: sla_vence_en,
          bufferOcupacionId: null,
          completadaEn: null,
          creadoEn: new Date().toISOString(),
          actualizadoEn: new Date().toISOString(),
        });
        return { rows: [{ id }] as unknown as T[] };
      }

      // ---- INSERT rentas.checklist_item_tarea ----
      if (n.startsWith("insert into rentas.checklist_item_tarea")) {
        const [tareaId, descripcion, orden] = params as [string, string, number];
        const id = randomUUID();
        checklistItems.set(id, { id, tareaId, descripcion, orden, completado: false, completadoEn: null, completadoPor: null });
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = $1 WHERE id = $2 ----
      if (n.startsWith("update rentas.tarea_operativa set buffer_ocupacion_id = $1 where id = $2")) {
        const [bufferOcupacionId, tareaId] = params as [string | null, string];
        const fila = tareas.get(tareaId);
        if (fila) fila.bufferOcupacionId = bufferOcupacionId;
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET buffer_ocupacion_id = NULL WHERE id = $1 ----
      if (n.startsWith("update rentas.tarea_operativa set buffer_ocupacion_id = null where id = $1")) {
        const [tareaId] = params as [string];
        const fila = tareas.get(tareaId);
        if (fila) fila.bufferOcupacionId = null;
        return { rows: [] as T[] };
      }

      // ---- SELECT ... FROM rentas.tarea_operativa WHERE ocupacion_unidad_id = $1 (reprogramar/cancelar) ----
      if (n.includes("from rentas.tarea_operativa where ocupacion_unidad_id")) {
        const [ocupacionUnidadId] = params as [string];
        const candidatas = [...tareas.values()]
          .filter((t) => t.ocupacionUnidadId === ocupacionUnidadId && t.estado !== "completada" && t.estado !== "cancelada")
          .sort((a, b) => (a.creadoEn < b.creadoEn ? 1 : -1));
        if (candidatas.length === 0) return { rows: [] as T[] };
        return { rows: [tareaRowToApi(candidatas[0]!)] as unknown as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET programada_para = $1 ... WHERE id = $2 ----
      if (n.startsWith("update rentas.tarea_operativa set programada_para")) {
        const [programadaPara, tareaId] = params as [string, string];
        const fila = tareas.get(tareaId);
        if (fila) fila.programadaPara = programadaPara;
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET estado = 'cancelada' ... WHERE id = $1 ----
      if (n.startsWith("update rentas.tarea_operativa set estado = 'cancelada'")) {
        const [tareaId] = params as [string];
        const fila = tareas.get(tareaId);
        if (fila) fila.estado = "cancelada";
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET estado = 'bloqueada' ... WHERE id = $1 ----
      if (n.startsWith("update rentas.tarea_operativa set estado = 'bloqueada'")) {
        const [tareaId] = params as [string];
        const fila = tareas.get(tareaId);
        if (fila) fila.estado = "bloqueada";
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET estado = 'completada' ... WHERE id = $1 ----
      if (n.startsWith("update rentas.tarea_operativa set estado = 'completada'")) {
        const [tareaId] = params as [string];
        const fila = tareas.get(tareaId);
        if (fila) {
          fila.estado = "completada";
          fila.completadaEn = new Date().toISOString();
        }
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.tarea_operativa SET asignado_a = $2 ... WHERE id = $1 RETURNING id ----
      if (n.startsWith("update rentas.tarea_operativa set asignado_a")) {
        const [tareaId, asignadoA, esProveedorExterno] = params as [string, string, boolean];
        const fila = tareas.get(tareaId);
        if (!fila) return { rows: [] as T[] };
        fila.asignadoA = asignadoA;
        fila.esProveedorExterno = esProveedorExterno;
        if (fila.estado === "pendiente") fila.estado = "asignada";
        return { rows: [{ id: tareaId }] as unknown as T[] };
      }

      // ---- Responsable por omision (migracion 033): lo siembra `seedResponsablePorOmision`; sin membresias en esta fixture. ----
      if (n.startsWith("select rentas.responsable_limpieza_vigente")) {
        const [unidadId] = params as [string];
        return { rows: [{ responsable: store.getUnidadById(unidadId)?.responsableLimpiezaDefaultId ?? null }] as unknown as T[] };
      }

      // ---- INSERT rentas.notificacion_tarea ----
      if (n.startsWith("insert into rentas.notificacion_tarea")) {
        const [tareaId] = params as [string];
        const evento = n.includes("'asignada'") ? "asignada" : "completada";
        notificaciones.push({ id: randomUUID(), tareaId, evento });
        return { rows: [] as T[] };
      }

      // ---- UPDATE rentas.checklist_item_tarea SET completado = true ... WHERE id = $1 RETURNING id ----
      if (n.startsWith("update rentas.checklist_item_tarea set completado")) {
        const [checklistItemId, completadoPor] = params as [string, string];
        const fila = checklistItems.get(checklistItemId);
        if (!fila) return { rows: [] as T[] };
        fila.completado = true;
        fila.completadoEn = new Date().toISOString();
        fila.completadoPor = completadoPor;
        return { rows: [{ id: checklistItemId }] as unknown as T[] };
      }

      // ---- INSERT rentas.foto_checklist_item ----
      if (n.startsWith("insert into rentas.foto_checklist_item")) {
        return { rows: [] as T[] };
      }

      // ---- SELECT completado FROM rentas.checklist_item_tarea WHERE tarea_id = $1 ----
      if (n.startsWith("select completado from rentas.checklist_item_tarea")) {
        const [tareaId] = params as [string];
        const filas = [...checklistItems.values()].filter((c) => c.tareaId === tareaId).map((c) => ({ completado: c.completado }));
        return { rows: filas as unknown as T[] };
      }

      // ---- SELECT ... FROM rentas.item_inventario WHERE id = $1 FOR UPDATE ----
      if (n.startsWith("select id, cantidad_actual, umbral_minimo from rentas.item_inventario")) {
        const [id] = params as [string];
        const fila = itemsInventario.get(id);
        if (!fila) return { rows: [] as T[] };
        return { rows: [{ id: fila.id, cantidad_actual: String(fila.cantidadActual), umbral_minimo: String(fila.umbralMinimo) }] as unknown as T[] };
      }

      // ---- UPDATE rentas.item_inventario SET cantidad_actual = $1 ... WHERE id = $2 ----
      if (n.startsWith("update rentas.item_inventario set cantidad_actual")) {
        const [cantidadNueva, id] = params as [number, string];
        const fila = itemsInventario.get(id);
        if (fila) fila.cantidadActual = cantidadNueva;
        return { rows: [] as T[] };
      }

      // ---- INSERT rentas.movimiento_inventario ----
      if (n.startsWith("insert into rentas.movimiento_inventario")) {
        const [itemInventarioId, tareaId, cantidad] = params as [string, string | null, number];
        const id = randomUUID();
        movimientos.set(id, { id, itemInventarioId, tareaId, cantidad, motivo: "consumo_checklist" });
        return { rows: [] as T[] };
      }

      // ---- INSERT rentas.incidencia_mantenimiento ----
      if (n.startsWith("insert into rentas.incidencia_mantenimiento")) {
        const [organization_id, property_id, unidad_id, tarea_origen_id, severidad, titulo, descripcion, reportado_por, estado, inicio, fin] = params as [
          string,
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string,
          string,
          string | null,
          string | null,
        ];
        const id = randomUUID();
        incidencias.set(id, {
          id,
          organizationId: organization_id,
          propertyId: property_id,
          unidadId: unidad_id,
          tareaOrigenId: tarea_origen_id,
          severidad,
          titulo,
          descripcion,
          estado,
          propuestaBloqueoInicio: inicio,
          propuestaBloqueoFin: fin,
          bloqueoOcupacionId: null,
          reportadoPor: reportado_por,
          confirmadoPor: null,
        });
        return { rows: [{ id }] as unknown as T[] };
      }

      // ---- SELECT ... FROM rentas.incidencia_mantenimiento WHERE id = $1 (confirmarBloqueoMantenimiento) ----
      if (n.startsWith("select id, organization_id, property_id, unidad_id, severidad, estado")) {
        const [id] = params as [string];
        const fila = incidencias.get(id);
        if (!fila) return { rows: [] as T[] };
        return {
          rows: [
            {
              id: fila.id,
              organization_id: fila.organizationId,
              property_id: fila.propertyId,
              unidad_id: fila.unidadId,
              severidad: fila.severidad,
              estado: fila.estado,
              inicio: fila.propuestaBloqueoInicio,
              fin: fila.propuestaBloqueoFin,
            },
          ] as unknown as T[],
        };
      }

      // ---- UPDATE rentas.incidencia_mantenimiento SET estado = 'bloqueo_confirmado' ... WHERE id = $1 ----
      if (n.startsWith("update rentas.incidencia_mantenimiento set estado = 'bloqueo_confirmado'")) {
        const [id, bloqueoOcupacionId, confirmadoPor, inicio, fin] = params as [string, string, string, string, string];
        const fila = incidencias.get(id);
        if (fila) {
          fila.estado = "bloqueo_confirmado";
          fila.bloqueoOcupacionId = bloqueoOcupacionId;
          fila.confirmadoPor = confirmadoPor;
          fila.propuestaBloqueoInicio = inicio;
          fila.propuestaBloqueoFin = fin;
        }
        return { rows: [] as T[] };
      }

      // ---- Cualquier otra query (rentas.ocupacion/rentas.conflicto_calendario/advisory lock/
      // rentas.unidad.duracion_minima_noches) la maneja el motor de calendario real. ----
      return calendarSession.query(sql, params) as Promise<{ rows: T[]; rowCount?: number | null }>;
    },
  };

  const fixture: FixtureLimpieza = {
    ejecutor,
    organizationId,
    propertyId,
    unidad,
    crearUnidad,
    seedPropertyConfig,
    seedZonaHoraria: (id: string, zona: string) => store.seedZonaHoraria(id, zona),
    seedResponsablePorOmision: (unidadId: string, userId: string | null) => {
      const u = store.getUnidadById(unidadId);
      if (u) store.seedUnidad({ ...u, responsableLimpiezaDefaultId: userId });
    },
    listTareas: () => [...tareas.values()],
    seedItemInventario,
    getItemInventario: (id: string) => itemsInventario.get(id),
    getTarea: (id: string) => tareas.get(id),
    listChecklistItems: (tareaId: string) => [...checklistItems.values()].filter((c) => c.tareaId === tareaId).sort((a, b) => a.orden - b.orden),
    listMovimientosInventario: (itemInventarioId: string) => [...movimientos.values()].filter((m) => m.itemInventarioId === itemInventarioId),
    listNotificaciones: (tareaId: string) => notificaciones.filter((n2) => n2.tareaId === tareaId),
    getIncidencia: (id: string) => incidencias.get(id),
    seedOcupacionConfirmada,
    moverSalidaPorFuera: (ocupacionId: string, nuevaFin: string) => {
      const o = store.ocupaciones.get(ocupacionId);
      if (o) o.fin = nuevaFin;
    },
  };
  return fixture;
}

export { CONFIGURACION_OPERATIVA_DEFECTO };

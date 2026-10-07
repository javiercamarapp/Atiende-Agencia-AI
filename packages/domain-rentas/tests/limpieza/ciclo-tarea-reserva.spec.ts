// Ciclo de la tarea de limpieza ligada a la reserva (paridad3 rentas): nace al confirmar, se reprograma al mover las fechas,
// se cancela con la reserva, nace asignada al responsable por omision y NUNCA rompe la operacion de calendario.
// Contra el motor transaccional REAL de aplicacion/reservas.ts (ejecutor de ./helpers.ts + InMemoryRentasTenancyEngine) y
// contra el motor iCal real, sin mocks de la logica bajo prueba.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../../src/calendar-store.ts";
import { InMemoryRentasTenancyEngine } from "../../src/in-memory-tenancy-engine.ts";
import { cancelarOcupacion, crearReservaConfirmada, modificarFechasReserva } from "../../src/aplicacion/reservas.ts";
import { barrerLimpiezaPendiente } from "../../src/limpieza/aplicacion/tareas.ts";
import type { EjecutorTransaccional } from "../../src/ejecutor.ts";
import type { UnidadRecord } from "../../src/types.ts";
import { FakeIcalFeedPort } from "../../src/sync/calendar-sync-port.ts";
import { InMemoryRentasCalendarSyncRepository } from "../../src/sync/in-memory-repository.ts";
import { ejecutarCicloImportacion } from "../../src/sync/motor.ts";
import { crearFixtureLimpieza } from "./helpers.ts";

const RESPONSABLE = "00000000-0000-0000-0000-0000000000aa";

async function confirmar(f: Awaited<ReturnType<typeof crearFixtureLimpieza>>, rango = { inicio: "2026-06-01", fin: "2026-06-05" }) {
  return crearReservaConfirmada(f.ejecutor, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango, estado: "confirmado", bloqueante: true });
}

/** Envuelve un ejecutor con la semantica REAL de una transaccion de Postgres: un error deja la transaccion ABORTADA (25P02 en
 *  toda consulta posterior) hasta un `ROLLBACK TO SAVEPOINT`. Una sesion falsa plana NO reproduce esto. */
function conTransaccionAbortable(base: EjecutorTransaccional, falla: (sql: string) => { code: string; message: string } | null) {
  let abortada = false;
  const llamadas: string[] = [];
  const ejecutor: EjecutorTransaccional = {
    exec: async (sql: string) => {
      const n = sql.trim().toLowerCase();
      llamadas.push(n);
      if (n.startsWith("rollback to savepoint")) {
        abortada = false;
        return base.exec(sql);
      }
      if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      return base.exec(sql);
    },
    query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
      const error = falla(sql);
      if (error) {
        abortada = true;
        throw Object.assign(new Error(error.message), { code: error.code });
      }
      return base.query<T>(sql, params);
    },
  };
  return { ejecutor, llamadas, estaAbortada: () => abortada };
}

describe("tarea de limpieza al confirmar la reserva (crearReservaConfirmada)", () => {
  it("deja la tarea creada en la misma transaccion, con la fecha de salida y la plantilla de checklist", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);

    expect(reserva.tareaLimpiezaId).not.toBeNull();
    const tarea = f.getTarea(reserva.tareaLimpiezaId!)!;
    expect(tarea.tipo).toBe("limpieza");
    expect(tarea.estado).toBe("pendiente");
    expect(tarea.ocupacionUnidadId).toBe(reserva.ocupacionId);
    expect(tarea.programadaPara).toBe("2026-06-05");
    expect(f.listChecklistItems(tarea.id).length).toBeGreaterThan(0);
    expect(reserva.tareaLimpiezaAsignadaA).toBeNull();
  });

  it("NO crea el buffer de calendario al confirmar (lo materializa el barrido el dia del checkout)", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    expect(f.getTarea(reserva.tareaLimpiezaId!)?.bufferOcupacionId).toBeNull();
  });

  it("el barrido posterior no duplica la tarea (misma guarda NOT EXISTS) y crea el buffer cuando llega el dia", async () => {
    const f = await crearFixtureLimpieza();
    await confirmar(f, { inicio: "2025-05-01", fin: "2025-05-05" });
    const antes = f.listTareas().length;

    const resultado = await barrerLimpiezaPendiente(f.ejecutor);

    expect(antes).toBe(1);
    expect(resultado.tareasCreadas).toHaveLength(0);
    expect(f.listTareas()).toHaveLength(1);
    expect(resultado.buffersCreados).toBe(1);
    expect(f.listTareas()[0]!.bufferOcupacionId).not.toBeNull();
  });

  it("una reserva provisional NO crea tarea (todavia no hay checkout confirmado)", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await crearReservaConfirmada(f.ejecutor, {
      organizationId: f.organizationId,
      propertyId: f.propertyId,
      unidadId: f.unidad.id,
      rango: { inicio: "2026-06-01", fin: "2026-06-05" },
      estado: "provisional",
      bloqueante: false,
    });
    expect(reserva.tareaLimpiezaId).toBeNull();
    expect(f.listTareas()).toHaveLength(0);
  });

  it("una reserva que queda en conflicto (overbooking) NO crea tarea", async () => {
    const f = await crearFixtureLimpieza();
    await confirmar(f);
    const segunda = await confirmar(f, { inicio: "2026-06-03", fin: "2026-06-08" });
    expect(segunda.conflicto).not.toBeNull();
    expect(segunda.tareaLimpiezaId).toBeNull();
    expect(f.listTareas()).toHaveLength(1);
  });

  it("nace asignada al responsable por omision de la unidad y deja el aviso en la cola de notificaciones", async () => {
    const f = await crearFixtureLimpieza();
    f.seedResponsablePorOmision(f.unidad.id, RESPONSABLE);

    const reserva = await confirmar(f);

    const tarea = f.getTarea(reserva.tareaLimpiezaId!)!;
    expect(tarea.asignadoA).toBe(RESPONSABLE);
    expect(tarea.estado).toBe("asignada");
    expect(reserva.tareaLimpiezaAsignadaA).toBe(RESPONSABLE);
    expect(f.listNotificaciones(tarea.id).map((n) => n.evento)).toEqual(["asignada"]);
  });

  it("sin responsable por omision, la tarea va a la cola 'Sin asignar'", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    expect(f.getTarea(reserva.tareaLimpiezaId!)?.asignadoA).toBeNull();
  });
});

describe("tarea de limpieza al modificar fechas y cancelar la reserva", () => {
  it("mover la salida reprograma la tarea y CONSERVA al responsable asignado", async () => {
    const f = await crearFixtureLimpieza();
    f.seedResponsablePorOmision(f.unidad.id, RESPONSABLE);
    const reserva = await confirmar(f);

    const modificada = await modificarFechasReserva(f.ejecutor, reserva.ocupacionId, { inicio: "2026-06-01", fin: "2026-06-09" });

    expect(modificada.conflicto).toBeNull();
    const tarea = f.getTarea(reserva.tareaLimpiezaId!)!;
    expect(tarea.programadaPara).toBe("2026-06-09");
    expect(tarea.asignadoA).toBe(RESPONSABLE);
    expect(f.listTareas()).toHaveLength(1);
  });

  it("cambiar solo la entrada (misma salida) no toca la tarea", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    const antes = f.getTarea(reserva.tareaLimpiezaId!)!.actualizadoEn;

    await modificarFechasReserva(f.ejecutor, reserva.ocupacionId, { inicio: "2026-06-02", fin: "2026-06-05" });

    expect(f.getTarea(reserva.tareaLimpiezaId!)!.actualizadoEn).toBe(antes);
  });

  it("una modificacion rechazada por conflicto NO mueve la tarea (la reserva sigue en su rango anterior)", async () => {
    const f = await crearFixtureLimpieza();
    const primera = await confirmar(f);
    await confirmar(f, { inicio: "2026-06-10", fin: "2026-06-14" });

    const intento = await modificarFechasReserva(f.ejecutor, primera.ocupacionId, { inicio: "2026-06-01", fin: "2026-06-12" });

    expect(intento.conflicto).not.toBeNull();
    expect(f.getTarea(primera.tareaLimpiezaId!)!.programadaPara).toBe("2026-06-05");
  });

  it("cancelar la reserva cancela su tarea de limpieza", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);

    await cancelarOcupacion(f.ejecutor, reserva.ocupacionId);

    expect(f.getTarea(reserva.tareaLimpiezaId!)?.estado).toBe("cancelada");
  });

  it("cancelar una tarea ya completada no la reabre ni la cancela", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    f.getTarea(reserva.tareaLimpiezaId!)!.estado = "completada";

    await cancelarOcupacion(f.ejecutor, reserva.ocupacionId);

    expect(f.getTarea(reserva.tareaLimpiezaId!)?.estado).toBe("completada");
  });

  it("cancelar un bloqueo (sin tarea) sigue funcionando", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    const r = await cancelarOcupacion(f.ejecutor, reserva.ocupacionId);
    expect(r.estadoAnterior).toBe("confirmado");
  });
});

describe("la tarea es un efecto accesorio: nunca rompe la operacion de calendario (SAVEPOINT, AbortAware)", () => {
  it("si crear la tarea falla con un error de Postgres, la reserva se confirma igual y la transaccion NO queda abortada", async () => {
    const f = await crearFixtureLimpieza();
    const { ejecutor, estaAbortada, llamadas } = conTransaccionAbortable(f.ejecutor, (sql) => (/insert into rentas\.tarea_operativa/i.test(sql) ? { code: "42501", message: "permission denied for table tarea_operativa" } : null));

    const reserva = await crearReservaConfirmada(ejecutor, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });

    expect(reserva.tareaLimpiezaId).toBeNull();
    expect(estaAbortada()).toBe(false);
    expect(llamadas.some((l) => l.startsWith("rollback to savepoint sp_limpieza_al_confirmar"))).toBe(true);
    // La reserva SI quedo escrita y la sesion sigue utilizable para lo que venga despues en el mismo request.
    const siguiente = await crearReservaConfirmada(ejecutor, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2026-07-01", fin: "2026-07-03" }, estado: "provisional", bloqueante: false });
    expect(siguiente.ocupacionId).toBeTruthy();
    expect(f.listTareas()).toHaveLength(0);
  });

  it("base sin migrar: la funcion del responsable no existe (42883) y la tarea nace sin responsable, sin abortar la transaccion", async () => {
    const f = await crearFixtureLimpieza();
    f.seedResponsablePorOmision(f.unidad.id, RESPONSABLE);
    const { ejecutor, estaAbortada } = conTransaccionAbortable(f.ejecutor, (sql) => (/responsable_limpieza_vigente/i.test(sql) ? { code: "42883", message: "function rentas.responsable_limpieza_vigente(uuid) does not exist" } : null));

    const reserva = await crearReservaConfirmada(ejecutor, { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidad.id, rango: { inicio: "2026-06-01", fin: "2026-06-05" }, estado: "confirmado", bloqueante: true });

    expect(reserva.tareaLimpiezaId).not.toBeNull();
    expect(f.getTarea(reserva.tareaLimpiezaId!)?.asignadoA).toBeNull();
    expect(estaAbortada()).toBe(false);
  });

  it("si cancelar la tarea falla, la reserva SI se cancela y el barrido cancela despues la tarea huerfana", async () => {
    const f = await crearFixtureLimpieza();
    const reserva = await confirmar(f);
    const { ejecutor, estaAbortada } = conTransaccionAbortable(f.ejecutor, (sql) => (/from rentas\.tarea_operativa where ocupacion_unidad_id/i.test(sql.replace(/\s+/g, " ")) ? { code: "42501", message: "permission denied" } : null));

    const r = await cancelarOcupacion(ejecutor, reserva.ocupacionId);

    expect(r.estadoAnterior).toBe("confirmado");
    expect(estaAbortada()).toBe(false);
    expect(f.getTarea(reserva.tareaLimpiezaId!)?.estado).toBe("pendiente");

    const barrido = await barrerLimpiezaPendiente(f.ejecutor);
    expect(barrido.tareasCanceladas).toBe(1);
    expect(f.getTarea(reserva.tareaLimpiezaId!)?.estado).toBe("cancelada");
  });
});

describe("el motor iCal (importacion de canales) mueve la tarea igual que la ruta de reservas", () => {
  const URL = "https://feeds.airbnb.com/calendar/ical/unidad-1.ics";

  function ics(opts: { uid: string; dtstart: string; dtend: string; sequence?: number; status?: string }): string {
    const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TEST//EN", "BEGIN:VEVENT", `UID:${opts.uid}`, `DTSTAMP:2026012${opts.sequence ?? 0}T000000Z`, `DTSTART;VALUE=DATE:${opts.dtstart.replaceAll("-", "")}`, `DTEND;VALUE=DATE:${opts.dtend.replaceAll("-", "")}`, `SEQUENCE:${opts.sequence ?? 0}`];
    if (opts.status) lineas.push(`STATUS:${opts.status}`);
    lineas.push("END:VEVENT", "END:VCALENDAR");
    return lineas.join("\r\n");
  }

  async function montar() {
    const store = new InMemoryRentasCalendarStore();
    const engine = new InMemoryRentasTenancyEngine(store);
    let db!: EjecutorTransaccional;
    await engine.withAppSession({ userId: null }, async (session) => {
      db = session;
    });
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1 };
    store.seedUnidad(unidad);
    const canal = store.findCanalPorCodigo("airbnb")!;
    const syncRepo = new InMemoryRentasCalendarSyncRepository(store);
    const port = new FakeIcalFeedPort();
    await syncRepo.connectFeed({ organizationId, propertyId, unidadId: unidad.id, canalId: canal.id, urlImportacion: URL });
    const ciclo = async () => ejecutarCicloImportacion({ db, syncRepo, port, feed: (await syncRepo.findFeed(propertyId, unidad.id, canal.id))!, zonaHorariaPropiedad: "America/Mexico_City" });
    return { store, port, ciclo };
  }

  it("una reserva nueva del canal deja su tarea; un cambio de fechas la reprograma; un CANCELLED la cancela", async () => {
    const { store, port, ciclo } = await montar();

    port.definirEscenario(URL, { tipo: "ics", contenidoIcs: ics({ uid: "evt-1@airbnb.com", dtstart: "2026-08-01", dtend: "2026-08-04", sequence: 0 }) });
    await ciclo();
    const tareas = () => [...store.tareas.values()];
    expect(tareas()).toHaveLength(1);
    expect(tareas()[0]!.programadaPara).toBe("2026-08-04");
    expect(tareas()[0]!.tipo).toBe("limpieza");

    port.definirEscenario(URL, { tipo: "ics", contenidoIcs: ics({ uid: "evt-1@airbnb.com", dtstart: "2026-08-01", dtend: "2026-08-07", sequence: 1 }) });
    await ciclo();
    expect(tareas()).toHaveLength(1);
    expect(tareas()[0]!.programadaPara).toBe("2026-08-07");

    port.definirEscenario(URL, { tipo: "ics", contenidoIcs: ics({ uid: "evt-1@airbnb.com", dtstart: "2026-08-01", dtend: "2026-08-07", sequence: 2, status: "CANCELLED" }) });
    await ciclo();
    expect(tareas()[0]!.estado).toBe("cancelada");
  });
});

// Barrido de limpieza por propiedad (barrerLimpiezaPendiente): "hoy" en la zona horaria de CADA propiedad, tope por propiedad
// para no dejar sin turno a las demas, buffer el dia del checkout, tareas huerfanas o desfasadas y aviso de manana sin responsable.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barrerLimpiezaPendiente, crearTareaLimpiezaPorCheckout, crearTareaOperativaManual } from "../../src/limpieza/aplicacion/tareas.ts";
import type { EjecutorTransaccional } from "../../src/ejecutor.ts";
import { crearFixtureLimpieza } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

function reloj(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

/** Una propiedad nueva (organizacion propia) con una unidad, sobre la misma fixture. */
function propiedadAparte(f: Awaited<ReturnType<typeof crearFixtureLimpieza>>) {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidad = f.crearUnidad(1, { organizationId, propertyId });
  return { organizationId, propertyId, unidad };
}

describe("zona horaria de cada propiedad", () => {
  it("a las 23:30 de Cancun ya es el dia siguiente en Cancun pero NO en CDMX: solo la propiedad de Cancun recibe su tarea", async () => {
    // 2026-03-02T05:30Z = 2026-03-01 23:30 America/Mexico_City (UTC-6) y 2026-03-02 00:30 America/Cancun (UTC-5).
    reloj("2026-03-02T05:30:00.000Z");
    const f = await crearFixtureLimpieza();
    const cancun = propiedadAparte(f);
    const cdmx = propiedadAparte(f);
    f.seedZonaHoraria(cancun.propertyId, "America/Cancun");
    f.seedZonaHoraria(cdmx.propertyId, "America/Mexico_City");
    f.seedOcupacionConfirmada({ unidadId: cancun.unidad.id, inicio: "2026-02-26", fin: "2026-03-02" });
    f.seedOcupacionConfirmada({ unidadId: cdmx.unidad.id, inicio: "2026-02-26", fin: "2026-03-02" });

    const r = await barrerLimpiezaPendiente(f.ejecutor);

    const tareas = f.listTareas();
    expect(r.tareasCreadas).toHaveLength(1);
    expect(tareas).toHaveLength(1);
    expect(tareas[0]!.propertyId).toBe(cancun.propertyId);
  });

  it("a las 23:30 de CDMX (04:30Z, Cancun aun 22:30... 23:30) ambas propiedades siguen en el mismo dia: ninguna procesa la salida de manana", async () => {
    // 2026-03-02T04:30Z = 2026-03-01 22:30 CDMX y 2026-03-01 23:30 Cancun: en ambas "hoy" es 2026-03-01.
    reloj("2026-03-02T04:30:00.000Z");
    const f = await crearFixtureLimpieza();
    const cancun = propiedadAparte(f);
    const cdmx = propiedadAparte(f);
    f.seedZonaHoraria(cancun.propertyId, "America/Cancun");
    f.seedZonaHoraria(cdmx.propertyId, "America/Mexico_City");
    f.seedOcupacionConfirmada({ unidadId: cancun.unidad.id, inicio: "2026-02-26", fin: "2026-03-02" });
    f.seedOcupacionConfirmada({ unidadId: cdmx.unidad.id, inicio: "2026-02-26", fin: "2026-03-02" });

    const r = await barrerLimpiezaPendiente(f.ejecutor);

    expect(r.tareasCreadas).toHaveLength(0);
    expect(f.listTareas()).toHaveLength(0);
  });

  it("una zona horaria corrupta en property_config cae al default de plataforma en vez de tumbar el barrido", async () => {
    reloj("2026-03-02T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    f.seedZonaHoraria(f.propertyId, "Marte/Olympus");
    f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio: "2026-02-26", fin: "2026-03-01" });

    const r = await barrerLimpiezaPendiente(f.ejecutor);

    expect(r.tareasCreadas).toHaveLength(1);
  });
});

describe("tope por propiedad: una organizacion grande no deja sin turno a las demas", () => {
  it("con 120 salidas atrasadas en la primera organizacion y un tope total de 41, la segunda organizacion recibe su tarea", async () => {
    reloj("2026-06-30T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    const grande = f.unidad;
    const otra = propiedadAparte(f);
    // 120 salidas de la organizacion grande (las mas antiguas), una por noche, y UNA de la otra organizacion (mas reciente).
    for (let i = 0; i < 120; i += 1) {
      const inicio = new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString().slice(0, 10);
      const fin = new Date(Date.UTC(2026, 0, 2 + i * 2)).toISOString().slice(0, 10);
      f.seedOcupacionConfirmada({ unidadId: grande.id, inicio, fin });
    }
    f.seedOcupacionConfirmada({ unidadId: otra.unidad.id, inicio: "2026-06-10", fin: "2026-06-12" });

    const r = await barrerLimpiezaPendiente(f.ejecutor, { limiteTotal: 41, limitePorPropiedad: 40 });

    expect(r.tareasCreadas).toHaveLength(41);
    const porPropiedad = (propertyId: string) => f.listTareas().filter((t) => t.propertyId === propertyId).length;
    expect(porPropiedad(f.propertyId)).toBe(40);
    expect(porPropiedad(otra.propertyId)).toBe(1);
  });

  it("las corridas siguientes drenan el resto sin duplicar", async () => {
    reloj("2026-06-30T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    for (let i = 0; i < 90; i += 1) {
      const inicio = new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString().slice(0, 10);
      const fin = new Date(Date.UTC(2026, 0, 2 + i * 2)).toISOString().slice(0, 10);
      f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio, fin });
    }

    await barrerLimpiezaPendiente(f.ejecutor, { limitePorPropiedad: 40 });
    await barrerLimpiezaPendiente(f.ejecutor, { limitePorPropiedad: 40 });
    await barrerLimpiezaPendiente(f.ejecutor, { limitePorPropiedad: 40 });
    const cuarta = await barrerLimpiezaPendiente(f.ejecutor, { limitePorPropiedad: 40 });

    expect(f.listTareas()).toHaveLength(90);
    expect(cuarta.tareasCreadas).toHaveLength(0);
  });
});

describe("aislamiento por reserva: una fila venenosa no tumba al resto ni aborta la transaccion", () => {
  it("si la tarea de una unidad falla con un error de Postgres, las demas se crean y la sesion sigue utilizable", async () => {
    reloj("2026-06-30T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    const venenosa = f.crearUnidad(1);
    f.seedOcupacionConfirmada({ unidadId: venenosa.id, inicio: "2026-06-01", fin: "2026-06-03" });
    f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio: "2026-06-05", fin: "2026-06-08" });

    let abortada = false;
    const ejecutor: EjecutorTransaccional = {
      exec: async (sql: string) => {
        const n = sql.trim().toLowerCase();
        if (n.startsWith("rollback to savepoint")) abortada = false;
        else if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        return f.ejecutor.exec(sql);
      },
      query: async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        if (/insert into rentas\.tarea_operativa/i.test(sql) && (params ?? []).includes(venenosa.id)) {
          abortada = true;
          throw Object.assign(new Error("check violation"), { code: "23514" });
        }
        return f.ejecutor.query<T>(sql, params);
      },
    };

    const r = await barrerLimpiezaPendiente(ejecutor);

    expect(r.fallidos).toBe(1);
    expect(r.tareasCreadas).toHaveLength(1);
    expect(f.listTareas().map((t) => t.unidadId)).toEqual([f.unidad.id]);
    expect(abortada).toBe(false);
  });
});

describe("buffer de calendario el dia del checkout", () => {
  it("no crea el buffer de una tarea cuyo checkout aun no llega y SI el dia en que llega", async () => {
    const f = await crearFixtureLimpieza();
    const { id } = f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio: "2026-06-01", fin: "2026-06-05" });
    // La tarea nace "al confirmar" (aqui sembrada directo), con su checkout en el futuro.
    const creada = await crearTareaLimpiezaPorCheckout(f.ejecutor, { unidadId: f.unidad.id, ocupacionUnidadId: id, fechaCheckout: "2026-06-05", conBuffer: false });

    reloj("2026-06-04T18:00:00.000Z");
    const antes = await barrerLimpiezaPendiente(f.ejecutor);
    expect(antes.buffersCreados).toBe(0);
    expect(f.getTarea(creada.tareaId)?.bufferOcupacionId).toBeNull();

    reloj("2026-06-05T18:00:00.000Z");
    const dia = await barrerLimpiezaPendiente(f.ejecutor);
    expect(dia.buffersCreados).toBe(1);
    expect(f.getTarea(creada.tareaId)?.bufferOcupacionId).not.toBeNull();

    const otra = await barrerLimpiezaPendiente(f.ejecutor);
    expect(otra.buffersCreados).toBe(0);
  });

  it("con buffer configurado en 0 noches nunca crea bloqueo", async () => {
    reloj("2026-06-05T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    f.seedPropertyConfig(f.propertyId, { bufferLimpiezaNoches: 0, slaLimpiezaHoras: 4, slaMantenimientoHoras: 24 });
    const { id } = f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio: "2026-06-01", fin: "2026-06-05" });
    await crearTareaLimpiezaPorCheckout(f.ejecutor, { unidadId: f.unidad.id, ocupacionUnidadId: id, fechaCheckout: "2026-06-05", conBuffer: false });

    const r = await barrerLimpiezaPendiente(f.ejecutor);

    expect(r.buffersCreados).toBe(0);
  });
});

describe("tareas huerfanas o desfasadas", () => {
  it("reprograma una tarea cuya reserva cambio de fecha por un camino que no paso por el gancho (conserva responsable)", async () => {
    reloj("2026-06-02T18:00:00.000Z");
    const f = await crearFixtureLimpieza();
    const { id } = f.seedOcupacionConfirmada({ unidadId: f.unidad.id, inicio: "2026-06-10", fin: "2026-06-14" });
    f.seedResponsablePorOmision(f.unidad.id, "00000000-0000-0000-0000-0000000000bb");
    const creada = await crearTareaLimpiezaPorCheckout(f.ejecutor, { unidadId: f.unidad.id, ocupacionUnidadId: id, fechaCheckout: "2026-06-14", conBuffer: false });
    // Cambio de fechas "por fuera" del motor (p. ej. un UPDATE de otra ruta de escritura).
    f.moverSalidaPorFuera(id, "2026-06-16");

    const r = await barrerLimpiezaPendiente(f.ejecutor);

    expect(r.tareasReprogramadas).toBe(1);
    expect(f.getTarea(creada.tareaId)?.programadaPara).toBe("2026-06-16");
    expect(f.getTarea(creada.tareaId)?.asignadoA).toBe("00000000-0000-0000-0000-0000000000bb");
  });
});

describe("aviso de manana sin responsable (solo desde el barrido)", () => {
  async function conTareaManana(iso: string, opciones: { asignada?: boolean; zona?: string } = {}) {
    reloj(iso);
    const f = await crearFixtureLimpieza();
    if (opciones.zona) f.seedZonaHoraria(f.propertyId, opciones.zona);
    const { tareaId } = await crearTareaOperativaManual(f.ejecutor, { unidadId: f.unidad.id, tipo: "limpieza", programadaPara: "2026-06-11" });
    // las manuales no tienen reserva: el aviso aplica a cualquier tarea de limpieza pendiente sin responsable
    if (opciones.asignada) {
      const t = f.getTarea(tareaId)!;
      t.asignadoA = "00000000-0000-0000-0000-0000000000bb";
      t.estado = "asignada";
    }
    return { f, tareaId };
  }

  it("a las 18:00 locales lista la propiedad con tareas de manana sin responsable", async () => {
    // 2026-06-11 00:00Z = 2026-06-10 18:00 en CDMX.
    const { f } = await conTareaManana("2026-06-11T00:00:00.000Z");
    const r = await barrerLimpiezaPendiente(f.ejecutor);
    expect(r.sinAsignarManana).toEqual([{ organizationId: f.organizationId, propertyId: f.propertyId, fecha: "2026-06-11", cantidad: 1 }]);
  });

  it("antes de las 18:00 locales no avisa", async () => {
    // 2026-06-10 23:59Z = 17:59 CDMX.
    const { f } = await conTareaManana("2026-06-10T23:59:00.000Z");
    const r = await barrerLimpiezaPendiente(f.ejecutor);
    expect(r.sinAsignarManana).toEqual([]);
  });

  it("usa la hora de la propiedad: 18:30 en Cancun son las 17:30 en CDMX", async () => {
    // 2026-06-10T23:30Z = 18:30 Cancun (UTC-5).
    const { f } = await conTareaManana("2026-06-10T23:30:00.000Z", { zona: "America/Cancun" });
    const r = await barrerLimpiezaPendiente(f.ejecutor);
    expect(r.sinAsignarManana).toHaveLength(1);
  });

  it("una tarea con responsable no se avisa", async () => {
    const { f } = await conTareaManana("2026-06-11T00:00:00.000Z", { asignada: true });
    const r = await barrerLimpiezaPendiente(f.ejecutor);
    expect(r.sinAsignarManana).toEqual([]);
  });

  it("una tarea de pasado manana o de hoy no se avisa", async () => {
    reloj("2026-06-11T00:00:00.000Z");
    const f = await crearFixtureLimpieza();
    await crearTareaOperativaManual(f.ejecutor, { unidadId: f.unidad.id, tipo: "limpieza", programadaPara: "2026-06-10" });
    await crearTareaOperativaManual(f.ejecutor, { unidadId: f.unidad.id, tipo: "limpieza", programadaPara: "2026-06-12" });
    const r = await barrerLimpiezaPendiente(f.ejecutor);
    expect(r.sinAsignarManana).toEqual([]);
  });
});

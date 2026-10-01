import { describe, expect, it } from "vitest";
import { calcularCobertura, calcularEscalacion, turnosVigentes, validarTurnos, ConversacionesValidacionError } from "../src/index.ts";
import type { TurnoPersonal } from "../src/index.ts";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";

// PM: doble turno dentro de 12 pm - 1 am. Turno 1 12:00-18:00, Turno 2 18:00-01:00 (cruza la medianoche).
const T1: TurnoPersonal = { id: "t1", nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [{ userId: U1, nombre: "Ana", orden: 1 }, { userId: U2, nombre: "Beto", orden: 2 }] };
const T2: TurnoPersonal = { id: "t2", nombre: "Turno 2", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "18:00", termina: "01:00", miembros: [{ userId: U3, nombre: "Carla", orden: 1 }] };
const ZONA = "America/Mexico_City"; // UTC-6 todo el ano (sin horario de verano desde 2022)

// 30-sep-2026 es miercoles. 14:00 hora del centro = 20:00Z.
const a = (hhmmLocal: string, dia = "2026-09-30") => new Date(`${dia}T${hhmmLocal}:00-06:00`);

describe("cobertura por turnos (zona horaria del negocio, nunca la del proceso)", () => {
  it("a las 14:00 locales esta de guardia el turno 1 con principal primero y respaldo despues", () => {
    const c = calcularCobertura([T1, T2], a("14:00"), ZONA);
    expect(c.turnosVigentes.map((t) => t.id)).toEqual(["t1"]);
    expect(c.guardia.map((g) => g.nombre)).toEqual(["Ana", "Beto"]);
    expect(c.sinCobertura).toBe(false);
  });

  it("a las 00:30 locales sigue de guardia el turno 2 que empezo ayer y cruza la medianoche", () => {
    const c = calcularCobertura([T1, T2], a("00:30", "2026-10-01"), ZONA);
    expect(c.turnosVigentes.map((t) => t.id)).toEqual(["t2"]);
    expect(c.guardia.map((g) => g.nombre)).toEqual(["Carla"]);
  });

  it("a las 03:00 locales no hay turno vigente: sin cobertura", () => {
    const c = calcularCobertura([T1, T2], a("03:00", "2026-10-01"), ZONA);
    expect(c.turnosVigentes).toEqual([]);
    expect(c.sinCobertura).toBe(true);
  });

  it("la hora local manda: 20:00Z es 14:00 en Merida/CDMX pero 20:00 en UTC (turno 2)", () => {
    const instante = new Date("2026-09-30T20:00:00Z");
    expect(turnosVigentes([T1, T2], instante, ZONA).map((t) => t.id)).toEqual(["t1"]);
    expect(turnosVigentes([T1, T2], instante, "UTC").map((t) => t.id)).toEqual(["t2"]);
  });

  it("un turno sin miembros no da cobertura aunque este vigente", () => {
    const vacio: TurnoPersonal = { ...T1, miembros: [] };
    expect(calcularCobertura([vacio], a("14:00"), ZONA).sinCobertura).toBe(true);
  });

  it("dos turnos vigentes a la vez (traslape) no duplican a una persona", () => {
    const traslape: TurnoPersonal = { ...T2, id: "t3", nombre: "Refuerzo", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "13:00", termina: "19:00", miembros: [{ userId: U1, nombre: "Ana", orden: 1 }] };
    const c = calcularCobertura([T1, traslape], a("14:00"), ZONA);
    expect(c.guardia.filter((g) => g.userId === U1)).toHaveLength(1);
  });
});

describe("escalacion de una toma pendiente", () => {
  const cobertura = calcularCobertura([T1, T2], a("14:00"), ZONA);
  const solicitada = a("14:00").toISOString();
  const en = (min: number) => new Date(a("14:00").getTime() + min * 60000);

  it("0-4 min: avisa solo al principal", () => {
    const e = calcularEscalacion({ estado: "pendiente", solicitadaAt: solicitada }, cobertura, en(3))!;
    expect(e.nivel).toBe(0);
    expect(e.destinatarios.map((d) => d.nombre)).toEqual(["Ana"]);
    expect(e.avisarAdministracion).toBe(false);
  });

  it("5-9 min: suma al respaldo", () => {
    const e = calcularEscalacion({ estado: "pendiente", solicitadaAt: solicitada }, cobertura, en(5))!;
    expect(e.nivel).toBe(1);
    expect(e.destinatarios.map((d) => d.nombre)).toEqual(["Ana", "Beto"]);
  });

  it(">=10 min: suma a administracion", () => {
    const e = calcularEscalacion({ estado: "pendiente", solicitadaAt: solicitada }, cobertura, en(10))!;
    expect(e.nivel).toBe(2);
    expect(e.avisarAdministracion).toBe(true);
    expect(e.minutosEspera).toBe(10);
  });

  it("sin personal de guardia salta directo a administracion", () => {
    const sin = calcularCobertura([T1], a("03:00", "2026-10-01"), ZONA);
    const e = calcularEscalacion({ estado: "pendiente", solicitadaAt: a("03:00", "2026-10-01").toISOString() }, sin, a("03:00", "2026-10-01"))!;
    expect(e.nivel).toBe(2);
    expect(e.sinCobertura).toBe(true);
  });

  it("una toma tomada, devuelta o cerrada no escala", () => {
    for (const estado of ["tomada", "devuelta", "cerrada", "agente"]) {
      expect(calcularEscalacion({ estado, solicitadaAt: solicitada }, cobertura, en(30))).toBeNull();
    }
  });
});

describe("validarTurnos", () => {
  const ok = { nombre: " Turno 1 ", dias: [3, 1], inicia: "12:00", termina: "01:00", miembros: [{ userId: U1 }] };

  it("normaliza nombre, ordena dias y asigna orden 1..n si falta", () => {
    expect(validarTurnos([ok])).toEqual([{ nombre: "Turno 1", dias: [1, 3], inicia: "12:00", termina: "01:00", miembros: [{ userId: U1, orden: 1 }] }]);
  });

  it("rechaza con mensaje accionable: inicia = termina, hora mala, dia fuera de rango, repetidos, mas de 4 turnos", () => {
    const casos: Array<[unknown, RegExp]> = [
      [{ ...ok, termina: "12:00" }, /iguales/],
      [{ ...ok, inicia: "25:00" }, /inicia: formato HH:MM/],
      [{ ...ok, dias: [7] }, /dias/],
      [{ ...ok, dias: [1, 1] }, /dias/],
      [{ ...ok, miembros: [{ userId: U1 }, { userId: U1 }] }, /repetida/],
      [{ ...ok, miembros: [{ userId: "x" }] }, /UUID/],
      [{ ...ok, miembros: [{ userId: U1, orden: 9 }] }, /orden/],
      [{ ...ok, nombre: "" }, /nombre/],
    ];
    for (const [t, re] of casos) expect(() => validarTurnos([t])).toThrow(re);
    expect(() => validarTurnos([ok, { ...ok, nombre: "Turno 1" }])).toThrow(/repetido/);
    expect(() => validarTurnos(Array.from({ length: 5 }, (_, i) => ({ ...ok, nombre: `T${i}` })))).toThrow(ConversacionesValidacionError);
    expect(() => validarTurnos("no")).toThrow(/arreglo/);
  });
});

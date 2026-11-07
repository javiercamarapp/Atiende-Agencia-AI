// Modo simple del horario: conversion pura entre turnos (modelo 023) y una fila por dia. Ida y vuelta sin perder nada, y los casos
// que NO caben en simple (dos turnos el mismo dia, «ultimo pedido») se reportan para quedarse en Avanzado.
import { describe, expect, it } from "vitest";
import { aHorarioSimple, conDia, copiarATodos, cruzaMedianoche, desdeHorarioSimple, diasInvalidos, DIA_SIMPLE_POR_OMISION } from "../src/verticals/restaurantes/lib/horario-simple.ts";
import type { HorarioSimple } from "../src/verticals/restaurantes/lib/horario-simple.ts";
import type { TurnoHorario } from "../src/verticals/restaurantes/lib/modelo-pm-client.ts";

const leer = (turnos: readonly TurnoHorario[]): HorarioSimple => {
  const r = aHorarioSimple(turnos);
  if (!r.ok) throw new Error(r.motivo);
  return r.horario;
};

describe("aHorarioSimple", () => {
  it("sin turnos (sin limite): 7 dias cerrados con las horas sugeridas, y de vuelta [] tal cual", () => {
    const h = leer([]);
    expect(h).toHaveLength(7);
    expect(h.every((d) => !d.abierto && d.abre === DIA_SIMPLE_POR_OMISION.abre)).toBe(true);
    expect(desdeHorarioSimple(h)).toEqual([]);
  });

  it("un turno por dia, incluso pasada la medianoche, cabe en simple", () => {
    const h = leer([
      { dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "23:00" },
      { dias: [6, 0], abre: "13:00", cierra: "01:00" },
    ]);
    expect(h[1]).toEqual({ abierto: true, abre: "12:00", cierra: "23:00" });
    expect(h[0]).toEqual({ abierto: true, abre: "13:00", cierra: "01:00" });
    expect(cruzaMedianoche(h[0]!)).toBe(true);
    expect(cruzaMedianoche(h[1]!)).toBe(false);
  });

  it("dos turnos el mismo dia (doble turno) no cabe: se queda en Avanzado", () => {
    expect(aHorarioSimple([{ dias: [1], abre: "08:00", cierra: "12:00" }, { dias: [1, 2], abre: "18:00", cierra: "23:00" }])).toEqual({ ok: false, motivo: "variosTurnosPorDia" });
  });

  it("un «ultimo pedido» propio no cabe: simple lo perderia", () => {
    expect(aHorarioSimple([{ dias: [1], abre: "12:00", cierra: "23:00", ultimoPedidoRecoger: "22:30" }])).toEqual({ ok: false, motivo: "ultimoPedido" });
    expect(aHorarioSimple([{ dias: [1], abre: "12:00", cierra: "23:00", ultimoPedidoDomicilio: "22:00" }])).toEqual({ ok: false, motivo: "ultimoPedido" });
  });

  it("ignora dias fuera de 0..6 en vez de romper", () => {
    expect(leer([{ dias: [7, -1, 3], abre: "09:00", cierra: "17:00" }]).filter((d) => d.abierto)).toHaveLength(1);
  });
});

describe("desdeHorarioSimple", () => {
  it("junta los dias con las mismas horas en un turno, ordenados, y la ida y vuelta conserva los turnos", () => {
    const turnos: TurnoHorario[] = [
      { dias: [0, 6], abre: "13:00", cierra: "01:00" },
      { dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "23:00" },
    ];
    expect(desdeHorarioSimple(leer(turnos))).toEqual(turnos);
  });

  it("ida y vuelta: simple -> turnos -> simple da lo mismo en los dias abiertos", () => {
    let h = leer([]);
    h = conDia(h, 1, { abierto: true, abre: "09:00", cierra: "18:00" });
    h = conDia(h, 3, { abierto: true, abre: "09:00", cierra: "18:00" });
    h = conDia(h, 5, { abierto: true, abre: "10:00", cierra: "02:00" });
    const turnos = desdeHorarioSimple(h);
    expect(turnos).toEqual([
      { dias: [1, 3], abre: "09:00", cierra: "18:00" },
      { dias: [5], abre: "10:00", cierra: "02:00" },
    ]);
    expect(leer(turnos).map((d) => d.abierto)).toEqual(h.map((d) => d.abierto));
    expect(leer(turnos)[5]).toEqual(h[5]);
  });
});

describe("ayudas del editor", () => {
  it("copiarATodos replica el dia elegido en la semana; conDia no toca los demas", () => {
    const h = conDia(leer([]), 1, { abierto: true, abre: "08:00", cierra: "16:00" });
    expect(h[2]).toEqual(DIA_SIMPLE_POR_OMISION);
    const todos = copiarATodos(h, 1);
    expect(todos.every((d) => d.abierto && d.abre === "08:00" && d.cierra === "16:00")).toBe(true);
    expect(desdeHorarioSimple(todos)).toEqual([{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "08:00", cierra: "16:00" }]);
    expect(copiarATodos(h, 9)).toBe(h);
  });

  it("diasInvalidos: abierto sin hora o con apertura igual al cierre; un dia cerrado nunca es invalido", () => {
    let h = leer([]);
    h = conDia(h, 1, { abierto: true, abre: "10:00", cierra: "10:00" });
    h = conDia(h, 2, { abierto: true, abre: "", cierra: "18:00" });
    h = conDia(h, 3, { abierto: false, abre: "10:00", cierra: "10:00" });
    expect(diasInvalidos(h)).toEqual([1, 2]);
  });
});

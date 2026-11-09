// Urgencia de aprobacion (logica pura traida de src/lib/pedidos-cola.ts del repo suelto), sobre las solicitudes del autopiloto.
import { describe, expect, it } from "vitest";
import { POR_APROBAR_URGENTE_MIN, esPorAprobarUrgente, minutosPorAprobar, ordenarPorAprobar, resumenPorAprobar } from "../src/verticals/restaurantes/lib/pedidos-por-aprobar.ts";

const AHORA = Date.parse("2026-11-07T20:00:00.000Z");
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const sol = (id: string, min: number, escaladaAt: string | null = null) => ({ id, solicitadaAt: hace(min), escaladaAt });

describe("minutosPorAprobar", () => {
  it("cuenta minutos completos, nunca negativos, y 0 con fecha ilegible", () => {
    expect(minutosPorAprobar(sol("a", 12.9), AHORA)).toBe(12);
    expect(minutosPorAprobar({ solicitadaAt: new Date(AHORA + 60_000).toISOString() }, AHORA)).toBe(0);
    expect(minutosPorAprobar({ solicitadaAt: "no-es-fecha" }, AHORA)).toBe(0);
  });
});

describe("esPorAprobarUrgente", () => {
  it("sin umbral de la sucursal usa el del original (30 min)", () => {
    expect(POR_APROBAR_URGENTE_MIN).toBe(30);
    expect(esPorAprobarUrgente(sol("a", 29), AHORA)).toBe(false);
    expect(esPorAprobarUrgente(sol("a", 30), AHORA)).toBe(true);
  });

  it("con el umbral de la sucursal (aprobacionMinutos) manda ese", () => {
    expect(esPorAprobarUrgente(sol("a", 10), AHORA, 10)).toBe(true);
    expect(esPorAprobarUrgente(sol("a", 9), AHORA, 10)).toBe(false);
    expect(esPorAprobarUrgente(sol("a", 29), AHORA, 0)).toBe(false); // umbral invalido -> el del original
  });

  it("ya escalada al dueno = urgente aunque sea reciente", () => {
    expect(esPorAprobarUrgente(sol("a", 1, hace(0)), AHORA, 10)).toBe(true);
  });
});

describe("ordenarPorAprobar", () => {
  it("urgentes primero, la mas vieja arriba en cada grupo; no muta la entrada", () => {
    const lista = [sol("nueva", 2), sol("urgente-reciente", 15), sol("media", 5), sol("urgente-vieja", 40)];
    const copia = [...lista];
    expect(ordenarPorAprobar(lista, AHORA, 10).map((s) => s.id)).toEqual(["urgente-vieja", "urgente-reciente", "media", "nueva"]);
    expect(lista).toEqual(copia);
  });
});

describe("resumenPorAprobar", () => {
  it("total, urgentes y minutos de la mas antigua", () => {
    expect(resumenPorAprobar([sol("a", 3), sol("b", 45), sol("c", 1, hace(0))], AHORA)).toEqual({ total: 3, urgentes: 2, masAntiguaMin: 45 });
    expect(resumenPorAprobar([], AHORA)).toEqual({ total: 0, urgentes: 0, masAntiguaMin: 0 });
  });
});

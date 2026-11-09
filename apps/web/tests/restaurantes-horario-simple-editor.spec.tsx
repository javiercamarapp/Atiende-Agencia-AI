// @vitest-environment jsdom
//
// <HorarioSimple />: si el horario no cabe en una fila por dia (doble turno, «ultimo pedido») el modo Simple queda deshabilitado con
// el motivo y no se pinta ninguna fila (nada se pierde); «Aplicar a todos los dias» copia el lunes a la semana en un solo turno.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HorarioSimple } from "../src/verticals/restaurantes/components/HorarioSimple.tsx";
import type { TurnoHorario } from "../src/verticals/restaurantes/lib/modelo-pm-client.ts";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function pintar(turnos: readonly TurnoHorario[], modo: "simple" | "avanzado" = "simple") {
  const onTurnos = vi.fn();
  const onModo = vi.fn();
  act(() => {
    rendered = renderComponent(<HorarioSimple modo={modo} onModo={onModo} turnos={turnos} onTurnos={onTurnos} idBase="h" />);
  });
  return { onTurnos, onModo };
}
const tab = (texto: string) => [...rendered!.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === texto)!;

describe("<HorarioSimple />", () => {
  it("doble turno el mismo dia: Simple deshabilitado, motivo visible y sin filas", () => {
    pintar([
      { dias: [1], abre: "08:00", cierra: "12:00" },
      { dias: [1], abre: "18:00", cierra: "23:00" },
    ]);
    expect(tab("Simple").disabled).toBe(true);
    expect(tab("Avanzado").getAttribute("aria-selected")).toBe("true");
    expect(rendered!.container.querySelector('[data-testid="horario-simple-no-cabe"]')!.textContent).toMatch(/más de un turno en un mismo día/);
    expect(rendered!.container.querySelector("li[data-dia]")).toBeNull();
  });

  it("«ultimo pedido» propio: tambien se queda en Avanzado", () => {
    pintar([{ dias: [1], abre: "12:00", cierra: "23:00", ultimoPedidoDomicilio: "22:00" }]);
    expect(tab("Simple").disabled).toBe(true);
    expect(rendered!.container.textContent).toContain("«último pedido»");
  });

  it("modo avanzado: solo el selector de modo, sin filas", () => {
    pintar([{ dias: [1], abre: "12:00", cierra: "23:00" }], "avanzado");
    expect(tab("Simple").disabled).toBe(false);
    expect(rendered!.container.querySelector("li[data-dia]")).toBeNull();
  });

  it("filas de lunes a domingo; Aplicar a todos copia el lunes y apertura = cierre se marca invalido", () => {
    const { onTurnos } = pintar([
      { dias: [1], abre: "09:00", cierra: "18:00" },
      { dias: [2], abre: "10:00", cierra: "10:00" },
    ]);
    expect([...rendered!.container.querySelectorAll("li[data-dia]")].map((l) => l.getAttribute("data-dia"))).toEqual(["1", "2", "3", "4", "5", "6", "0"]);
    expect(rendered!.container.textContent).toContain("La apertura y el cierre no pueden ser iguales.");
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Aplicar a todos los días")!);
    expect(onTurnos).toHaveBeenLastCalledWith([{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "09:00", cierra: "18:00" }]);
  });
});

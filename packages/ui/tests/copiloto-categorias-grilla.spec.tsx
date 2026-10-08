// @vitest-environment jsdom
//
// Tarjetas de la portada del Copiloto ("Consulta"): con 3, 4 o 5 categorias quedan en una cuadricula auto-fit de una fila en
// escritorio (2 columnas en tablet, 1 en movil), todas de la MISMA altura (`items-stretch` + `auto-rows-fr` + `h-full`), con
// relleno y tipografia identicos y cada pregunta con altura minima uniforme. El orden es el de la config (VENTAS, OPERACION,
// CLIENTES, CFO). En jsdom no hay layout: se afirma la estructura y las clases que lo producen.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotoCategorias } from "../src/components/copiloto/CopilotoCategorias";
import { limpiarDom, montar, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const TODAS = [
  { titulo: "Ventas", preguntas: ["¿Cuánto vendí por día?", "¿Cuál es mi ticket medio?", "¿Cuánto vendió cada sucursal?"] },
  { titulo: "Operación", preguntas: ["¿Cuántos pedidos por canal?", "¿A qué horas tengo más pedidos?", "¿Cuáles son mis productos más vendidos este mes en todas las sucursales?"] },
  { titulo: "Clientes", preguntas: ["¿Cuántos clientes recurrentes?", "¿Qué promociones tengo activas?"] },
  { titulo: "CFO", preguntas: ["¿Qué es lo más importante esta semana?", "¿Cómo va mi estado de resultados?", "¿Qué sucursal vende menos?", "¿Qué porcentaje de clientes son frecuentes?", "¿Cuánto me cuesta el agente por pedido?"] },
  { titulo: "Marketing", preguntas: ["¿Qué campaña funcionó mejor?"] },
] as const;

function pintar(n: number, compacta = false) {
  montado = montar(<CopilotoCategorias id="cats" categorias={TODAS.slice(0, n)} onElegir={() => undefined} compacta={compacta} />);
  const grilla = montado.container.querySelector<HTMLElement>('[data-testid="copiloto-categorias"]')!;
  const tarjetas = [...montado.container.querySelectorAll<HTMLElement>('[data-testid="copiloto-categoria"]')];
  return { grilla, tarjetas };
}

describe("CopilotoCategorias: grilla de tarjetas parejas", () => {
  it.each([3, 4, 5])("con %i tarjetas: auto-fit, filas e items estirados y cada tarjeta a la altura completa", (n) => {
    const { grilla, tarjetas } = pintar(n);
    expect(tarjetas).toHaveLength(n);
    const clases = grilla.className;
    expect(clases).toContain("grid");
    expect(clases).toContain("items-stretch");
    expect(clases).toContain("sm:auto-rows-fr");
    expect(clases).toContain("grid-cols-1");
    expect(clases).toContain("sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]");
    for (const t of tarjetas) {
      // Misma altura (h-full dentro de filas iguales), mismo relleno y estructura en columna.
      expect(t.className).toContain("h-full");
      expect(t.className).toContain("flex-col");
      expect(t.className).toContain("p-4");
      expect(t.className).toContain("min-w-0");
    }
    // Relleno y tipografia consistentes: las clases de todas las tarjetas son identicas.
    expect(new Set(tarjetas.map((t) => t.className)).size).toBe(1);
  });

  it("con 4 tarjetas el orden es VENTAS, OPERACIÓN, CLIENTES, CFO (CFO es la cuarta, no una segunda fila aparte)", () => {
    const { tarjetas } = pintar(4);
    expect(tarjetas.map((t) => t.querySelector("p")?.textContent)).toEqual(["Ventas", "Operación", "Clientes", "CFO"]);
    expect(tarjetas.map((t) => t.getAttribute("aria-label"))).toEqual(["Ventas", "Operación", "Clientes", "CFO"]);
  });

  it("cada pregunta es un boton con altura minima uniforme, separadas por una linea fina y sin desborde", () => {
    const { tarjetas } = pintar(4);
    const botones = tarjetas.flatMap((t) => [...t.querySelectorAll<HTMLButtonElement>("button")]);
    expect(botones).toHaveLength(3 + 3 + 2 + 5);
    for (const b of botones) {
      expect(b.className).toContain("min-h-10");
      expect(b.className).toContain("w-full");
      expect(b.className).toContain("text-left");
      expect(b.className).toContain("leading-snug");
    }
    const filas = tarjetas.flatMap((t) => [...t.querySelectorAll<HTMLElement>('[data-testid="copiloto-pregunta"]')]);
    expect(filas).toHaveLength(botones.length);
    for (const f of filas) expect(f.className).toContain("border-t");
  });

  it("elegir una pregunta la manda al callback", () => {
    const onElegir = vi.fn();
    montado = montar(<CopilotoCategorias id="cats" categorias={TODAS.slice(0, 4)} onElegir={onElegir} />);
    (montado.container.querySelectorAll("button")[0] as HTMLButtonElement).click();
    expect(onElegir).toHaveBeenCalledWith("¿Cuánto vendí por día?");
  });

  it("en el panel angosto (compacta) queda una sola columna", () => {
    const { grilla } = pintar(4, true);
    expect(grilla.className).toContain("grid-cols-1");
    expect(grilla.className).not.toContain("auto-fit");
  });
});

// @vitest-environment jsdom
//
// OrbeAgente: transiciones de estado, reaccion al volumen (suavizado, sin pasar por
// el estado de React) y video original solo como cargador en reposo/conectando.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODOS_ORB, OrbeAgente, volumenObjetivo } from "@atiende/ui";
import type { ModoOrb } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined); // jsdom no implementa medios
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function orbe(): HTMLElement {
  return rendered!.container.querySelector<HTMLElement>(".voz-orbe")!;
}

function frames(n: number): void {
  act(() => {
    for (let i = 0; i < n; i++) vi.advanceTimersByTime(17);
  });
}

function volumen(): number {
  return Number(orbe().dataset.volumen);
}

describe("volumenObjetivo", () => {
  it("escuchando sigue al micrófono, hablando sigue al agente y el resto no reacciona", () => {
    expect(volumenObjetivo("escuchando", 0.7, 0.2)).toBe(0.7);
    expect(volumenObjetivo("hablando", 0.7, 0.2)).toBe(0.2);
    for (const m of ["reposo", "conectando", "pensando", "error"] as ModoOrb[]) expect(volumenObjetivo(m, 0.9, 0.9)).toBe(0);
  });
});

describe("<OrbeAgente />", () => {
  it("expone cada modo en data-modo y en la etiqueta accesible", () => {
    const etiquetas: Record<ModoOrb, string> = {
      reposo: "en reposo",
      conectando: "conectando",
      escuchando: "escuchando",
      pensando: "pensando",
      hablando: "hablando",
      error: "con un error",
    };
    rendered = renderComponent(<OrbeAgente modo="reposo" />);
    for (const modo of MODOS_ORB) {
      rendered.rerender(<OrbeAgente modo={modo} />);
      expect(orbe().dataset.modo).toBe(modo);
      expect(orbe().getAttribute("aria-label")).toBe(`Agente de voz ${etiquetas[modo]}`);
    }
  });

  it("al hablar sube con el volumen de salida de forma suavizada (no salta de golpe) y nunca pasa de 1", () => {
    rendered = renderComponent(<OrbeAgente modo="hablando" volumenSalida={1} />);
    frames(1);
    const primero = volumen();
    expect(primero).toBeGreaterThan(0);
    expect(primero).toBeLessThan(1);
    frames(5);
    const despues = volumen();
    expect(despues).toBeGreaterThan(primero);
    frames(120);
    expect(volumen()).toBeGreaterThan(0.95);
    expect(volumen()).toBeLessThanOrEqual(1);
  });

  it("escuchando ignora el volumen de salida y reacciona al de entrada", () => {
    rendered = renderComponent(<OrbeAgente modo="escuchando" volumenEntrada={0} volumenSalida={1} />);
    frames(30);
    expect(volumen()).toBe(0);
    rendered.rerender(<OrbeAgente modo="escuchando" volumenEntrada={0.8} volumenSalida={1} />);
    frames(60);
    expect(volumen()).toBeGreaterThan(0.6);
  });

  it("al cambiar de hablando a pensando el nivel decae despacio hasta 0", () => {
    rendered = renderComponent(<OrbeAgente modo="hablando" volumenSalida={1} />);
    frames(60);
    const alto = volumen();
    rendered.rerender(<OrbeAgente modo="pensando" volumenSalida={1} />);
    frames(2);
    const tras2 = volumen();
    expect(tras2).toBeLessThan(alto);
    expect(tras2).toBeGreaterThan(0); // relajación lenta, no corte seco
    frames(200);
    expect(volumen()).toBe(0);
    expect(orbe().style.getPropertyValue("--vol")).toBe("0.000");
  });

  it("muestra el video original solo en reposo y conectando, y solo si se le pasa uno", () => {
    rendered = renderComponent(<OrbeAgente modo="reposo" videoSrc="/media/orbe-agente.mp4" />);
    expect(orbe().dataset.video).toBe("visible");
    expect(rendered.container.querySelector("video")?.getAttribute("src")).toBe("/media/orbe-agente.mp4");
    rendered.rerender(<OrbeAgente modo="conectando" videoSrc="/media/orbe-agente.mp4" />);
    expect(orbe().dataset.video).toBe("visible");
    for (const m of ["escuchando", "pensando", "hablando", "error"] as ModoOrb[]) {
      rendered.rerender(<OrbeAgente modo={m} videoSrc="/media/orbe-agente.mp4" />);
      expect(orbe().dataset.video).toBe("oculto");
    }
    rendered.rerender(<OrbeAgente modo="reposo" />);
    expect(rendered.container.querySelector("video")).toBeNull();
    expect(orbe().dataset.video).toBe("oculto");
  });

  it("acepta colores propios del degradado y un tamaño", () => {
    rendered = renderComponent(<OrbeAgente modo="reposo" size={120} colores={["#111111", "#222222"]} />);
    expect(orbe().style.width).toBe("120px");
    expect(orbe().style.getPropertyValue("--orbe-c1")).toBe("#111111");
    expect(orbe().style.getPropertyValue("--orbe-c2")).toBe("#222222");
  });

  it("deja de pintar al desmontarse (sin fugas de requestAnimationFrame)", () => {
    rendered = renderComponent(<OrbeAgente modo="hablando" volumenSalida={1} />);
    frames(3);
    rendered.unmount();
    rendered = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});

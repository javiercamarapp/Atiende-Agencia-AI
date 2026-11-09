// @vitest-environment jsdom
//
// «Útil / No fue útil» en las acciones de una respuesta: solo con un mensaje GUARDADO y un transporte que sabe valorar (nunca un boton
// sin backend); «No fue útil» ofrece los motivos de la lista cerrada (sin texto libre) y un fallo del servidor se dice y deja reintentar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { CopilotoAcciones } from "../src/components/copiloto/CopilotoAcciones";
import type { CopilotoMensaje, CopilotoTransporte } from "../src/components/copiloto/tipos";
import { clic, limpiarDom, montar, porEtiqueta, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
  vi.restoreAllMocks();
});

const MENSAJE: CopilotoMensaje = { id: "m2", role: "assistant", text: "Vendiste 10", status: "ok", seq: 2 };

function render(t: CopilotoTransporte, mensaje: CopilotoMensaje = MENSAJE, conversacionId: string | null = "c-1"): HTMLElement {
  montado = montar(<CopilotoAcciones mensaje={mensaje} conversacionId={conversacionId ?? undefined} transporte={t} esUltima={false} ocupado={false} onRegenerar={() => undefined} />);
  return montado.container;
}

async function esperar() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("valoracion de una respuesta", () => {
  it("sin `valorar` en el transporte, o sin mensaje guardado, no hay botones", () => {
    let c = render(transporteFalso().t);
    expect(c.querySelector('[data-testid="copiloto-valoracion"]')).toBeNull();
    montado?.unmount();
    const valorar = vi.fn(async () => undefined);
    c = render(transporteFalso({ valorar }).t, { ...MENSAJE, seq: undefined });
    expect(c.querySelector('[data-testid="copiloto-valoracion"]')).toBeNull();
    montado?.unmount();
    c = render(transporteFalso({ valorar }).t, MENSAJE, null);
    expect(c.querySelector('[data-testid="copiloto-valoracion"]')).toBeNull();
  });

  it("«Útil» manda {util:true} de ESA conversacion y seq, y queda marcado", async () => {
    const valorar = vi.fn(async () => undefined);
    const c = render(transporteFalso({ valorar }).t);
    clic(porEtiqueta(c, "Marcar la respuesta como útil"));
    await esperar();
    expect(valorar).toHaveBeenCalledWith("c-1", 2, { util: true, motivo: null });
    expect(porEtiqueta(c, "Marcar la respuesta como útil").getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelector('[data-testid="copiloto-valoracion"]')?.getAttribute("data-valoracion")).toBe("util");
    expect(c.querySelector('[data-testid="copiloto-valoracion-motivos"]')).toBeNull();
  });

  it("«No fue útil» ofrece los 4 motivos cerrados y elegir uno lo manda", async () => {
    const valorar = vi.fn(async () => undefined);
    const c = render(transporteFalso({ valorar }).t);
    clic(porEtiqueta(c, "Marcar la respuesta como no útil"));
    await esperar();
    expect(valorar).toHaveBeenLastCalledWith("c-1", 2, { util: false, motivo: null });
    const motivos = c.querySelector('[data-testid="copiloto-valoracion-motivos"]')!;
    const botones = [...motivos.querySelectorAll("button")];
    expect(botones.map((b) => b.textContent)).toEqual(["Un dato está mal", "Le faltó información", "No entendió la pregunta", "Otra cosa"]);
    expect(motivos.querySelector("input, textarea")).toBeNull();
    clic(botones[1]!);
    await esperar();
    expect(valorar).toHaveBeenLastCalledWith("c-1", 2, { util: false, motivo: "incompleta" });
    expect(botones[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("un fallo del servidor se dice y no marca nada", async () => {
    const valorar = vi.fn(async () => {
      throw new Error("503");
    });
    const c = render(transporteFalso({ valorar }).t);
    clic(porEtiqueta(c, "Marcar la respuesta como útil"));
    await esperar();
    expect(c.querySelector('[role="alert"]')?.textContent).toBe("No se pudo guardar tu valoración; intenta de nuevo.");
    expect(c.querySelector('[data-testid="copiloto-valoracion"]')?.getAttribute("data-valoracion")).toBe("");
  });
});

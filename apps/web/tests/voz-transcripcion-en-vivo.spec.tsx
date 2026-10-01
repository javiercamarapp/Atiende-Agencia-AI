// @vitest-environment jsdom
//
// TranscripcionEnVivo + TextoEscribiendose: burbujas por rol, lineas parciales con
// cursor, tecleo de la ultima linea del agente y estado vacio.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextoEscribiendose, TranscripcionEnVivo } from "@atiende/ui";
import type { LineaTranscripcion } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.useRealTimers();
});

const linea = (id: string, rol: LineaTranscripcion["rol"], texto: string, parcial = false): LineaTranscripcion => ({ id, rol, texto, parcial, ts: 0 });

// Cada letra agenda la siguiente tras renderizar, así que se avanza de a una (un `act` por paso).
function avanzar(ms: number): void {
  for (let t = 0; t < ms; t += 18) {
    act(() => {
      vi.advanceTimersByTime(18);
    });
  }
}

function burbujas(): HTMLElement[] {
  return Array.from(rendered!.container.querySelectorAll<HTMLElement>("[data-rol]"));
}

describe("<TextoEscribiendose />", () => {
  it("revela el texto letra por letra a 18 ms y se detiene al terminar (sin temporizadores vivos)", () => {
    rendered = renderComponent(<TextoEscribiendose texto="Hola" />);
    expect(rendered.container.textContent).toBe("");
    avanzar(18);
    expect(rendered.container.textContent).toBe("H");
    avanzar(18 * 3);
    expect(rendered.container.textContent).toBe("Hola");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reinicia desde la primera letra cuando cambia el texto", () => {
    rendered = renderComponent(<TextoEscribiendose texto="Uno" />);
    avanzar(18 * 3);
    expect(rendered.container.textContent).toBe("Uno");
    rendered.rerender(<TextoEscribiendose texto="Dos tres" />);
    expect(rendered.container.textContent).toBe("");
    avanzar(18 * 3);
    expect(rendered.container.textContent).toBe("Dos");
  });
});

describe("<TranscripcionEnVivo />", () => {
  it("sin líneas pinta el estado vacío que se le pase", () => {
    rendered = renderComponent(<TranscripcionEnVivo lineas={[]} vacio={<p>Aún no hay una llamada activa</p>} />);
    expect(rendered.container.textContent).toContain("Aún no hay una llamada activa");
    expect(burbujas()).toHaveLength(0);
  });

  it("pinta burbujas por rol: el agente con su marca a la izquierda, el usuario alineado a la derecha", () => {
    rendered = renderComponent(<TranscripcionEnVivo lineas={[linea("1", "usuario", "Quiero unos tacos"), linea("2", "agente", "Claro, con gusto")]} />);
    const [usuario, agente] = burbujas();
    expect(usuario!.dataset.rol).toBe("usuario");
    expect(usuario!.className).toContain("justify-end");
    expect(usuario!.querySelector("svg")).toBeNull();
    expect(usuario!.textContent).toBe("Quiero unos tacos");
    expect(agente!.querySelector("svg")).not.toBeNull();
  });

  it("una línea parcial se muestra completa tal como llega, con cursor, y sin teclearse", () => {
    rendered = renderComponent(<TranscripcionEnVivo lineas={[linea("1", "agente", "Buenas tar", true)]} />);
    const b = burbujas()[0]!;
    expect(b.dataset.parcial).toBe("true");
    expect(b.textContent).toContain("Buenas tar");
    expect(b.querySelector(".voz-cursor")).not.toBeNull();
  });

  it("la última línea definitiva del agente se teclea, pero una que ya fue parcial no se vuelve a teclear", () => {
    rendered = renderComponent(<TranscripcionEnVivo lineas={[linea("1", "agente", "Hola")]} />);
    expect(burbujas()[0]!.textContent).toBe("");
    avanzar(18 * 4);
    expect(burbujas()[0]!.textContent).toBe("Hola");

    rendered.rerender(<TranscripcionEnVivo lineas={[linea("2", "agente", "Dime", true)]} />);
    rendered.rerender(<TranscripcionEnVivo lineas={[linea("2", "agente", "Dime tu pedido", false)]} />);
    expect(burbujas()[0]!.textContent).toBe("Dime tu pedido");
    expect(burbujas()[0]!.dataset.parcial).toBe("false");
  });

  it("solo la última línea se teclea: las anteriores salen completas", () => {
    rendered = renderComponent(<TranscripcionEnVivo lineas={[linea("1", "usuario", "Hola"), linea("2", "agente", "Buen día"), linea("3", "usuario", "Dos tacos")]} />);
    expect(burbujas().map((b) => b.textContent)).toEqual(["Hola", "Buen día", "Dos tacos"]);
  });
});

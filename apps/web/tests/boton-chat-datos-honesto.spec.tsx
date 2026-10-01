// @vitest-environment jsdom
//
// F-18/B-06 del informe de diseno-ux: "Chatea con tus datos" abria un panel que
// simulaba una conversacion (caja de pregunta, "pensando...") y contestaba
// siempre con un aviso de roadmap. No hay backend de chat-con-datos, asi que el
// boton ahora dice la verdad: etiqueta "Pronto", aviso de no disponible, sin
// caja de pregunta ni respuesta simulada.
import { afterEach, describe, expect, it } from "vitest";
import { BotonChatDatos } from "../src/components/BotonChatDatos.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function boton(): HTMLButtonElement {
  return [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement;
}

describe("BotonChatDatos — honesto", () => {
  it("el boton lleva la etiqueta Pronto", () => {
    rendered = renderComponent(<BotonChatDatos />);
    expect(boton().textContent).toContain("Pronto");
  });

  it("al hacer click abre un aviso de no disponible, sin caja de pregunta ni conversacion simulada", () => {
    rendered = renderComponent(<BotonChatDatos nombreNegocio="Hotel Sol" />);
    click(boton());
    const dialogo = document.body.querySelector('[role="dialog"]');
    expect(dialogo).not.toBeNull();
    expect(dialogo!.textContent).toContain("todavía no está disponible");
    expect(dialogo!.textContent).toContain("Hotel Sol");
    expect(dialogo!.querySelector("input, textarea")).toBeNull();
    expect(dialogo!.textContent).not.toMatch(/pensando|Leyendo tu pregunta|Consulta/i);
  });

  it("Entendido cierra el aviso", () => {
    rendered = renderComponent(<BotonChatDatos />);
    click(boton());
    const entendido = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Entendido")!;
    click(entendido);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

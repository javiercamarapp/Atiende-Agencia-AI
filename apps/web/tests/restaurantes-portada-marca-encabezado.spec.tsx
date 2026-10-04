// @vitest-environment jsdom
//
// PortadaMarca: el storefront publico lleva el titular como <h1>; la vista previa dentro del panel (Configuracion > Sitio publico) usa <h2>
// porque la pantalla ya tiene su unico <h1> (la guarda e2e de "un solo h1 por pantalla" lo exige).
import { afterEach, describe, expect, it } from "vitest";
import { PortadaMarca } from "../src/verticals/restaurantes/storefront/MarcaPortada.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("PortadaMarca: nivel del titular", () => {
  it("por omision el titular es un h1 (storefront publico)", () => {
    rendered = renderComponent(<PortadaMarca nombre="Taqueria" marca={null} />);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("como vista previa del panel el titular es un h2 y no hay h1", () => {
    rendered = renderComponent(<PortadaMarca nombre="Taqueria" marca={null} encabezado="h2" />);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(0);
    expect(rendered.container.querySelector("h2")?.textContent).toBe("Pide en Taqueria");
  });
});

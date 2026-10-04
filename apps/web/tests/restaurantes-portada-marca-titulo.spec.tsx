// @vitest-environment jsdom
//
// La portada de marca es el h1 del storefront publico, pero la vista previa de Configuracion > Sitio publico la embebe dentro del panel,
// que ya tiene su h1 en la barra superior: ahi el titular debe ser h2 (un solo h1 por pantalla).
import { afterEach, describe, expect, it } from "vitest";
import { PortadaMarca } from "../src/verticals/restaurantes/storefront/MarcaPortada.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const MARCA = { titular: "Los Taquitos de PM", eslogan: null, about: null, portadaUrl: null, logoUrl: null, instagramUrl: null, facebookUrl: null, tiktokUrl: null };

describe("<PortadaMarca /> nivel del titular", () => {
  it("por omision (storefront publico) el titular es el h1", () => {
    rendered = renderComponent(<PortadaMarca nombre="PM" marca={MARCA} />);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Los Taquitos de PM");
  });

  it("como vista previa dentro del panel (nivelTitulo h2) no agrega un segundo h1", () => {
    rendered = renderComponent(<PortadaMarca nombre="PM" marca={MARCA} nivelTitulo="h2" />);
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(0);
    expect(rendered.container.querySelector("h2")!.textContent).toBe("Los Taquitos de PM");
  });
});

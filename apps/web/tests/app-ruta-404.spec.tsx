// @vitest-environment jsdom
//
// F-02 del informe de diseno-ux: <Routes> no tenia ruta `*`, asi que cualquier
// URL desconocida (incluido el `/configuracion` global que el Sidebar solia
// enlazar) dejaba la pantalla en blanco. Se monta el App real (BrowserRouter
// sobre la URL de jsdom) y se verifica el comportamiento de ruteo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { esperarRutaCargada, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

let rendered: RenderedComponent | undefined;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  window.history.pushState({}, "", "/");
});

async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  return r;
}

describe("App — ruta 404", () => {
  it.each(["/configuracion", "/no-existe", "/hoteles/demo/ruta-que-no-existe"])("%s muestra la pantalla 404 con enlace real de vuelta", async (ruta) => {
    rendered = await renderEn(ruta);
    const h1 = rendered.container.querySelector("h1");
    expect(h1?.textContent).toBe("No encontramos esta página");
    expect(rendered.container.textContent).toContain(ruta);
    const volver = [...rendered.container.querySelectorAll("a")].find((a) => a.textContent === "Ir al inicio");
    expect(volver?.getAttribute("href")).toBe("/");
  });

  it("las rutas reales siguen resolviendo a su pagina (/terminos no cae en 404)", async () => {
    rendered = await renderEn("/terminos");
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Términos de Servicio");
  });
});

// @vitest-environment jsdom
//
// F4c (5): centro de ayuda minimo. Contenido estatico por vertical + busqueda sin acentos; la pagina lo muestra y filtra.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AYUDA_POR_VERTICAL, buscarAyuda } from "../src/verticals/restaurantes/lib/ayuda-contenido.ts";
import { RestaurantesAyudaPage } from "../src/verticals/restaurantes/pages/Ayuda.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };
let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("contenido de ayuda", () => {
  const temas = AYUDA_POR_VERTICAL.restaurantes;

  it("cubre las funciones de la paridad menor y cada tema trae pasos y quien puede", () => {
    const ids = temas.map((t) => t.id);
    for (const id of ["menu-borrar", "whatsapp-tono", "voz-idiomas", "conocimiento-archivos", "equipo-roles"]) expect(ids).toContain(id);
    for (const t of temas) {
      expect(t.pasos.length).toBeGreaterThan(0);
      expect(t.roles.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no promete lo que no existe: la lectura de PDF dice que depende de activar el servicio", () => {
    const t = temas.find((x) => x.id === "conocimiento-archivos")!;
    expect(t.pasos.join(" ")).toMatch(/se activa cuando se configure/);
  });

  it("buscarAyuda ignora acentos y mayusculas, exige todos los terminos y vacio = todo", () => {
    expect(buscarAyuda(temas, "")).toHaveLength(temas.length);
    expect(buscarAyuda(temas, "INGLES").map((t) => t.id)).toContain("voz-idiomas");
    expect(buscarAyuda(temas, "inglés").map((t) => t.id)).toContain("voz-idiomas");
    expect(buscarAyuda(temas, "borrar producto").map((t) => t.id)).toContain("menu-borrar");
    expect(buscarAyuda(temas, "propina").map((t) => t.id)).toContain("whatsapp-tono");
    expect(buscarAyuda(temas, "zzzz-no-existe")).toHaveLength(0);
  });
});

describe("RestaurantesAyudaPage", () => {
  it("lista los temas y filtra al escribir; sin resultados muestra el estado vacio", async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesAyudaPage {...CTX} />
      </MemoryRouter>,
    );
    await flushMicrotasks();
    const root = rendered.container;
    expect(root.textContent).toContain("Borrar un producto del menú");
    const input = root.querySelector("input[type=search]") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const escribir = async (v: string) => {
      await act(async () => {
        setter.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flushMicrotasks();
    };
    await escribir("idioma");
    expect(root.textContent).toContain("Idiomas del agente de voz");
    expect(root.textContent).not.toContain("Borrar un producto del menú");
    await escribir("zzzz-no-existe");
    expect(root.textContent).toContain("No encontramos ese tema");
  });
});

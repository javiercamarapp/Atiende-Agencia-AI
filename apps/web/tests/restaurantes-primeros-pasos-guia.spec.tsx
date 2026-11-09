// @vitest-environment jsdom
//
// Primeros pasos de restaurantes con y sin la bandera ds3 (guía y recorrido animado). Vive en su propio archivo porque la serie
// ds3 solo agrega specs (scripts/diseno/solo-agrega-specs.sh): las aserciones de restaurantes-primeros-pasos.spec.tsx quedan intactas.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestaurantesPrimerosPasosPage } from "../src/verticals/restaurantes/pages/PrimerosPasos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Jefa", staffEmail: "j@example.com" };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const CHECKLIST = {
  items: [
    { id: "menu", titulo: "Menú por sucursal", estado: "hecho", obligatorio: true, detalle: "Todas las sucursales activas tienen menú con precios.", faltantes: [], responsable: "plataforma", pantalla: "productos" },
    { id: "coordenadas", titulo: "Coordenadas de cada sucursal", estado: "parcial", obligatorio: false, detalle: "Sin coordenadas: Pensiones.", faltantes: ["Pensiones"], responsable: "dueno", pantalla: "sucursales" },
    { id: "whatsapp", titulo: "Número de WhatsApp por sucursal", estado: "pendiente", obligatorio: false, detalle: "Ningún número conectado.", faltantes: ["Altabrisa"], responsable: "meta", pantalla: "configuracion" },
    { id: "catalogo_pos", titulo: "Catálogo de SoftRestaurant (códigos de producto)", estado: "externo", obligatorio: false, detalle: "Depende del distribuidor del POS.", faltantes: [], responsable: "distribuidor_pos", pantalla: "configuracion" },
  ],
  resumen: { hechos: 1, total: 4, obligatoriosPendientes: 0 },
  listoParaOperar: true,
  gate: { bloquea: false, obligatoriosPendientes: 0, operaConPedidos: false },
};

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("RestaurantesPrimerosPasosPage (guía ds3)", () => {
  it("con la bandera ds3: patrón /setup de Rovaq (quién lo cierra, en espera, avance propio, recomendado) y «Hacer el recorrido»", async () => {
    document.documentElement.setAttribute("data-diseno", "ds3");
    try {
      fetchMock.mockResolvedValue(json(CHECKLIST));
      rendered = renderComponent(
        <MemoryRouter>
          <RestaurantesPrimerosPasosPage {...CTX} />
        </MemoryRouter>,
      );
      await esperar();
      const t = rendered.container.textContent ?? "";
      expect(t).toContain("Listo para operar");
      expect(t).toContain("Quién lo cierra: Dueño");
      expect(t).toContain("Quién lo cierra: Meta (WhatsApp Business)");
      expect(t).toContain("En espera");
      expect(t).toContain("0 de 2 que puedes hacer ahora");
      expect(t).toContain("1 en espera");
      expect(rendered.container.querySelector('[data-guia-paso="coordenadas"]')?.hasAttribute("data-siguiente")).toBe(true);
      expect(Array.from(rendered.container.querySelectorAll("button")).some((b) => b.textContent === "Hacer el recorrido")).toBe(true);
    } finally {
      document.documentElement.removeAttribute("data-diseno");
    }
  });

  it("sin la bandera ds3: la lista de siempre y sin «Hacer el recorrido» (la guía no existe sin ds3)", async () => {
    fetchMock.mockResolvedValue(json(CHECKLIST));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    expect(rendered.container.querySelector(".guia-pp")).toBeNull();
    expect(rendered.container.textContent).not.toContain("Hacer el recorrido");
  });
});

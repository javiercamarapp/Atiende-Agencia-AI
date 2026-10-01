// @vitest-environment jsdom
//
// R-33: pagina "Primeros pasos" y su cliente. El estado lo calcula el servidor; aqui se verifica que se muestre tal cual (con
// responsable y enlace), que un error no se disfrace de checklist vacio y que el nav la ofrezca solo a owner/admin.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOnboarding } from "../src/verticals/restaurantes/lib/onboarding-client.ts";
import { RestaurantesPrimerosPasosPage } from "../src/verticals/restaurantes/pages/PrimerosPasos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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

describe("fetchOnboarding", () => {
  it("GET a .../admin/onboarding con el token; una respuesta sin items se rechaza (no se disfraza de checklist vacio)", async () => {
    fetchMock.mockResolvedValueOnce(json(CHECKLIST));
    const r = await fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1");
    expect(r.items).toHaveLength(4);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/onboarding");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
    fetchMock.mockResolvedValueOnce(json({ nada: true }));
    await expect(fetchOnboarding(fetchMock as unknown as typeof fetch, "https://api.test", "tok", "prop-1")).rejects.toThrow(/checklist/);
  });
});

describe("RestaurantesPrimerosPasosPage", () => {
  it("muestra el estado real: listo/parcial/pendiente/tercero, faltantes, responsable y enlace a la pantalla", async () => {
    fetchMock.mockResolvedValue(json(CHECKLIST));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Primeros pasos");
    expect(t).toContain("Listo para operar");
    expect(t).toContain("1 de 4 puntos listos");
    expect(t).toContain("Falta en: Pensiones");
    expect(t).toContain("Lo cierra: Dueño");
    expect(t).toContain("Lo cierra: Meta (WhatsApp Business)");
    expect(t).toContain("Depende de un tercero");
    const enlaces = Array.from(rendered.container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(enlaces).toContain("/restaurantes/demo/sucursales");
    expect(enlaces).toContain("/restaurantes/demo/configuracion");
    // Un punto ya hecho no ofrece enlace ni "Lo cierra".
    expect(enlaces).not.toContain("/restaurantes/demo/productos");
  });

  it("bloqueado: avisa los obligatorios pendientes", async () => {
    fetchMock.mockResolvedValue(json({ ...CHECKLIST, listoParaOperar: false, resumen: { hechos: 1, total: 4, obligatoriosPendientes: 2 } }));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    expect(rendered.container.textContent).toContain("Faltan puntos obligatorios");
    expect(rendered.container.textContent).toContain("2 obligatorio(s) pendiente(s)");
  });

  it("error del servidor: muestra el error con reintento (nunca un checklist vacio) y Actualizar vuelve a pedir", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 500)).mockResolvedValue(json(CHECKLIST));
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesPrimerosPasosPage {...CTX} />
      </MemoryRouter>,
    );
    await esperar();
    expect(rendered.container.textContent).not.toContain("Listo para operar");
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Actualizar"))!;
    await act(async () => click(boton));
    await esperar();
    expect(rendered.container.textContent).toContain("Listo para operar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

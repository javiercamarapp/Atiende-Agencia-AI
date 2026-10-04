// @vitest-environment jsdom
// H-42 -- tarjeta del KPI de room-nights directas: datos del servidor, vacio, "no disponible aun" (sin migracion) y error con reintento.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomNightsDirectasCard } from "../src/verticals/hoteles/pages/RoomNightsDirectasCard.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
async function montar(respuesta: Response) {
  const fetchMock = vi.fn(async () => respuesta);
  vi.stubGlobal("fetch", fetchMock);
  rendered = renderComponent(<RoomNightsDirectasCard apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return fetchMock;
}
const BASE = { desde: "2026-10-01", hasta: "2026-11-01" };

describe("RoomNightsDirectasCard", () => {
  it("muestra el porcentaje y las noches reales del servidor", async () => {
    const f = await montar(json({ disponible: true, ...BASE, directas: 12, total: 40, porcentaje: 0.3 }));
    expect((f.mock.calls as unknown[][])[0]![0]).toBe("http://api.local/hoteles/prop-1/revenue/room-nights-directas");
    expect(rendered!.container.textContent).toContain("30.0%");
    expect(rendered!.container.textContent).toContain("12 de 40 noches");
  });
  it("sin noches reservadas muestra el vacio honesto", async () => {
    await montar(json({ disponible: true, ...BASE, directas: 0, total: 0, porcentaje: null }));
    expect(rendered!.container.textContent).toContain("Sin noches reservadas");
  });
  it("sin la migracion (disponible:false) muestra 'No disponible aun', nunca un 0%", async () => {
    await montar(json({ disponible: false, ...BASE, directas: 0, total: 0, porcentaje: null }));
    expect(rendered!.container.textContent).toContain("No disponible aún");
    expect(rendered!.container.textContent).not.toContain("0.0%");
  });
  it("un error del servidor muestra el estado de error", async () => {
    await montar(json({ message: "boom" }, 500));
    expect(rendered!.container.textContent).toContain("No se pudo cargar");
  });
});

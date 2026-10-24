// @vitest-environment jsdom
//
// Historial (paridad con el original): chips de periodo, sucursal, «Incidencias / no entregados» y busqueda por cliente o telefono. Cada chip
// manda su parametro real al API (periodo = dateFrom, sucursal = branchId, incidencias=1, q) y conserva Estado/Desde/Hasta.
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HistorialPage } from "../src/verticals/restaurantes/pages/Historial.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
const CTX = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Sam", staffEmail: "s@example.com" } as RestaurantesShellContext;
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const SUCURSALES = [
  { propertyId: "prop-1", name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: null, lng: null },
  { propertyId: "prop-2", name: "Norte", slug: "norte", status: "active", phone: null, address: null, lat: null, lng: null },
];
async function esperar(ms = 0) {
  await act(async () => {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
function montar(sucursales: unknown = SUCURSALES) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/admin/sucursales")) return sucursales === null ? ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response) : json({ branches: sucursales });
      urls.push(url);
      return json({ orders: [], nextCursor: null });
    }),
  );
  rendered = renderComponent(<HistorialPage {...CTX} />);
  return urls;
}
const porEtiqueta = (e: string) => rendered!.container.querySelector(`[aria-label="${e}"]`) as HTMLElement;
const ultima = (urls: string[]) => new URL(urls[urls.length - 1]!);

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("Historial: chips de filtro", () => {
  it("incidencias: alterna aria-pressed y manda incidencias=1; al apagarlo deja de mandarlo", async () => {
    const urls = montar();
    await esperar();
    const chip = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Incidencias / no entregados"))!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    click(chip);
    await esperar();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(ultima(urls).searchParams.get("incidencias")).toBe("1");
    click(chip);
    await esperar();
    expect(ultima(urls).searchParams.has("incidencias")).toBe(false);
  });

  it("busqueda: con pausa y solo desde 2 caracteres; limpiar quita q", async () => {
    const urls = montar();
    await esperar();
    const entrada = porEtiqueta("Buscar por cliente o teléfono") as HTMLInputElement;
    const antes = urls.length;
    changeValue(entrada, "m");
    await esperar(450);
    expect(urls.length).toBe(antes);
    changeValue(entrada, "mari");
    await esperar(450);
    expect(ultima(urls).searchParams.get("q")).toBe("mari");
    changeValue(entrada, "");
    await esperar(450);
    expect(ultima(urls).searchParams.has("q")).toBe(false);
  });

  it("periodo: «Últimos 7 días» fija dateFrom y «Todo el historial» lo quita", async () => {
    const urls = montar();
    await esperar();
    elegirValor(porEtiqueta("Periodo"), "7");
    await esperar();
    expect(ultima(urls).searchParams.get("dateFrom")).toBeTruthy();
    elegirValor(porEtiqueta("Periodo"), "todo");
    await esperar();
    expect(ultima(urls).searchParams.has("dateFrom")).toBe(false);
  });

  it("sucursal: con 2+ sucursales manda branchId; con 1 o sin permiso el chip no se pinta", async () => {
    const urls = montar();
    await esperar();
    elegirValor(porEtiqueta("Sucursal"), "prop-2");
    await esperar();
    expect(ultima(urls).searchParams.get("branchId")).toBe("prop-2");
    rendered!.unmount();
    montar([SUCURSALES[0]]);
    await esperar();
    expect(porEtiqueta("Sucursal")).toBeNull();
    rendered!.unmount();
    montar(null);
    await esperar();
    expect(porEtiqueta("Sucursal")).toBeNull();
    expect(porEtiqueta("Periodo")).not.toBeNull();
  });
});

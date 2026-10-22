// @vitest-environment jsdom
//
// Contenedor del chofer: muestra la vista anterior hasta que la primera lista nueva responde bien (sin parpadeo), se queda en ella con 501/404,
// y conserva «Historial del dia» (efectivo a rendir) como pestana del panel nuevo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelChofer } from "../src/verticals/restaurantes/components/chofer/PanelChofer.tsx";
import { interpretarMonto } from "../src/verticals/restaurantes/components/chofer/ConfirmarEntrega.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status });
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
}
const visible = (texto: string) => [...document.querySelectorAll("h1, p, button, [role=tab]")].some((e) => e.textContent?.includes(texto) && !e.closest("[hidden]"));
function montar(fetchImpl: typeof fetch) {
  rendered = renderComponent(<PanelChofer apiBaseUrl="https://api.test" token="t" propertyId="prop-1" identidad="ana@example.test" fetchImpl={fetchImpl} almacen={null} legado={<p>VISTA ANTERIOR</p>} />);
}

describe("PanelChofer", () => {
  it("con 501 se queda en la vista anterior desde el primer pintado, sin pestanas nuevas", async () => {
    montar(vi.fn(async () => json(501, { code: "no_implementado", message: "No disponible aún" })) as unknown as typeof fetch);
    expect(visible("VISTA ANTERIOR")).toBe(true);
    await esperar();
    expect(visible("VISTA ANTERIOR")).toBe(true);
    expect(visible("Historial del día")).toBe(false);
  });

  it("con 404 de lista tambien; un 403 o un 500 NO cambian de pantalla (sigue la vista anterior) ni la reemplazan por un error", async () => {
    for (const [status, code] of [[404, "not_found"], [403, "forbidden"], [500, "internal"]] as const) {
      montar(vi.fn(async () => json(status, { code, message: "x" })) as unknown as typeof fetch);
      await esperar();
      expect(visible("VISTA ANTERIOR"), `status ${status}`).toBe(true);
      expect(visible("Historial del día"), `status ${status}`).toBe(false);
      rendered!.unmount();
      document.body.innerHTML = "";
    }
  });

  it("mientras la primera lista no responde, la vista anterior es la visible; al responder bien cambia al panel nuevo con Historial del dia", async () => {
    let resolver: (r: Response) => void = () => undefined;
    montar(vi.fn(() => new Promise<Response>((r) => (resolver = r))) as unknown as typeof fetch);
    await esperar();
    expect(visible("VISTA ANTERIOR")).toBe(true);
    expect(visible("En camino")).toBe(false);
    await act(async () => {
      resolver(json(200, { entregas: [], actualizadoEn: "2026-10-21T20:00:00.000Z" }));
      for (let i = 0; i < 15; i++) await Promise.resolve();
    });
    expect(visible("VISTA ANTERIOR")).toBe(false);
    for (const pestana of ["En camino", "Historial del día", "Mi perfil"]) expect(visible(pestana), pestana).toBe(true);
    expect(visible("Hecho hoy")).toBe(false);
  });
});

describe("interpretarMonto", () => {
  it("vacio = no cobro; acepta coma; rechaza texto, negativos y montos absurdos", () => {
    expect(interpretarMonto("")).toBeNull();
    expect(interpretarMonto("708")).toBe(708);
    expect(interpretarMonto("708,5")).toBe(708.5);
    expect(interpretarMonto("abc")).toBeUndefined();
    expect(interpretarMonto("-5")).toBeUndefined();
    expect(interpretarMonto("999999")).toBeUndefined();
    expect(interpretarMonto("1.234")).toBeUndefined();
  });
});

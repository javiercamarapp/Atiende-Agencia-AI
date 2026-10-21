// @vitest-environment jsdom
//
// Contenedor del chofer: cae a la vista anterior si el servidor aun no tiene las rutas (501), y «Hecho hoy» nunca inventa un 0.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelChofer } from "../src/verticals/restaurantes/components/chofer/PanelChofer.tsx";
import { HechoHoy } from "../src/verticals/restaurantes/components/chofer/HechoHoy.tsx";
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

describe("PanelChofer", () => {
  it("con 501 muestra la vista anterior (legado) en lugar de un error", async () => {
    const fetchImpl = vi.fn(async () => json(501, { code: "no_implementado", message: "No disponible aún" })) as unknown as typeof fetch;
    rendered = renderComponent(<PanelChofer apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={fetchImpl} almacen={null} legado={<p>VISTA ANTERIOR</p>} />);
    await esperar();
    expect(document.body.textContent).toContain("VISTA ANTERIOR");
    expect(document.body.textContent).not.toContain("Hecho hoy");
  });

  it("con rutas disponibles muestra el panel nuevo con sus tres pestanas y NO el legado", async () => {
    const fetchImpl = vi.fn(async () => json(200, { entregas: [], actualizadoEn: "2026-10-21T20:00:00.000Z" })) as unknown as typeof fetch;
    rendered = renderComponent(<PanelChofer apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={fetchImpl} almacen={null} legado={<p>VISTA ANTERIOR</p>} />);
    await esperar();
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("Mis entregas");
    for (const pestana of ["En camino", "Hecho hoy", "Mi perfil"]) expect(texto).toContain(pestana);
    expect(texto).not.toContain("VISTA ANTERIOR");
  });
});

describe("HechoHoy", () => {
  it("muestra las cifras del servidor y, sin efectivo registrado, un «—» con su motivo (nunca 0)", async () => {
    const fetchImpl = vi.fn(async () => json(200, { entregasHoy: 6, enCamino: 1, efectivoPorEntregar: null })) as unknown as typeof fetch;
    rendered = renderComponent(<HechoHoy apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={fetchImpl} />);
    await esperar();
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("Entregas de hoy");
    expect(texto).toContain("6");
    expect(texto).toContain("Falta la actualización de base");
    expect(document.querySelector('[aria-label="Efectivo por entregar: sin dato"]')).not.toBeNull();
  });

  it("con efectivo registrado lo formatea en pesos", async () => {
    const fetchImpl = vi.fn(async () => json(200, { entregasHoy: 6, enCamino: 0, efectivoPorEntregar: 3120 })) as unknown as typeof fetch;
    rendered = renderComponent(<HechoHoy apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={fetchImpl} />);
    await esperar();
    expect(document.body.textContent).toContain("$3,120.00");
  });

  it("501: estado honesto «—» con motivo; 500: error con Reintentar", async () => {
    rendered = renderComponent(<HechoHoy apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={(async () => json(501, { code: "no_implementado", message: "x" })) as unknown as typeof fetch} />);
    await esperar();
    expect(document.body.textContent).toContain("Disponible cuando el servidor del panel esté activo.");
    rendered.unmount();
    rendered = renderComponent(<HechoHoy apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={(async () => json(500, { code: "internal", message: "Falla" })) as unknown as typeof fetch} />);
    await esperar();
    expect(document.body.textContent).toContain("Falla");
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

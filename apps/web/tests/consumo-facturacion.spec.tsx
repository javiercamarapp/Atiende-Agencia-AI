// @vitest-environment jsdom
//
// «Consumo y facturación» (restaurantes): las cifras salen de GET /billing/consumo; sin migraciones se muestra el estado
// honesto; un error de servidor no inventa cifras.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumoFacturacion } from "../src/verticals/restaurantes/pages/ConsumoFacturacion.tsx";
import { esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const factura = (subtotalMxn: number) => ({ subtotalMxn, ivaMxn: subtotalMxn * 0.16, totalMxn: subtotalMxn * 1.16 });
const CONSUMO = {
  disponible: true,
  mes: "2026-11-01",
  zonaHoraria: "America/Merida",
  plan: { nombre: "Pro" },
  totales: { llamadas: 120, minutosVoz: 1300, duracionPromedioS: 150, conversacionesWa: 900, pedidosAgentes: 80 },
  bolsa: { voz: { incluido: 1500, usado: 1300, porcentaje: 86.7 }, whatsapp: { incluido: 2000, usado: 900, porcentaje: 45 } },
  facturaAlCorte: factura(7690),
  proyeccion: { diasDelMes: 30, diasTranscurridos: 20, rangoConfiable: true, factura: { bajo: factura(7690), central: factura(8200), alto: factura(9000) } },
  sucursales: [{ propertyId: "p1", nombre: "Centro", llamadas: 120, minutosVoz: 1300, duracionPromedioS: 150, pedidosAgentes: 80 }],
  historial: [{ mes: "2026-10-01", llamadas: 100, minutosVoz: 1100, conversacionesWa: 800 }],
};

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

describe("ConsumoFacturacion", () => {
  it("muestra KPIs, bolsa con aviso del 80 %, proyeccion con rango, sucursales e historial", async () => {
    stubFetch(200, CONSUMO);
    rendered = renderComponent(<ConsumoFacturacion apiBaseUrl="https://api.test" token="tok" />);
    await esperarHasta(() => document.querySelector('[data-testid="consumo-kpis"]') !== null, "las cifras de consumo");
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("1,300");
    expect(texto).toContain("80 %");
    expect(document.querySelector('[data-testid="consumo-proyeccion"]')?.textContent).toMatch(/7,690/);
    expect(document.querySelector('[data-testid="consumo-sucursales"]')?.textContent).toContain("Centro");
    expect(document.querySelector('[data-testid="consumo-historial"]')).not.toBeNull();
    // Una sola peticion: cargar las cifras no debe volver a disparar la carga.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("sin migraciones muestra el motivo, sin cifras", async () => {
    stubFetch(200, { disponible: false, motivo: "Faltan migraciones" });
    rendered = renderComponent(<ConsumoFacturacion apiBaseUrl="https://api.test" token="tok" />);
    await esperarHasta(() => (document.body.textContent ?? "").includes("Faltan migraciones"), "el motivo de no disponible");
    expect(document.querySelector('[data-testid="consumo-kpis"]')).toBeNull();
  });

  it("un 403 muestra error, sin cifras", async () => {
    stubFetch(403, { message: "No perteneces a esta organización." });
    rendered = renderComponent(<ConsumoFacturacion apiBaseUrl="https://api.test" token="tok" />);
    await esperarHasta(() => (document.body.textContent ?? "").includes("No perteneces"), "el error del servidor");
    expect(document.querySelector('[data-testid="consumo-kpis"]')).toBeNull();
  });
});

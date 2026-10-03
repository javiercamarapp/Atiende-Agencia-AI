// @vitest-environment jsdom
//
// SA-L-21: /superadmin/costos-facturacion = cuatro pestanas que montan las paginas existentes (sin duplicar su logica y sin h1
// propio), la pestana activa en la URL (?tab=), dos KpiTiles que salen del resumen de la consola y las rutas viejas que redirigen.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { REDIRECCIONES_SUPERADMIN } from "../src/superadmin/rutas.ts";
import { SuperAdminCostosFacturacionPage, costoPorOperacion, pestanaValida } from "../src/superadmin/pages/CostosFacturacion.tsx";
import type { ConsolaResumen } from "../src/superadmin/lib/consola-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

// Cada pagina hija se sustituye por un marcador que expone si recibio `incrustada`: su logica ya tiene sus propias pruebas.
vi.mock("../src/superadmin/pages/Facturacion.tsx", () => ({ SuperAdminFacturacionPage: (p: { incrustada?: boolean }) => <div data-testid="hija-facturacion">facturacion incrustada={String(p.incrustada)}</div> }));
vi.mock("../src/superadmin/pages/CostosMargen.tsx", () => ({ SuperAdminCostosMargenPage: (p: { incrustada?: boolean }) => <div data-testid="hija-costos">costos incrustada={String(p.incrustada)}</div> }));
vi.mock("../src/superadmin/pages/PylVertical.tsx", () => ({ SuperAdminPylVerticalPage: (p: { incrustada?: boolean }) => <div data-testid="hija-pyl">pyl incrustada={String(p.incrustada)}</div> }));
vi.mock("../src/superadmin/pages/Contratos.tsx", () => ({ SuperAdminContratosPage: (p: { incrustada?: boolean }) => <div data-testid="hija-contratos">contratos incrustada={String(p.incrustada)}</div> }));

const aqui = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(aqui, "../src/App.tsx"), "utf8");

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const DIAS = Array.from({ length: 14 }, (_, i) => `2026-09-${String(19 + i).padStart(2, "0")}`);

function resumen(sobre: Partial<Record<"gastoIa" | "operaciones", unknown>> = {}): ConsolaResumen {
  return {
    disponible: true,
    generadoEn: "2026-10-02T12:00:00Z",
    hoy: "2026-10-02",
    gastoIa: { valor: { totalUsd: 40, llmUsd: 36, otrosUsd: 4, porCategoria: [], serie14d: { valor: DIAS.map((dia, i) => ({ dia, usd: 1 + i })) }, delta7d: { valor: null } } },
    operaciones: { valor: { total: 10_000, porVertical: [], serie14d: [], verticalesSinFuente: [] } },
    ...sobre,
  } as unknown as ConsolaResumen;
}

function stubResumen(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.endsWith("/superadmin/consola/resumen")) throw new Error(`fetch inesperado: ${url}`);
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

function Ubicacion() {
  const l = useLocation();
  return <output data-testid="url">{`${l.pathname}${l.search}`}</output>;
}

async function montar(ruta: string): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <SuperAdminCostosFacturacionPage apiBaseUrl="https://api.test" token="tok" />
      <Ubicacion />
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  return r;
}

const url = (r: RenderedComponent) => r.container.querySelector('[data-testid="url"]')!.textContent;
const valores = (r: RenderedComponent) => [...r.container.querySelectorAll('[data-testid="kpi-tile-valor"]')].map((e) => e.textContent);

describe("SuperAdminCostosFacturacionPage", () => {
  it("monta SOLO la pestana de la URL y la pagina hija va incrustada (sin h1 propio); el unico h1 es el de la pagina", async () => {
    stubResumen(resumen());
    rendered = await montar("/superadmin/costos-facturacion?tab=pyl");
    expect(rendered.container.querySelector('[data-testid="hija-pyl"]')?.textContent).toContain("incrustada=true");
    expect(rendered.container.querySelector('[data-testid="hija-facturacion"]')).toBeNull();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Costos y facturación");
  });

  it("sin ?tab= (o con uno invalido) abre Facturacion; cambiar de pestana actualiza la URL", async () => {
    stubResumen(resumen());
    rendered = await montar("/superadmin/costos-facturacion?tab=nada");
    expect(rendered.container.querySelector('[data-testid="hija-facturacion"]')).not.toBeNull();
    const pestanas = [...rendered.container.querySelectorAll('[role="tab"]')];
    expect(pestanas.map((t) => t.textContent)).toEqual(["Facturación", "Costos y margen", "P&L", "Contratos"]);
    await act(async () => {
      const t = pestanas[3]!;
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      click(t);
      await flushMicrotasks();
    });
    expect(url(rendered)).toBe("/superadmin/costos-facturacion?tab=contratos");
    expect(rendered.container.querySelector('[data-testid="hija-contratos"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="hija-facturacion"]')).toBeNull();
  });

  it("KpiTiles: gasto historico y costo por operacion = gasto / operaciones, ambos del resumen", async () => {
    stubResumen(resumen());
    rendered = await montar("/superadmin/costos-facturacion");
    // 40 / 10,000 = 0.0040
    expect(valores(rendered)).toEqual(["US$40.00", "US$0.0040"]);
  });

  it("falta el gasto, faltan las operaciones o hay cero operaciones: '—' con su motivo, nunca un cero", async () => {
    stubResumen(resumen({ operaciones: { valor: null, razon: "Ninguna vertical reporta operaciones." } }));
    rendered = await montar("/superadmin/costos-facturacion");
    expect(valores(rendered)).toEqual(["US$40.00", "—"]);
    expect(rendered.container.textContent).toContain("Ninguna vertical reporta operaciones.");
    rendered.unmount();

    stubResumen(resumen({ gastoIa: { valor: null, razon: "Sin dato de gasto." } }));
    rendered = await montar("/superadmin/costos-facturacion");
    expect(valores(rendered)).toEqual(["—", "—"]);
    expect(rendered.container.textContent).toContain("Sin dato de gasto.");
  });

  it("si el resumen falla, los KpiTiles muestran el error y las pestanas siguen funcionando", async () => {
    stubResumen({ message: "boom" }, false);
    rendered = await montar("/superadmin/costos-facturacion");
    expect(valores(rendered)).toEqual(["—", "—"]);
    expect(rendered.container.textContent).toContain("No se pudo cargar");
    expect(rendered.container.querySelector('[data-testid="hija-facturacion"]')).not.toBeNull();
  });

  it("costoPorOperacion con cero operaciones es null con motivo; pestanaValida cae a facturacion", () => {
    expect(costoPorOperacion(resumen({ operaciones: { valor: { total: 0, porVertical: [], serie14d: [], verticalesSinFuente: [] } } })).valor).toBeNull();
    expect(costoPorOperacion(resumen({ operaciones: { valor: { total: 4, porVertical: [], serie14d: [], verticalesSinFuente: ["despachos"] } } }))).toEqual({ valor: 10, nota: "Operaciones sin fuente en: despachos." });
    expect(pestanaValida(null)).toBe("facturacion");
    expect(pestanaValida("pyl")).toBe("pyl");
  });
});

describe("redirecciones de las rutas viejas de costos (sin 404)", () => {
  it("facturacion, costos-margen, pyl y contratos redirigen a su pestana; el destino tiene Route real en App.tsx", async () => {
    const esperado: Record<string, string> = {
      "/superadmin/facturacion": "/superadmin/costos-facturacion?tab=facturacion",
      "/superadmin/costos-margen": "/superadmin/costos-facturacion?tab=costos",
      "/superadmin/pyl": "/superadmin/costos-facturacion?tab=pyl",
      "/superadmin/contratos": "/superadmin/costos-facturacion?tab=contratos",
    };
    expect(appSrc).toContain('path="/superadmin/costos-facturacion"');
    for (const [vieja, nueva] of Object.entries(esperado)) {
      expect(REDIRECCIONES_SUPERADMIN[vieja], vieja).toBe(nueva);
      // La vieja ya NO tiene Route propia: solo la redireccion generada del mapa.
      expect(appSrc, vieja).not.toContain(`path="${vieja}"`);
      const r = renderComponent(
        <MemoryRouter initialEntries={[vieja]}>
          <Routes>
            {Object.entries(REDIRECCIONES_SUPERADMIN).map(([desde, hacia]) => (
              <Route key={desde} path={desde} element={<Navigate to={hacia} replace />} />
            ))}
            <Route path="/superadmin/costos-facturacion" element={<Ubicacion />} />
          </Routes>
        </MemoryRouter>,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      expect(url(r), vieja).toBe(nueva);
      r.unmount();
    }
  });
});

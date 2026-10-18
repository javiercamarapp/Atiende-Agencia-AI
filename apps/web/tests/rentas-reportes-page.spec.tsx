// @vitest-environment jsdom
//
// Smoke tests reales de <ReportesPage /> (Rn-03): gate de rol, tabla por agrupación,
// advertencias, degradación sin movimiento financiero y descarga.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportesPage } from "../src/verticals/rentas/pages/Reportes.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const M = { llegadas: 1, noches_ocupadas: 6, noches_disponibles: 61, ocupacion_basis_points: 984, ingreso_bruto_centavos: 100003, comision_canal_centavos: 16000, comision_gestor_centavos: 0, gastos_centavos: 0, impuestos_centavos: 0, neto_centavos: 84003, adr_centavos: 16667 };
const REPORTE = (extra: object = {}) => ({
  periodo: { desde: "2026-03-01", hasta: "2026-05-01" },
  moneda: "MXN",
  financiero_disponible: true,
  totales: M,
  por_unidad: [{ clave: "u1", etiqueta: "Casa del mar", ...M }],
  por_propietario: [],
  por_canal: [],
  por_mes: [],
  advertencias: { reservas_sin_movimiento_financiero: 0, reservas_moneda_distinta: 0, noches_solapadas_omitidas: 0, reservas_duplicadas_omitidas: 0 },
  ...extra,
});
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

function montar(rol: string): RenderedComponent {
  return renderComponent(<ReportesPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);
}

describe("ReportesPage", () => {
  it("el admin ve totales, ocupación y la fila de la unidad", async () => {
    const fetchMock = vi.fn(async () => json(REPORTE()));
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Casa del mar");
    expect(texto).toContain("$1,000.03");
    expect(texto).toContain("9.8%");
    expect(texto).toContain("1 mar 2026 → 1 may 2026");
    expect(texto).not.toContain("MXN");
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://api.local/rentas/prop-1/reportes/ocupacion-ingresos");
  });

  it("un rol sin acceso no dispara ninguna petición y lo explica", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = montar("limpieza");
    await esperar();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("no tiene acceso a los reportes financieros");
  });

  it("avisa cuando los movimientos financieros no están disponibles y cuando hay reservas sin movimiento", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(REPORTE({ financiero_disponible: false, advertencias: { reservas_sin_movimiento_financiero: 2, reservas_moneda_distinta: 0, noches_solapadas_omitidas: 0, reservas_duplicadas_omitidas: 0 } }))));
    rendered = montar("contador");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("todavía no están disponibles");
    expect(texto).toContain("2 reserva(s) sin movimiento financiero");
  });

  it("CSV descarga con la URL de formato y guarda el archivo", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("formato=csv") ? ({ ok: true, status: 200, blob: async () => new Blob(["x"]) } as unknown as Response) : json(REPORTE());
    }));
    const crear = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: vi.fn() }));
    rendered = montar("admin_gestora");
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("CSV"))!;
    await act(async () => {
      click(boton);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    expect(urls.some((u) => u.includes("formato=csv") && u.includes("agrupar=unidad"))).toBe(true);
    expect(crear).toHaveBeenCalled();
  });

  it("sin reservas en el periodo muestra el estado vacio de la tabla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(REPORTE({ por_unidad: [] }))));
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Sin datos en el periodo");
    expect(rendered.container.querySelector("table")).toBeNull();
  });

  it("mientras carga muestra el estado cargando y si falla ofrece reintentar con el mensaje real", async () => {
    let falla = true;
    let soltar!: () => void;
    const pausa = new Promise<void>((r) => (soltar = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await pausa;
        return falla ? ({ ok: false, status: 500, json: async () => ({ message: "Servidor caído" }) } as unknown as Response) : json(REPORTE());
      }),
    );
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.querySelector('[aria-busy="true"], [role="status"]')).not.toBeNull();
    expect(rendered.container.querySelector("table")).toBeNull();
    await act(async () => {
      soltar();
      await esperar();
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("Servidor caído");
    falla = false;
    const reintentar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!;
    await act(async () => {
      click(reintentar);
      await esperar();
    });
    expect(rendered.container.textContent).toContain("Casa del mar");
  });

  it("si la descarga falla muestra el mensaje real y no guarda ningun archivo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("formato=pdf") ? ({ ok: false, status: 403, json: async () => ({ message: "No tienes permiso para realizar esta acción." }) } as unknown as Response) : json(REPORTE()))),
    );
    const crear = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: crear, revokeObjectURL: vi.fn() }));
    rendered = montar("admin_gestora");
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "PDF")!;
    await act(async () => {
      click(boton);
      await esperar();
    });
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("No tienes permiso");
    expect(crear).not.toHaveBeenCalled();
  });
});

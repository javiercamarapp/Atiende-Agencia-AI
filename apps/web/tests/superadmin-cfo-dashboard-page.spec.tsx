// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminCfoDashboardPage } from "../src/superadmin/pages/CfoDashboard.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, clone() { return this; }, status: ok ? 200 : 500 }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CLIENTE = { organizationId: "o1", nombre: "Los Taquitos de PM", vertical: "restaurantes", ingresoMxn: 1598, costoMxn: 80, margenMxn: 1518, margenPct: 95 };
const BAJO = { organizationId: "o2", nombre: "Clinica Sur", vertical: "citas", ingresoMxn: 1598, costoMxn: 1400, margenMxn: 198, margenPct: 12.4 };

const COMPLETO = {
  disponible: true,
  mes: "2026-09",
  tipoCambio: { mxnPorUsd: 20, fecha: "2026-09-01", fuente: "Banxico FIX" },
  supuestos: ["Supuesto de prueba uno."],
  dashboard: {
    mes: "2026-09",
    ingresos: {
      mrrMxn: 3196,
      arrMxn: 38352,
      clientesConIngreso: 2,
      clientesSinPrecio: 1,
      porVertical: [
        { vertical: "restaurantes", mrrMxn: 1598, clientes: 1, sinPrecio: 0 },
        { vertical: "rentas", mrrMxn: 0, clientes: 0, sinPrecio: 1 },
      ],
      topClientes: [{ organizationId: "o1", nombre: "Los Taquitos de PM", vertical: "restaurantes", mrrMxn: 1598, participacionPct: 50 }],
      concentracionTopPct: 50,
    },
    nrr: { disponible: false, razon: "sin_foto_previa" },
    margen: { disponible: true, resumen: { margenPct: 53.7, margenMxn: 1716, costoMxn: 1480 }, umbralMargenPct: 30, clientesBajoUmbral: 1, clientesConMargen: 2, mejores: [CLIENTE], peores: [BAJO] },
    caja: { disponible: false, razon: "Todavia no hay una fuente de caja." },
    cobranza: { pagoPendiente: 1, mrrEnRiesgoMxn: 1598 },
    alertas: [{ codigo: "margen_bajo", severidad: "alta", titulo: "Clientes con margen bajo el 30 %", organizaciones: [{ organizationId: "o2", nombre: "Clinica Sur", dato: "margen 12.4 % (umbral 30 %)" }] }],
  },
};

function stub(respuesta: unknown, ok = true) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/superadmin/cfo/dashboard")) return json(respuesta, ok);
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const render = () => renderComponent(<SuperAdminCfoDashboardPage apiBaseUrl="https://api.test" token="tok" />);

describe("SuperAdminCfoDashboardPage", () => {
  it("muestra MRR, ARR, margen, cobranza, riesgos y mejores/peores clientes", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("$3,196.00");
    expect(t).toContain("$38,352.00");
    expect(t).toContain("53.7%");
    expect(t).toContain("1 de 2 clientes bajo el umbral de 30%");
    expect(t).toContain("Riesgos y alertas vigentes");
    expect(t).toContain("margen 12.4 % (umbral 30 %)");
    expect(t).toContain("Los Taquitos de PM");
    expect(t).toContain("Clinica Sur");
    expect(t).toContain("1 clientes con pago pendiente · $1,598.00 de MRR".replace("1 clientes", "clientes"));
    expect(t).toContain("el mayor concentra 50.0%");
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/superadmin\/cfo\/dashboard\?mes=\d{4}-\d{2}$/);
  });

  it("lo sin fuente es «—» con su razon: caja, NRR sin foto previa; un vertical sin clientes no muestra MRR 0", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Todavia no hay una fuente de caja.");
    expect(t).toContain("Aún no hay foto de ingreso del mes anterior");
    expect(rendered.container.querySelector('[aria-label="Caja: sin dato"]')).not.toBeNull();
    expect(rendered.container.querySelector('[aria-label="NRR: sin dato"]')).not.toBeNull();
    const filaRentas = Array.from(rendered.container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("rentas"));
    expect(filaRentas?.textContent).toContain("—");
    expect(filaRentas?.textContent).not.toContain("$0");
  });

  it("con NRR disponible muestra el porcentaje y sus componentes", async () => {
    stub({ ...COMPLETO, dashboard: { ...COMPLETO.dashboard, nrr: { disponible: true, mrrInicialMxn: 1000, expansionMxn: 598, contraccionMxn: 0, churnMxn: 100, nuevoMxn: 0, nrrPct: 149.8, grrPct: 90, excluidasSinDato: 0 } } });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("149.8%");
    expect(t).toContain("expansión $598.00");
    expect(t).toContain("churn $100.00");
  });

  it("sin tipo de cambio: margen sin dato con la razon, y no muestra tablas de mejores/peores", async () => {
    stub({ ...COMPLETO, tipoCambio: null, dashboard: { ...COMPLETO.dashboard, margen: { disponible: false, razon: "sin_tipo_de_cambio" }, alertas: [] } });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Falta capturar el tipo de cambio");
    expect(t).not.toContain("Clientes con menor margen");
    expect(t).not.toContain("Riesgos y alertas vigentes");
    expect(rendered.container.querySelector('[aria-label="Margen bruto: sin dato"]')).not.toBeNull();
  });

  it("migracion 0030 pendiente: mensaje honesto y ninguna cifra", async () => {
    stub({ disponible: false, mes: "2026-09", mensaje: "El dashboard CFO todavía no está disponible en este despliegue (falta aplicar la migración 0030_superadmin_cfo_dashboard).", tipoCambio: null, dashboard: null, supuestos: [] });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("0030_superadmin_cfo_dashboard");
    expect(t).not.toContain("MRR por vertical");
  });

  it("error de red: estado de error con reintento", async () => {
    stub({}, false);
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el dashboard CFO.");
  });

  it("cambiar el mes vuelve a pedir el dashboard de ese mes", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    const input = rendered.container.querySelector<HTMLInputElement>("#cfo-mes")!;
    await act(async () => {
      changeValue(input, "2026-05");
    });
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("?mes=2026-05"))).toBe(true);
  });
});

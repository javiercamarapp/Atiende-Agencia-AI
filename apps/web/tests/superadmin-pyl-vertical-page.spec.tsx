// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminPylVerticalPage } from "../src/superadmin/pages/PylVertical.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, blob: async () => new Blob(["csv"]), clone() { return this; }, status: ok ? 200 : 500 }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const cogs = { llm: 80, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 };
const variacion = (actual: number | null, previo: number | null) => ({ actual, previo, deltaMxn: actual !== null && previo !== null ? actual - previo : null, deltaPct: actual !== null && previo ? Math.round(((actual - previo) / previo) * 1000) / 10 : null });
const agregado = (clave: string, parche: Record<string, unknown> = {}) => ({
  clave, organizaciones: 1, organizacionesConIngreso: 1, organizacionesSinIngreso: 0, ingresoMxn: 1598, cogs, cogsDirectoMxn: 80, infraMxn: null, costoSinIngresoMxn: 0,
  contribucionMxn: 1518, contribucionPct: 95, margenBrutoMxn: null, margenBrutoPct: null, ...parche,
});

const COMPLETO = {
  disponible: true,
  mes: "2026-09",
  mesPrevio: "2026-08",
  tipoCambio: { mxnPorUsd: 20, fecha: "2026-09-01", fuente: "Banxico FIX" },
  infraCapturaDisponible: true,
  pyl: {
    infra: { disponible: false, razon: "sin_infra_capturada" },
    total: agregado("total", { organizaciones: 2, organizacionesConIngreso: 1, organizacionesSinIngreso: 1, costoSinIngresoMxn: 80 }),
    porVertical: [agregado("restaurantes"), agregado("rentas", { ingresoMxn: 0, organizacionesConIngreso: 0, organizacionesSinIngreso: 1, contribucionMxn: null, contribucionPct: null })],
    porCliente: [
      { organizationId: "o1", nombre: "Los Taquitos de PM", vertical: "restaurantes", ingresoMxn: 1598, ingresoRazon: null, cogs, cogsDirectoMxn: 80, infraMxn: null, contribucionMxn: 1518, contribucionPct: 95, margenBrutoMxn: null, margenBrutoPct: null },
      { organizationId: "o2", nombre: "Casa Playa", vertical: "rentas", ingresoMxn: null, ingresoRazon: "precio_no_configurado", cogs, cogsDirectoMxn: 80, infraMxn: null, contribucionMxn: null, contribucionPct: null, margenBrutoMxn: null, margenBrutoPct: null },
    ],
  },
  comparativo: {
    total: { clave: "total", ingreso: variacion(1598, 1000), cogsDirecto: variacion(80, 80), contribucion: variacion(1518, 920), margenBruto: variacion(null, null) },
    porVertical: [{ clave: "restaurantes", ingreso: variacion(1598, 1000), cogsDirecto: variacion(80, 80), contribucion: variacion(1518, 920), margenBruto: variacion(null, null) }],
  },
  movimientoMrr: { disponible: false, razon: "sin_foto_previa" },
  supuestos: ["Supuesto de prueba uno."],
};

function stub(respuesta: unknown, ok = true, extra: (url: string, init?: RequestInit) => Response | null = () => null) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const e = extra(url, init);
    if (e) return e;
    if (url.includes("/superadmin/pyl?")) return json(respuesta, ok);
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const render = () => renderComponent(<SuperAdminPylVerticalPage apiBaseUrl="https://api.test" token="tok" />);

describe("SuperAdminPylVerticalPage", () => {
  it("muestra ingreso, COGS, contribucion, comparativo y las tablas por vertical y por cliente", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("P&L por vertical y cliente");
    expect(t).toContain("$1,598.00");
    expect(t).toContain("95.0%");
    expect(t).toContain("Comparativo contra 2026-08");
    expect(t).toContain("+$598.00 (+59.8%)");
    expect(t).toContain("Los Taquitos de PM");
    expect(t).toContain("Casa Playa");
    expect(t).toContain("Supuesto de prueba uno.");
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/superadmin\/pyl\?mes=\d{4}-\d{2}$/);
  });

  it("lo sin fuente es «—» con su razon: margen bruto sin infra, ingreso sin precio, movimiento sin foto; nunca $0", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(rendered.container.querySelector('[aria-label="Margen bruto: sin dato"]')).not.toBeNull();
    expect(t).toContain("Falta capturar la infraestructura del mes");
    expect(t).toContain("plan sin precio");
    expect(t).toContain("Aún no hay foto de ingreso del mes anterior");
    expect(t).toContain("1 cliente(s) sin ingreso conocido");
    const filaRentas = Array.from(rendered.container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("Casa Playa"));
    // El ingreso desconocido es «—» con su razon (no $0); los $0.00 de las categorias de COGS son costo real conocido sin eventos.
    expect(filaRentas?.querySelectorAll("td")[1]?.textContent?.trim()).toBe("— plan sin precio");
  });

  it("0030 pendiente: mensaje honesto, sin cifras ni botones de exportar", async () => {
    stub({ disponible: false, mes: "2026-09", mensaje: "El P&L por vertical y cliente todavía no está disponible en este despliegue (falta aplicar la migración 0030_superadmin_cfo_dashboard)." });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("0030_superadmin_cfo_dashboard");
    expect(t).not.toContain("CSV por vertical");
    expect(t).not.toContain("Comparativo contra");
  });

  it("0032 pendiente: avisa y no ofrece el formulario de captura", async () => {
    stub({ ...COMPLETO, infraCapturaDisponible: false });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("migración 0032 pendiente de aplicar");
    expect(rendered.container.querySelector("#pyl-concepto")).toBeNull();
  });

  it("sin tipo de cambio avisa que no se calculan costos ni margenes", async () => {
    stub({ ...COMPLETO, tipoCambio: null, pyl: { ...COMPLETO.pyl, total: agregado("total", { cogs: null, cogsDirectoMxn: null, contribucionMxn: null, contribucionPct: null }) } });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No hay tipo de cambio configurado");
    expect(rendered.container.querySelector('[aria-label="COGS directo: sin dato"]')).not.toBeNull();
  });

  it("error de red: estado de error con reintento", async () => {
    stub({}, false);
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el P&L.");
  });

  it("cambiar el mes vuelve a pedir el P&L de ese mes", async () => {
    stub(COMPLETO);
    rendered = render();
    await esperar();
    await act(async () => {
      changeValue(rendered!.container.querySelector<HTMLInputElement>("#pyl-mes")!, "2026-05");
    });
    await esperar();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("?mes=2026-05"))).toBe(true);
  });

  it("captura de infra: valida, envia el PUT en pesos con el mes elegido y recarga", async () => {
    let put: { url: string; body: unknown } | null = null;
    stub(COMPLETO, true, (url, init) => {
      if (url.endsWith("/superadmin/pyl/infra") && init?.method === "PUT") {
        put = { url, body: JSON.parse(String(init.body)) };
        return json({ ok: true });
      }
      return null;
    });
    rendered = render();
    await esperar();
    const form = rendered.container.querySelector<HTMLFormElement>("form")!;
    await submitForm(form); // vacio: no envia
    expect(put).toBeNull();
    expect(rendered.container.textContent).toContain("Indica el concepto");
    await act(async () => {
      changeValue(rendered!.container.querySelector<HTMLInputElement>("#pyl-concepto")!, "Vercel");
      changeValue(rendered!.container.querySelector<HTMLInputElement>("#pyl-monto")!, "1234.5");
    });
    await submitForm(form);
    await esperar();
    expect(put).toMatchObject({ body: { concepto: "Vercel", montoMxn: 1234.5 } });
    expect((put as unknown as { body: { mes: string } }).body.mes).toMatch(/^\d{4}-\d{2}$/);
    expect(rendered.container.textContent).toContain("Infraestructura guardada.");
  });

  it("exportar CSV pide el archivo con el nivel y el mes", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    stub(COMPLETO, true, (url) => (url.includes("/export.csv") ? json({}) : null));
    rendered = render();
    await esperar();
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("CSV por cliente"))!;
    await act(async () => {
      click(boton);
    });
    await esperar();
    expect(fetchMock.mock.calls.some((c) => /\/superadmin\/pyl\/export\.csv\?mes=\d{4}-\d{2}&nivel=cliente$/.test(String(c[0])))).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

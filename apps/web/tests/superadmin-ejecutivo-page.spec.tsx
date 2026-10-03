// @vitest-environment jsdom
//
// SA-L-24: /superadmin/ejecutivo = CfoDashboard (incrustado, con su step-up) + odometro del MRR contra la meta de $1,000,000,
// KpiTiles de Likida (gasto de IA con sparkline de 14 dias, Organizaciones, Operaciones) y 'Lo que este panel todavia no puede
// mostrar' con su ticket. Todo sale de GET /superadmin/consola/resumen; un campo sin dato se pinta '—' con su motivo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminEjecutivoPage, PENDIENTES_EJECUTIVO } from "../src/superadmin/pages/Ejecutivo.tsx";
import { guardarStepUp, limpiarStepUp, registrarStepUpPrompter } from "../src/superadmin/lib/stepup.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  registrarStepUpPrompter(null);
  limpiarStepUp();
  vi.unstubAllGlobals();
});

const DIAS = Array.from({ length: 14 }, (_, i) => `2026-09-${String(19 + i).padStart(2, "0")}`);

function resumen(sobre: Record<string, unknown> = {}) {
  return {
    disponible: true,
    generadoEn: "2026-10-02T12:00:00Z",
    hoy: "2026-10-02",
    organizaciones: { valor: { total: 12, demo: 1, porVertical: [] } },
    gastoIa: { valor: { totalUsd: 41.82, llmUsd: 36.1, otrosUsd: 5.72, porCategoria: [], serie14d: { valor: DIAS.map((dia, i) => ({ dia, usd: 1 + i })) }, delta7d: { valor: null } } },
    operaciones: { valor: { total: 1400, porVertical: [], serie14d: DIAS.map((dia, i) => ({ dia, cantidad: 5 + i })), verticalesSinFuente: ["despachos"] } },
    mrr: { valor: { totalMxn: 48_900, organizacionesConPrecio: 4, organizacionesSinPrecio: 2 } },
    ...sobre,
  };
}

const CFO = {
  disponible: true,
  mes: "2026-09",
  tipoCambio: null,
  supuestos: [],
  dashboard: {
    mes: "2026-09",
    ingresos: { mrrMxn: 3196, arrMxn: 38352, clientesConIngreso: 2, clientesSinPrecio: 0, porVertical: [], topClientes: [], concentracionTopPct: null },
    nrr: { disponible: false, razon: "sin_foto_previa" },
    margen: { disponible: false, razon: "sin_tipo_de_cambio" },
    caja: { disponible: false, razon: "Todavia no hay una fuente de caja." },
    cobranza: { pagoPendiente: 0, mrrEnRiesgoMxn: null },
    alertas: [],
  },
};

const resp = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, clone() { return this; } }) as unknown as Response;

function stub(o: { resumen?: unknown; cfo?: (url: string, init?: RequestInit) => Response } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/superadmin/consola/resumen")) return o.resumen === "fallo" ? resp({ message: "boom" }, 500) : resp(o.resumen ?? resumen());
    if (url.includes("/superadmin/cfo/dashboard")) return o.cfo ? o.cfo(url, init) : resp(CFO);
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function montar(): Promise<RenderedComponent> {
  const r = renderComponent(<SuperAdminEjecutivoPage apiBaseUrl="https://api.test" token="tok" />);
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
  return r;
}
const texto = () => rendered!.container.textContent ?? "";

describe("SuperAdminEjecutivoPage", () => {
  it("un solo h1 'Ejecutivo / Board'; el dashboard CFO va incrustado (sin su h1) y conserva sus cifras", async () => {
    stub();
    rendered = await montar();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Ejecutivo / Board");
    expect(texto()).not.toContain("Dashboard ejecutivo (CFO)");
    expect(texto()).toContain("$3,196.00");
    expect(texto()).toContain("$38,352.00");
  });

  it("odometro del MRR contra la meta de $1,000,000 con la cifra del Resumen (texto movil incluido)", async () => {
    stub();
    rendered = await montar();
    expect(texto()).toContain("MRR — META $1,000,000");
    expect(texto()).toContain("meta $1,000,000");
    expect(texto()).toContain("$48,900");
    expect(texto()).toContain("2 organizaciones sin precio (no suman)");
  });

  it("KpiTiles: gasto de IA (con sparkline de 14 dias), Organizaciones y Operaciones", async () => {
    stub();
    rendered = await montar();
    const valores = [...rendered.container.querySelectorAll('[data-testid="kpi-tile-valor"]')].map((e) => e.textContent);
    expect(valores).toEqual(["US$41.82", "12", "1,400"]);
    expect(texto()).toContain("Gasto de IA histórico");
    expect(texto()).toContain("Sin fuente en: despachos.");
    // Sparkline de gasto y de operaciones (la de Organizaciones no tiene serie).
    expect(rendered.container.querySelectorAll("svg[role='img'], svg").length).toBeGreaterThan(1);
  });

  it("sin dato: '—' con su motivo, nunca un cero (MRR, gasto, organizaciones y operaciones)", async () => {
    stub({
      resumen: resumen({
        organizaciones: { valor: null, razon: "Sin organizaciones legibles." },
        gastoIa: { valor: null, razon: "No hay gasto registrado." },
        operaciones: { valor: null, razon: "Ninguna vertical reporta operaciones." },
        mrr: { valor: null, razon: "Ninguna organización tiene un plan con precio." },
      }),
    });
    rendered = await montar();
    const valores = [...rendered.container.querySelectorAll('[data-testid="kpi-tile-valor"]')].map((e) => e.textContent);
    expect(valores).toEqual(["—", "—", "—"]);
    expect(texto()).toContain("Sin organizaciones legibles.");
    expect(texto()).toContain("No hay gasto registrado.");
    expect(texto()).toContain("Ninguna vertical reporta operaciones.");
    expect(texto()).toContain("Ninguna organización tiene un plan con precio.");
  });

  it("si el resumen falla muestra el error con reintento y el dashboard CFO sigue funcionando", async () => {
    stub({ resumen: "fallo" });
    rendered = await montar();
    expect(texto()).toContain("No se pudo cargar");
    expect(texto()).toContain("Reintentar");
    expect(texto()).toContain("$3,196.00");
  });

  it("al final: 'Lo que este panel todavía no puede mostrar' con caja, cobranza con aging y el ticket de cada una", async () => {
    stub();
    rendered = await montar();
    const t = texto();
    expect(t.indexOf("Lo que este panel todavía no puede mostrar")).toBeGreaterThan(t.indexOf("$3,196.00"));
    expect(PENDIENTES_EJECUTIVO.map((p) => p.titulo)).toEqual(expect.arrayContaining(["Caja", "Cobranza con aging"]));
    for (const p of PENDIENTES_EJECUTIVO) {
      expect(t).toContain(p.titulo);
      expect(t).toContain(p.ticket);
    }
    expect(t).toContain("SA-09");
    expect(t).toContain("SA-26");
  });

  it("el step-up SIGUE exigido en la vista CFO: un 403 stepup_required pide el codigo y reintenta con x-stepup-token", async () => {
    let intentos = 0;
    const fetchMock = stub({
      cfo: (_url, init) => {
        intentos += 1;
        const cabecera = (init?.headers as Record<string, string> | undefined)?.["x-stepup-token"];
        return cabecera === "TOKEN-STEPUP" ? resp(CFO) : resp({ code: "stepup_required", message: "Se requiere verificación" }, 403);
      },
    });
    const prompter = vi.fn(async () => {
      guardarStepUp("tok", "TOKEN-STEPUP", 300);
    });
    registrarStepUpPrompter(prompter);
    rendered = await montar();
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(intentos).toBe(2);
    expect(texto()).toContain("$3,196.00");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/superadmin/cfo/dashboard"))).toHaveLength(2);
  });

  it("si se cancela el step-up, el dashboard CFO NO se muestra (el 403 se respeta) pero el odometro del Resumen sigue", async () => {
    stub({ cfo: () => resp({ code: "stepup_required", message: "Se requiere verificación" }, 403) });
    registrarStepUpPrompter(async () => {
      throw new Error("cancelado");
    });
    rendered = await montar();
    expect(texto()).not.toContain("$38,352.00");
    expect(texto()).toContain("No se pudo cargar el dashboard CFO.");
    expect(texto()).toContain("$48,900");
  });
});

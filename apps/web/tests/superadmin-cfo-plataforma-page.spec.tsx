// @vitest-environment jsdom
//
// CFO de la plataforma: la pagina pinta lo que arma GET /superadmin/cfo/cockpit (las formulas se prueban en
// packages/billing/tests/cockpit.spec.ts y apps/api/tests/superadmin-cfo-cockpit.spec.ts). Backend simulado a nivel `fetch`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Recomendaciones, SuperAdminCfoPlataformaPage } from "../src/superadmin/pages/CfoPlataforma.tsx";
import type { RespuestaCockpit } from "../src/superadmin/lib/cfo-cockpit-client.ts";
import { NEGOCIO } from "../src/superadmin/rutas.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const aqui = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(aqui, "../src/App.tsx"), "utf8");

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const v = (valor: number, origen: "medido" | "capturado" | "por_omision" = "por_omision") => ({ valor, fuente: "prueba", origen });
const NO = { disponible: false as const, razon: "Captura el gasto de marketing de los últimos 3 meses para calcular el CAC." };

const COCKPIT: RespuestaCockpit = {
  disponible: true,
  mes: "2026-11",
  enCurso: true,
  diasTranscurridos: 15,
  diasDelMes: 30,
  tipoCambio: { mxnPorUsd: 18.6297, fecha: "2026-11-06", fuente: "Banxico FIX" },
  supuestos: {
    vozUsdMinuto: { "elevenlabs-agents": v(0.045, "medido") },
    telefoniaUsdMinuto: {},
    llmUsdConversacionWa: v(0.0192, "medido"),
    whatsappUsdConversacion: null,
    umbralMargenPct: v(30),
    umbralPoolPct: v(90),
    umbralPicoCostoPct: v(50),
    umbralFxPct: v(3),
    ltvMesesTope: v(36),
  },
  economia: [
    {
      organizationId: "pm",
      nombre: "Pizzería Modelo",
      vertical: "restaurantes",
      orgStatus: "active",
      planNombre: "PM a la medida",
      modeloCobro: "medido",
      sucursales: 7,
      mrrMxn: 12000,
      excedenteMxn: 0,
      ingresoMxn: 12000,
      uso: { llamadas: 900, minutosVoz: 2880, duracionPromedioMin: 3.2, conversacionesWa: 1500, pedidos: 1100 },
      costo: { voz: { usd: 129.6, fuente: "modelado" }, llm: { usd: 28.8, fuente: "modelado" }, whatsapp: { usd: 0, fuente: "no_configurado" }, telefonia: { usd: 0, fuente: "no_configurado" }, otros: { usd: 0, fuente: "sin_uso" } },
      costoDirectoUsd: 158.4,
      costoDirectoMxn: 2950.94,
      infraMxn: null,
      contribucionMxn: 9049.06,
      contribucionPct: 75.41,
      margenBrutoMxn: null,
      margenBrutoPct: null,
      proyeccion: { ingresoMxn: 12000, costoMxn: 5901.88, margenMxn: 6098.12, margenPct: 50.82 },
      poolVoz: { incluido: 3000, usado: 2880, pct: 96, pctProyectado: 192 },
      poolWa: null,
      banderas: ["cerca_del_tope", "pago_fallido"],
      avisos: [],
    },
  ],
  agregados: {
    total: { clave: "total", clientes: 1, clientesConMargen: 1, ingresoMxn: 12000, costoDirectoMxn: 2950.94, contribucionPct: 75.41, margenBrutoPct: null, llamadas: 900, minutosVoz: 2880, duracionPromedioMin: 3.2, conversacionesWa: 1500, pedidos: 1100 },
    porVertical: [{ clave: "restaurantes", clientes: 1, clientesConMargen: 1, ingresoMxn: 12000, costoDirectoMxn: 2950.94, contribucionPct: 75.41, margenBrutoPct: null, llamadas: 900, minutosVoz: 2880, duracionPromedioMin: 3.2, conversacionesWa: 1500, pedidos: 1100 }],
    porPlan: [],
  },
  saas: {
    mrrMxn: 12000,
    arrMxn: 144000,
    clientes: 1,
    arpaMxn: 12000,
    serie: [{ mes: "2026-11", mrrMxn: 12000, clientes: 1, arpaMxn: 12000, nuevoMxn: null, expansionMxn: null, contraccionMxn: null, churnMxn: null, nrrPct: null, grrPct: null, churnLogosPct: null }],
    margen: { contribucionPct: 75.41, margenBrutoPct: null },
    ltv: { disponible: true, ltvMxn: 325749, churnMensualPct: null, vidaMeses: 36, vidaTopada: true, margenBrutoPct: 75.41 },
    cac: NO,
    burn: { disponible: false, razon: "Sin tipo de cambio" },
    cohortes: [],
    concentracion: { top1Pct: 100, top5Pct: 100, hhi: 10000 },
    fx: { disponible: true, mxnPorUsd: 18.6297, fecha: "2026-11-06", fuente: "Banxico FIX", costoUsd: 158.4, exposicionPct: 24.59, sensibilidad10PctMxn: 295.09, movimiento30dPct: 1.2 },
    presupuesto: [],
  },
  alertas: { cfo: [{ codigo: "cobranza_vencida", severidad: "alta", titulo: "Cobranza vencida", organizaciones: [{ organizationId: "pm", nombre: "Pizzería Modelo", dato: "pago pendiente" }] }], cockpit: [] },
  faltantes: ["Captura los gastos fijos de 2026-11 (nómina, renta, herramientas): sin ellos el burn y el runway salen incompletos."],
  medidorCobro: true,
};

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function stubApi(respuesta: RespuestaCockpit | "fallo" = COCKPIT) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ruta = new URL(url).pathname;
      if (ruta === "/superadmin/cfo/cockpit") return respuesta === "fallo" ? json({ message: "boom" }, 500) : json(respuesta);
      if (ruta === "/superadmin/cfo/capturas") return json({ disponible: true, capturas: [] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
}

async function montar(): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter>
      <SuperAdminCfoPlataformaPage apiBaseUrl="https://api.test" token="tok" />
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
  return r;
}

const texto = () => rendered!.container.textContent ?? "";

describe("SuperAdminCfoPlataformaPage", () => {
  it("pinta KPIs, lo que falta capturar y las alertas que entrega la API; un KPI sin fuente dice por qué", async () => {
    stubApi();
    rendered = await montar();
    expect(rendered.container.querySelector("h1")?.textContent).toBe("CFO de la plataforma");
    expect(texto()).toContain("MRR");
    expect(texto()).toContain("$12,000");
    expect(texto()).toContain("Captura los gastos fijos de 2026-11");
    expect(texto()).toContain("Cobranza vencida");
    expect(texto()).toContain("Pizzería Modelo: pago pendiente");
    expect(texto()).toContain("Captura el gasto de marketing");
    expect(texto()).toContain("tope: sin churn medido");
    expect(texto()).toContain("15 de 30 días");
  });

  it("sin la migración muestra el estado honesto; con error, reintentar", async () => {
    stubApi({ disponible: false, mes: "2026-11", mensaje: "falta aplicar la migración 0030" } as RespuestaCockpit);
    rendered = await montar();
    expect(texto()).toContain("aún no está disponible");
    rendered.unmount();
    stubApi("fallo");
    rendered = await montar();
    expect(texto()).toMatch(/Reintentar/);
  });

  it("la ruta existe en el menú (Negocio) y en App.tsx", () => {
    expect(NEGOCIO.some((r) => r.to === "/superadmin/cfo-plataforma")).toBe(true);
    expect(appSrc).toContain('path="/superadmin/cfo-plataforma"');
  });

  it("recomendaciones: pide POST, muestra la fuente, los hechos que respaldan cada una y las descartadas", async () => {
    const llamadas: Array<{ ruta: string; metodo: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        llamadas.push({ ruta: new URL(url).pathname, metodo: init?.method ?? "GET" });
        return json({
          disponible: true,
          fuente: "modelo",
          modelo: "modelo-barato",
          descartadas: 1,
          recomendaciones: [{ titulo: "Acortar llamadas de PM", explicacion: "Promedian 3.2 min con margen de 50.8 %.", accion: "Revisar el guion.", prioridad: 1, hechos: ["h1"] }],
          hechos: [{ id: "h1", texto: "Vertical restaurantes: 900 llamadas de 3.2 min en promedio; margen 50.8 %." }],
        });
      }),
    );
    rendered = renderComponent(
      <MemoryRouter>
        <Recomendaciones mes="2026-11" apiBaseUrl="https://api.test" token="tok" />
      </MemoryRouter>,
    );
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Generar"))!;
    await act(async () => {
      boton.click();
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    expect(llamadas).toEqual([{ ruta: "/superadmin/cfo/recomendaciones", metodo: "POST" }]);
    expect(texto()).toContain("Redactadas por modelo-barato");
    expect(texto()).toContain("1 descartadas");
    expect(texto()).toContain("De dónde sale: Vertical restaurantes: 900 llamadas de 3.2 min");
  });
});

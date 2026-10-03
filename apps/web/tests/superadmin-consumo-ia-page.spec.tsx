// @vitest-environment jsdom
//
// SA-L-22: /superadmin/consumo-ia = Gasto de API de LLM (pagina existente, incrustada) + insights deterministas, costo diario y
// tabla por rol de hoy contra su techo. Backend simulado a nivel `fetch`; la logica de los insights vive en la API (su prueba:
// apps/api/tests/superadmin-consumo-ia.spec.ts): aqui se verifica que la pagina pinte lo que el endpoint entrega, ni mas ni menos.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { REDIRECCIONES_SUPERADMIN } from "../src/superadmin/rutas.ts";
import { SuperAdminConsumoIaPage } from "../src/superadmin/pages/ConsumoIa.tsx";
import type { RespuestaConsumoIa } from "../src/superadmin/pages/ConsumoIa.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const aqui = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(aqui, "../src/App.tsx"), "utf8");

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const DIAS = Array.from({ length: 14 }, (_, i) => `2026-09-${String(19 + i).padStart(2, "0")}`);
const cero = { costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 };

const CONSUMO: RespuestaConsumoIa = {
  hoy: "2026-10-02",
  desde: "2026-09-03",
  disponible: true,
  roles: [
    { role: "restaurantes:data_chat", grupo: "restaurantes", hoy: { costMicroUsd: 4000, callCount: 200, fallbackCallCount: 20 }, ventana: { costMicroUsd: 90000, callCount: 1000, fallbackCallCount: 200 }, techoTurnosDia: 400, maxTurnosOrganizacionHoy: 200, pctTecho: 50 },
    { role: "restaurantes:whatsapp_agent", grupo: "restaurantes", hoy: { costMicroUsd: 500, callCount: 7, fallbackCallCount: 0 }, ventana: { costMicroUsd: 800, callCount: 12, fallbackCallCount: 0 }, techoTurnosDia: null, maxTurnosOrganizacionHoy: 7, pctTecho: null },
  ],
  insights: [
    { codigo: "organizacion_cerca_del_tope", severidad: "alta", titulo: "Los Taquitos de PM lleva 112 % de su tope mensual", detalle: "US$0.0045 de US$0.0040 este mes (umbral 80 %).", organizationId: "o1" },
    { codigo: "rol_con_fallbacks", severidad: "atencion", titulo: "El rol restaurantes:data_chat cae a su modelo de respaldo 20 % de las veces", detalle: "200 de 1000 llamadas usaron respaldo en la ventana (umbral 10 %).", role: "restaurantes:data_chat" },
    { codigo: "rol_sin_techo", severidad: "info", titulo: "El rol restaurantes:whatsapp_agent no tiene techo diario", detalle: "12 llamadas sin un tope de turnos por día.", role: "restaurantes:whatsapp_agent" },
  ],
};
const VACIO: RespuestaConsumoIa = { hoy: "2026-10-02", desde: "2026-09-03", disponible: true, roles: [], insights: [] };

const GASTO_RESUMEN = {
  range: { from: "2026-09-03", to: "2026-10-02" },
  usage: { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 },
  platformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
};

interface Opciones {
  consumo?: RespuestaConsumoIa | "fallo";
  resumenConsola?: unknown | "fallo";
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function stubApi(o: Opciones = {}) {
  const llamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ruta = new URL(url).pathname;
      llamadas.push(ruta);
      if (ruta === "/superadmin/gasto-api/consumo-ia") return o.consumo === "fallo" ? json({ message: "boom" }, 500) : json(o.consumo ?? CONSUMO);
      if (ruta === "/superadmin/consola/resumen") {
        if (o.resumenConsola === "fallo") return json({ message: "boom" }, 500);
        return json(o.resumenConsola ?? { gastoIa: { valor: { totalUsd: 1, llmUsd: 1, otrosUsd: 0, porCategoria: [], serie14d: { valor: DIAS.map((dia, i) => ({ dia, usd: 1 + i })) }, delta7d: { valor: null } } } });
      }
      if (ruta === "/superadmin/gasto-api/resumen") return json(GASTO_RESUMEN);
      if (ruta === "/superadmin/gasto-api/organizaciones") return json({ organizaciones: [] });
      if (ruta === "/superadmin/gasto-api/desglose") return json({ desglose: [] });
      if (ruta === "/superadmin/gasto-api/por-rol") return json({ disponible: true, filas: [] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
  return llamadas;
}

async function montar(): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter>
      <SuperAdminConsumoIaPage apiBaseUrl="https://api.test" token="tok" />
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
  return r;
}

const texto = () => rendered!.container.textContent ?? "";

describe("SuperAdminConsumoIaPage", () => {
  it("un solo h1 'Consumo de IA' (la pagina de gasto va incrustada) y conserva todo el contenido de Gasto de API de LLM", async () => {
    stubApi();
    rendered = await montar();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")?.textContent).toBe("Consumo de IA");
    expect(texto()).toContain("Tope global de plataforma");
    expect(texto()).toContain("Gasto por organización");
    expect(texto()).toContain("Desglose por proveedor y modelo");
  });

  it("tabla por rol: gasto de hoy contra su techo; un rol sin tope se pinta 'sin techo'", async () => {
    stubApi();
    rendered = await montar();
    expect(texto()).toContain("Gasto de hoy por rol / agente");
    expect(texto()).toContain("US$0.0040");
    expect(texto()).toContain("200 de 400");
    expect(texto()).toContain("sin techo");
    expect(texto()).toContain("restaurantes:whatsapp_agent");
    // Respaldo de 30 d: 200 / 1000 = 20 %.
    expect(texto()).toContain("20 %");
  });

  it("los insights que entrega el endpoint se pintan con su severidad; sin insights no aparece ninguna alerta", async () => {
    stubApi();
    rendered = await montar();
    const alertas = rendered.container.querySelector('section[aria-label="Alertas de consumo de IA"]')!;
    expect(alertas.textContent).toContain("112 % de su tope mensual");
    expect(alertas.textContent).toContain("respaldo 20 %");
    expect(alertas.textContent).toContain("no tiene techo diario");
    rendered.unmount();

    stubApi({ consumo: VACIO });
    rendered = await montar();
    expect(rendered.container.querySelector('section[aria-label="Alertas de consumo de IA"]')).toBeNull();
    expect(texto()).toContain("Ningún rol ha registrado llamadas");
  });

  it("costo diario: area de 14 dias del resumen; si el resumen falla muestra su error y el resto sigue", async () => {
    stubApi();
    rendered = await montar();
    expect(texto()).toContain("Costo de IA por día");
    expect(rendered.container.querySelector("svg")).not.toBeNull();
    rendered.unmount();

    stubApi({ resumenConsola: "fallo" });
    rendered = await montar();
    expect(texto()).toContain("No se pudo cargar");
    expect(texto()).toContain("Gasto de hoy por rol / agente");
  });

  it("base sin migrar (disponible=false): aviso 'no disponible aun', sin tabla por rol, y las alertas por organizacion siguen", async () => {
    stubApi({ consumo: { ...VACIO, disponible: false, mensaje: "El reporte por rol requiere la migración 0047, que aún no está aplicada.", insights: [CONSUMO.insights[0]!] } });
    rendered = await montar();
    expect(texto()).toContain("No disponible aún");
    expect(texto()).toContain("0047");
    expect(texto()).not.toContain("Gasto de hoy por rol / agente");
    expect(texto()).toContain("112 % de su tope mensual");
  });

  it("si el endpoint falla muestra el error con reintento y no tumba el resto de la pagina", async () => {
    stubApi({ consumo: "fallo" });
    rendered = await montar();
    expect(texto()).toContain("No se pudo cargar");
    expect(texto()).toContain("Reintentar");
    expect(texto()).toContain("Tope global de plataforma");
  });
});

describe("rutas viejas de gasto de API y CFO", () => {
  it("gasto-api redirige a consumo-ia (ruta real en App.tsx) y cfo a ejecutivo", () => {
    expect(REDIRECCIONES_SUPERADMIN["/superadmin/gasto-api"]).toBe("/superadmin/consumo-ia");
    expect(REDIRECCIONES_SUPERADMIN["/superadmin/cfo"]).toBe("/superadmin/ejecutivo");
    expect(appSrc).toContain('path="/superadmin/consumo-ia"');
    expect(appSrc).toContain('path="/superadmin/ejecutivo"');
    expect(appSrc).not.toContain('path="/superadmin/gasto-api"');
    expect(appSrc).not.toContain('path="/superadmin/cfo"');
  });

  it("al visitar /superadmin/gasto-api se llega a /superadmin/consumo-ia", async () => {
    function Ubicacion() {
      return <output data-testid="u">{useLocation().pathname}</output>;
    }
    const r = renderComponent(
      <MemoryRouter initialEntries={["/superadmin/gasto-api"]}>
        <Routes>
          {Object.entries(REDIRECCIONES_SUPERADMIN).map(([desde, hacia]) => (
            <Route key={desde} path={desde} element={<Navigate to={hacia} replace />} />
          ))}
          <Route path="/superadmin/consumo-ia" element={<Ubicacion />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(r.container.querySelector('[data-testid="u"]')?.textContent).toBe("/superadmin/consumo-ia");
    r.unmount();
  });
});

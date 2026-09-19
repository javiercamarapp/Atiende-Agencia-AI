// @vitest-environment jsdom
//
// Smoke tests reales de <CierreMensualPage /> (despachos — la tarea operativa
// más recurrente y de mayor riesgo del vertical: bloquea la facturación del mes
// siguiente si no se abre a tiempo). Mismo patrón que
// despachos-cierre-mensual-client.spec.ts pero a nivel de componente: `fetch`
// global mockeado por ruta real contra cierre-mensual-client.ts, estados de
// carga/vacío/error, datos reales (período/estatus/fechas), y la interacción
// principal (abrir un período nuevo) verificando método/ruta/cuerpo reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CierreMensualPage } from "../src/verticals/despachos/pages/CierreMensual.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

const PERIODO = { id: "per-1", organizationId: "org-1", propertyId: "prop-1", year: 2026, month: 8, status: "open" as const, openedAt: "2026-09-01T00:00:00.000Z", closedAt: null, closedBy: null };

interface Handlers {
  periodos?: readonly (typeof PERIODO)[] | (() => readonly (typeof PERIODO)[]);
  periodosOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/cierre-mensual/periodos")) {
      const list = typeof handlers.periodos === "function" ? handlers.periodos() : (handlers.periodos ?? []);
      return jsonResponse({ periodos: list }, handlers.periodosOk ?? true);
    }
    if (method === "POST" && url.endsWith("/cierre-mensual/periodos")) {
      return jsonResponse({ periodo: { ...PERIODO, id: "per-nuevo" }, tareas: [] });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <CierreMensualPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CierreMensualPage (despachos)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ periodos: [] });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando períodos de cierre");
  });

  it("estado vacío explícito cuando no hay ningún período abierto — nunca un error", async () => {
    stubFetch({ periodos: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todavía no hay ningún período de cierre abierto");
  });

  it("estado de error real cuando el fetch de períodos falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ periodos: [], periodosOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando períodos de cierre");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("renderiza un período real: mes/año formateado y estatus", async () => {
    stubFetch({ periodos: [PERIODO] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("agosto 2026");
    expect(text).toContain("Abierto");
  });

  it("el link del período apunta a la ruta real /despachos/demo/cierre-mensual/per-1", async () => {
    stubFetch({ periodos: [PERIODO] });
    rendered = renderPage();
    await esperarCarga();
    const link = rendered.container.querySelector('a[href="/despachos/demo/cierre-mensual/per-1"]');
    expect(link).not.toBeNull();
  });

  it("abrir período: POST .../cierre-mensual/periodos con {anio,mes} reales y recarga la lista", async () => {
    let current: readonly (typeof PERIODO)[] = [];
    stubFetch({ periodos: () => current });
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Abrir período")!;
    await act(async () => {
      abrirBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    changeValue(rendered.container.querySelector("#cierre-anio") as HTMLInputElement, "2026");
    changeValue(rendered.container.querySelector("#cierre-mes") as HTMLInputElement, "9");
    current = [{ ...PERIODO, id: "per-nuevo", month: 9 }];

    const form = rendered.container.querySelector("form")!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/despachos/prop-1/cierre-mensual/periodos" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ anio: 2026, mes: 9 });
    expect(rendered.container.textContent).toContain("septiembre 2026");
  });

  it("abrir período con mes inválido: muestra error de validación real y NUNCA llama a la API", async () => {
    stubFetch({ periodos: [] });
    rendered = renderPage();
    await esperarCarga();

    const abrirBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Abrir período")!;
    await act(async () => {
      abrirBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    changeValue(rendered.container.querySelector("#cierre-mes") as HTMLInputElement, "13");

    const callsAntes = fetchMock.mock.calls.length;
    await submitForm(rendered.container.querySelector("form")!);

    expect(rendered.container.textContent).toContain("Mes inválido (1-12).");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });
});

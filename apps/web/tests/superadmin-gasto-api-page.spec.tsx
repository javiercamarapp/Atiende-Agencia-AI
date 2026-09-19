// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminGastoApiPage /> — mismo patrón que
// rentas-registro-page.spec.tsx (hallazgo de auditoría rubro 9, "0 tests de
// componentes React"): esta pantalla es la ÚNICA del back office de
// plataforma con lógica de fetch/edición propia digna de un smoke test
// dedicado (Prospectos.tsx/Dashboard.tsx/Paneles.tsx no tenían ninguno antes
// de esta ronda tampoco — no se inventa infraestructura de test nueva más
// allá de lo que rentas-registro-page.spec.tsx ya estableció, solo se
// reutiliza: `renderComponent`/`changeValue`/`submitForm`/`click` de
// ./test-utils/render.tsx, y un `fetch` global mockeado en vez de un módulo
// "cliente" separado -- este componente, igual que Prospectos.tsx, llama
// `fetch` directo (no hay ningún `*-client.ts` que interceptar).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminGastoApiPage } from "../src/superadmin/pages/GastoApi.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

/** Las 3 llamadas de `cargar()` (resumen/organizaciones/desglose) corren en
 *  paralelo fuera de cualquier `act()` propio (disparadas por el `useEffect`
 *  inicial) -- mismo patrón que `restaurantes-shell-mobile-nav.spec.tsx`:
 *  envolver el drenado de microtasks en `act(async () => ...)` en vez de
 *  llamar `flushMicrotasks()` suelto. */
async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const RESUMEN_VACIO = {
  range: { from: "2026-08-01", to: "2026-08-31" },
  usage: { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 },
  platformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
};

function stubFetch(handlers: { resumen?: unknown; organizaciones?: unknown; desglose?: unknown; put?: (url: string, body: unknown) => void }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      handlers.put?.(url, init.body ? JSON.parse(String(init.body)) : null);
      return jsonResponse({ ok: true });
    }
    if (url.includes("/superadmin/gasto-api/resumen")) return jsonResponse(handlers.resumen ?? RESUMEN_VACIO);
    if (url.includes("/superadmin/gasto-api/organizaciones")) return jsonResponse(handlers.organizaciones ?? { organizaciones: [] });
    if (url.includes("/superadmin/gasto-api/desglose")) return jsonResponse(handlers.desglose ?? { desglose: [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminGastoApiPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminGastoApiPage", () => {
  it("muestra el estado de carga primero, y después los totales del periodo en cero cuando no hay uso registrado", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando gasto de API de LLM");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Gasto de API de LLM");
    expect(rendered.container.textContent).toContain("$0.00");
    // Nunca datos falsos: sin credenciales de LLM configuradas, ceros reales.
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("estado vacío real cuando no hay ninguna organización todavía", async () => {
    stubFetch({ organizaciones: { organizaciones: [] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Todavía no hay organizaciones dadas de alta");
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar el gasto de API de LLM");
  });

  it("renderiza el desglose por organización con % de tope usado, y la barra de tope de plataforma", async () => {
    stubFetch({
      resumen: {
        range: { from: "2026-08-01", to: "2026-08-31" },
        usage: { tokensIn: 1500, tokensOut: 900, costMicroUsd: 42_000_000, callCount: 12, fallbackCallCount: 1 },
        platformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 500_000_000 },
      },
      organizaciones: {
        organizaciones: [
          {
            organizationId: "org-1",
            organizationName: "Hotel Test",
            organizationSlug: "hotel-test",
            vertical: "hoteles",
            tokensIn: 1500,
            tokensOut: 900,
            costMicroUsd: 42_000_000,
            callCount: 12,
            monthlyCapMicroUsd: 100_000_000,
            alertThresholdPct: 80,
            spendThisMonthMicroUsd: 90_000_000,
            pctTopeUsado: 90,
          },
        ],
      },
      desglose: { desglose: [{ vertical: "hoteles", providerId: "anthropic", model: "claude-x", tokensIn: 1500, tokensOut: 900, costMicroUsd: 42_000_000, callCount: 12 }] },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Hotel Test");
    expect(rendered.container.textContent).toContain("$42.00");
    expect(rendered.container.textContent).toContain("90.0% del tope");
    expect(rendered.container.textContent).toContain("50.0% del tope"); // plataforma: 500M/1000M
    expect(rendered.container.textContent).toContain("anthropic");
    expect(rendered.container.textContent).toContain("claude-x");
  });

  it("editar el tope de una organización arma el PUT correcto (USD -> micro-USD) y recarga", async () => {
    stubFetch({
      organizaciones: {
        organizaciones: [
          {
            organizationId: "org-1",
            organizationName: "Hotel Test",
            organizationSlug: "hotel-test",
            vertical: "hoteles",
            tokensIn: 0,
            tokensOut: 0,
            costMicroUsd: 0,
            callCount: 0,
            monthlyCapMicroUsd: 100_000_000,
            alertThresholdPct: 80,
            spendThisMonthMicroUsd: 0,
            pctTopeUsado: 0,
          },
        ],
      },
    });
    let capturedUrl = "";
    let capturedBody: unknown = null;
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    // Exactamente "Editar" (fila de la organización) -- distinto del botón
    // "Editar tope" del tope GLOBAL de plataforma, que aparece antes en el DOM.
    const editarBtn = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Editar");
    expect(editarBtn).toBeDefined();
    click(editarBtn!);

    // El modal (Dialog de Radix) porta su contenido a `document.body` vía
    // Portal -- nunca queda dentro de `rendered.container`.
    const montoInput = document.body.querySelector("#tope-organizacion-monto") as HTMLInputElement;
    expect(montoInput).not.toBeNull();
    expect(montoInput.value).toBe("100"); // 100_000_000 micro-USD -> $100
    changeValue(montoInput, "250");

    // Re-stub para capturar el PUT específico de esta prueba.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        capturedUrl = url;
        capturedBody = JSON.parse(String(init.body));
        return jsonResponse({ ok: true });
      }
      if (url.includes("/resumen")) return jsonResponse(RESUMEN_VACIO);
      if (url.includes("/organizaciones")) return jsonResponse({ organizaciones: [] });
      return jsonResponse({ desglose: [] });
    });

    const form = document.body.querySelector("#form-tope-organizacion") as HTMLFormElement;
    await submitForm(form);

    expect(capturedUrl).toContain("/superadmin/gasto-api/organizaciones/org-1/tope");
    expect(capturedBody).toMatchObject({ monthlyCapUsd: 250, alertThresholdPct: 80 });
  });
});

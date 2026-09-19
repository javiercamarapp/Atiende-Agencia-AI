// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminSaludPage /> -- mismo patrón que
// superadmin-gasto-api-page.spec.tsx/superadmin-facturacion-page.spec.tsx:
// `fetch` global mockeado, estados de carga/vacío/error, y el caso especial
// "entorno recién desplegado" (ningún cron corrió todavía -- debe verse como
// un estado vacío claro, nunca un error).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminSaludPage } from "../src/superadmin/pages/Salud.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const RESUMEN_VACIO = {
  alertas: [],
  resumen: {
    crons: { total: 0, ok: 0, vencido: 0, sinLatido: 0, error: 0 },
    colas: { total: 0, muertos: 0, pendientes: 0 },
    licitacionesFuentes: { total: 0, conAlerta: 0 },
  },
};

function stubFetch(handlers: { salud?: unknown; crons?: unknown; colas?: unknown; fuentes?: unknown }) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/superadmin/salud/crons")) return jsonResponse(handlers.crons ?? { crons: [] });
    if (url.includes("/superadmin/salud/colas")) return jsonResponse(handlers.colas ?? { colas: [] });
    if (url.includes("/superadmin/salud/licitaciones-fuentes")) return jsonResponse(handlers.fuentes ?? { fuentes: [] });
    if (url.includes("/superadmin/salud")) return jsonResponse(handlers.salud ?? RESUMEN_VACIO);
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminSaludPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminSaludPage", () => {
  it("muestra el estado de carga primero, y después el título real", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando salud operativa");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Salud operativa");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar la salud operativa");
  });

  it("entorno recién desplegado (todos los crons 'sin_latido') -- dice 'sin latidos todavía' claramente, NUNCA un error", async () => {
    const cronsSinLatido = Array.from({ length: 3 }, (_, i) => ({
      cronName: `/internal/test/cron-${i}`,
      estado: "sin_latido",
      heartbeat: null,
    }));
    stubFetch({ crons: { crons: cronsSinLatido } });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Sin latidos todavía");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("una alerta 'critica' real se muestra con su título y detalle", async () => {
    stubFetch({
      salud: {
        alertas: [{ severidad: "critica", titulo: "Cron con error: /internal/whatsapp/dispatch", detalle: "WHATSAPP_ACCESS_TOKEN inválido", href: "/superadmin/salud/crons" }],
        resumen: RESUMEN_VACIO.resumen,
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Cron con error: /internal/whatsapp/dispatch");
    expect(rendered.container.textContent).toContain("WHATSAPP_ACCESS_TOKEN inválido");
  });

  it("sin alertas -- muestra el estado vacío de 'Alertas accionables', no un error", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Sin alertas");
  });

  it("renderiza una cola real con mensajes muertos", async () => {
    stubFetch({
      colas: { colas: [{ queueName: "hoteles", pendingCount: 1, processingCount: 0, sentCount: 10, failedCount: 0, deadCount: 3, oldestPendingSeconds: 7200, lastSentAt: null }] },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Hoteles");
    expect(rendered.container.textContent).toContain("3");
  });

  it("renderiza una fuente de licitaciones real con su organización y estado", async () => {
    stubFetch({
      fuentes: {
        fuentes: [{ organizationId: "org-1", organizationName: "Org Uno", source: "compras_mx_historico", state: "captcha_detected", finishedAt: "2026-09-19T00:00:00.000Z", message: "403 Access Denied" }],
      },
    });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Org Uno");
    expect(rendered.container.textContent).toContain("compras_mx_historico");
    expect(rendered.container.textContent).toContain("captcha_detected");
  });
});

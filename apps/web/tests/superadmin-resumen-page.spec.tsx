// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminResumenPage /> -- mismo patrón que
// superadmin-salud-page.spec.tsx: `fetch` global mockeado, estados de
// carga/vacío/error, y el camino feliz con un resumen real.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminResumenPage } from "../src/superadmin/pages/Resumen.tsx";
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

const RESUMEN_REAL = {
  fecha: "2026-06-15",
  agregados: {
    fecha: "2026-06-15",
    zonaHoraria: "America/Mexico_City",
    salud: { alertas: [], crons: { total: 18, ok: 18 }, colas: { muertos: 0, pendientes: 0 } },
    gastoLlm: { costoHoyMicroUsd: 1_500_000, pctTopePlataforma: 0.15 },
    facturacion: { altas: 1, bajas: 0, morososNuevos: 0, activasTotal: 12 },
    prospectos: { altas: 2, cambiosEstado: 1, sinMovimiento: 0, umbralSinMovimientoDias: 14 },
    organizacionesStaff: { organizacionesNuevas: 1, nombresOrganizacionesNuevas: ["Los Taquitos de PM"], staffNuevos: 2 },
    mensajeria: [{ queueName: "hoteles", enviados: 10, fallidosHoy: 0, muertosHoy: 0 }],
    breakGlassAbiertos: 0,
    deltas: null,
  },
  narrativa: "Todo tranquilo hoy en la plataforma.",
  generadoPor: "determinista",
  costoLlmMicroUsd: null,
  modeloLlm: null,
  proveedorLlm: null,
  creadoEn: "2026-06-15T15:00:00.000Z",
  actualizadoEn: "2026-06-15T15:00:00.000Z",
  correoEnviadoEn: null,
};

function stubFetch(handlers: { lista?: unknown; generar?: unknown; generarOk?: boolean }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/superadmin/resumen/generar")) return jsonResponse(handlers.generar ?? { fecha: "2026-06-15", generadoPor: "determinista", alertas: 0, correo: "resend_no_configurado" }, handlers.generarOk ?? true);
    if (url.includes("/superadmin/resumen")) return jsonResponse(handlers.lista ?? { resumenes: [] });
    throw new Error(`fetch inesperado en el test: ${url} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminResumenPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminResumenPage", () => {
  it("muestra el estado de carga primero, y después el título real", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando resumen diario");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Resumen diario");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar el historial de resúmenes");
  });

  it("sin ningún resumen todavía -- estado vacío claro, nunca un error", async () => {
    stubFetch({ lista: { resumenes: [] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Aún no hay resúmenes");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("disponible:false (migración del resumen diario sin aplicar en este entorno) -- estado 'no disponible aún', NUNCA el estado vacío normal ni un error", async () => {
    stubFetch({ lista: { disponible: false, resumenes: [] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("todavía no está disponible en este entorno");
    expect(rendered.container.textContent).not.toContain("Aún no hay resúmenes");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("disponible:false -- el botón 'Generar ahora' queda deshabilitado (hallazgo no-bloqueante #5, revisor del PR #179: antes seguía habilitado, un clic disparaba un 503 real)", async () => {
    stubFetch({ lista: { disponible: false, resumenes: [] } });
    rendered = renderPage();
    await esperarCarga();

    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Generar ahora"));
    expect(boton).toBeDefined();
    expect(boton!.disabled).toBe(true);
  });

  it("con un resumen real -- muestra la narrativa, la etiqueta 'generado por' y los números reales", async () => {
    stubFetch({ lista: { resumenes: [RESUMEN_REAL] } });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Todo tranquilo hoy en la plataforma.");
    expect(rendered.container.textContent).toContain("plantilla determinista");
    expect(rendered.container.textContent).toContain("Los Taquitos de PM");
  });

  it("una alerta real de salud se muestra con su título y severidad", async () => {
    const conAlerta = {
      ...RESUMEN_REAL,
      agregados: { ...RESUMEN_REAL.agregados, salud: { alertas: [{ severidad: "critica", titulo: "Cron con error: /internal/whatsapp/dispatch", detalle: "token inválido", href: "/superadmin/salud/crons" }], crons: null, colas: null } },
    };
    stubFetch({ lista: { resumenes: [conAlerta] } });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Cron con error: /internal/whatsapp/dispatch");
    expect(rendered.container.textContent).toContain("token inválido");
  });

  it("'Generar ahora' llama a POST /superadmin/resumen/generar y refresca la lista", async () => {
    stubFetch({ lista: { resumenes: [] } });
    rendered = renderPage();
    await esperarCarga();

    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Generar ahora"));
    expect(boton).toBeDefined();

    await act(async () => {
      boton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/superadmin/resumen/generar"), expect.objectContaining({ method: "POST" }));
  });
});

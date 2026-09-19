// @vitest-environment jsdom
//
// Smoke tests reales de <FraudePage /> (cola de fraude interno — dinero real:
// confirmar o descartar cargos/pagos sospechosos). Mismo patrón que el resto
// de páginas de hoteles: `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/fraude.ts, `toast` mockeado (sonner,
// mismo criterio que superadmin-acciones-page.spec.tsx), `window.prompt`
// mockeado (hallazgo de auditoría ya corregido en el componente: cancelar el
// prompt NUNCA debe llamar a la API), estados de carga/vacío/error, filtro por
// estado, ejecutar escaneo y resolver una alerta (confirmar/descartar).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
// `@atiende/ui` reexporta `toast` de "sonner" -- mockear ahí cubre la misma
// importación real que usa la página (mismo criterio que
// superadmin-acciones-page.spec.tsx).
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { FraudePage } from "../src/verticals/hoteles/pages/Fraude.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { FraudAlertSummary } from "../src/verticals/hoteles/lib/fraude-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

// "descuento_fuera_de_politica" -- uno de los DOS patrones reales portados en
// `@atiende/domain-hoteles/src/fraude/deteccion.ts::FRAUD_PATTERNS` (el otro es
// "folio_reabierto_post_auditoria"). Antes decía "cargo_reversado_repetido", un
// patrón que no existe en el dominio (el contrato de `patron` es `string` así que
// no falla el typecheck, pero el fixture inventaba datos que la API real jamás
// produce).
const ALERTA_PENDIENTE: FraudAlertSummary = {
  id: "alert-1",
  patron: "descuento_fuera_de_politica",
  folioId: "folio-1",
  cargoId: "ch-1",
  pagoId: null,
  razon: "El descuento 500 del cargo ch-1 supera el umbral configurado (200) y no tiene autorización de un rol administrativo.",
  evidencia: { discountAmount: 500, thresholdAmount: 200 },
  rolesDestinatario: ["owner", "gm"],
  estado: "pendiente",
  notaDecision: null,
  resueltoPor: null,
  resueltoEn: null,
  creadoEn: "2026-09-18T10:00:00.000Z",
};

interface Handlers {
  alerts?: readonly FraudAlertSummary[] | (() => readonly FraudAlertSummary[]);
  alertsOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/fraude/alertas")) {
      const alerts = typeof handlers.alerts === "function" ? handlers.alerts() : (handlers.alerts ?? [ALERTA_PENDIENTE]);
      return jsonResponse(alerts, handlers.alertsOk ?? true);
    }
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/fraude/escaneos") {
      return jsonResponse({ alertas: [], generadas: 2, yaExistentes: 1 });
    }
    if (method === "POST" && /\/fraude\/alertas\/alert-1\/(confirmar|descartar)$/.test(url)) {
      const decision = url.endsWith("confirmar") ? "confirmado" : "descartado";
      return jsonResponse({ ...ALERTA_PENDIENTE, estado: decision, notaDecision: JSON.parse(init!.body as string).nota ?? null });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <FraudePage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("FraudePage (hoteles)", () => {
  it("muestra el estado de carga primero y pide el filtro por defecto 'pendiente'", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando alertas");
    await esperarCarga();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/hoteles/prop-1/fraude/alertas?estado=pendiente");
  });

  it("estado vacío honesto cuando no hay alertas en el filtro", async () => {
    stubFetch({ alerts: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay alertas en este filtro.");
  });

  it("estado de error real con reintentar — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ alertsOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando alertas");
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
  });

  it("reintentar tras un error vuelve a pedir las alertas", async () => {
    let ok = false;
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://api.test/hoteles/prop-1/fraude/alertas")) return jsonResponse([ALERTA_PENDIENTE], ok);
      throw new Error(`fetch inesperado en el test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");

    ok = true;
    const retryBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Reintentar")!;
    await act(async () => {
      click(retryBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("descuento_fuera_de_politica");
  });

  it("renderiza la alerta real: patrón, razón, folio/cargo y roles destinatario", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("descuento_fuera_de_politica");
    expect(text).toContain("El descuento 500 del cargo ch-1 supera el umbral configurado (200) y no tiene autorización de un rol administrativo.");
    expect(text).toContain("Folio: folio-1");
    expect(text).toContain("Cargo: ch-1");
    expect(text).toContain("owner, gm");
    expect(text).toContain("Pendiente");
  });

  it("cambiar el filtro a 'confirmado' vuelve a pedir las alertas con ese estado", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const tab = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Confirmado")!;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.at(-1)!;
    expect(call[0]).toBe("https://api.test/hoteles/prop-1/fraude/alertas?estado=confirmado");
  });

  it("ejecutar escaneo: POST .../fraude/escaneos, toast.success con el conteo real, y recarga la lista", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const scanBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Ejecutar escaneo"))!;
    await act(async () => {
      scanBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(fetchMock.mock.calls.some(([url, init]) => url === "https://api.test/hoteles/prop-1/fraude/escaneos" && init?.method === "POST")).toBe(true);
    expect(toastMock.success).toHaveBeenCalledWith("Escaneo completo: 2 alerta(s) nueva(s), 1 ya existían.");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("escaneo fallido: muestra el error real y NUNCA llama a toast.success", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return jsonResponse([ALERTA_PENDIENTE]);
      if (method === "POST" && url.endsWith("/escaneos")) return jsonResponse({ error: "boom" }, false);
      throw new Error(`fetch inesperado: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    const scanBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Ejecutar escaneo"))!;
    await act(async () => {
      scanBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
  });

  it("cancelar el prompt de decisión (window.prompt -> null) NUNCA llama a la API — hallazgo de auditoría ya corregido", async () => {
    stubFetch({});
    const promptMock = vi.spyOn(window, "prompt").mockReturnValue(null);
    rendered = renderPage();
    await esperarCarga();

    const callsAntes = fetchMock.mock.calls.length;
    const confirmarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Confirmar")!;
    await act(async () => {
      confirmarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(promptMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
    // Sigue pendiente: no se resolvió nada.
    expect(rendered.container.textContent).toContain("Pendiente");
  });

  it("confirmar una alerta real (prompt con nota): POST .../confirmar con la nota real, y recarga (la alerta ya no aparece en 'pendiente')", async () => {
    let alertasActuales: readonly FraudAlertSummary[] = [ALERTA_PENDIENTE];
    stubFetch({ alerts: () => alertasActuales });
    vi.spyOn(window, "prompt").mockReturnValue("Confirmado tras revisar bitácora de recepción.");
    rendered = renderPage();
    await esperarCarga();

    const confirmarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Confirmar")!;
    alertasActuales = []; // El filtro sigue en "pendiente": tras confirmar, ya no hay alertas pendientes.
    await act(async () => {
      confirmarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/fraude/alertas/alert-1/confirmar" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ nota: "Confirmado tras revisar bitácora de recepción." });
    expect(rendered.container.textContent).toContain("No hay alertas en este filtro.");
  });

  it("descartar una alerta real (prompt sin nota, cadena vacía): POST .../descartar con nota undefined", async () => {
    stubFetch({});
    vi.spyOn(window, "prompt").mockReturnValue("");
    rendered = renderPage();
    await esperarCarga();

    const descartarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Descartar")!;
    await act(async () => {
      descartarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/fraude/alertas/alert-1/descartar" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({});
  });
});

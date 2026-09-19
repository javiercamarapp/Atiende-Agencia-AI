// @vitest-environment jsdom
//
// Smoke tests reales de <FolioPage /> (caja/facturación de recepción — donde el
// staff registra cargos, descuentos, pagos y cierra el folio; dinero real). Mismo
// patrón que hoteles-reservas-page.spec.tsx: `fetch` global mockeado por ruta real
// contra apps/api/src/routes/verticals/hoteles/folios.ts, estados de carga/error,
// datos reales (saldo, cargos, pagos), y la interacción principal (agregar un cargo
// y cerrar el folio) verificando método/ruta/cuerpo reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FolioPage } from "../src/verticals/hoteles/pages/Folio.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { FolioSummary } from "../src/verticals/hoteles/lib/folios-client.ts";
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

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

const FOLIO_ABIERTO: FolioSummary = {
  id: "folio-1",
  estado: "abierto",
  reservationId: "res-1",
  etiqueta: "Hab. 101",
  esPrincipal: true,
  cerradoEn: null,
  motivoCierre: null,
  cargos: [
    { id: "ch-1", concepto: "hospedaje", descripcion: "2 noches", monto: 2000, impuesto: 320, revertidoPor: null, reversaDe: null, transferidoDe: null, creadoEn: "2026-09-18T10:00:00.000Z" },
  ],
  pagos: [],
  saldo: 2320,
};

interface Handlers {
  folio?: FolioSummary | (() => FolioSummary);
  folioOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/folios\/folio-1$/.test(url)) {
      const folio = typeof handlers.folio === "function" ? handlers.folio() : (handlers.folio ?? FOLIO_ABIERTO);
      return jsonResponse(folio, handlers.folioOk ?? true);
    }
    if (method === "POST" && url.endsWith("/cargos")) return jsonResponse({ id: "ch-nuevo", concepto: "extras", monto: 150, impuesto: 24 });
    if (method === "POST" && url.endsWith("/descuentos")) return jsonResponse({ id: "ch-desc", monto: -100 });
    if (method === "POST" && url.endsWith("/pagos")) return jsonResponse({ id: "pay-1", monto: 500, metodo: "efectivo", estado: "capturado" });
    if (method === "POST" && url.endsWith("/cerrar")) return jsonResponse({ id: "folio-1", estado: "cerrado", motivoCierre: "saldo_cero", saldo: 0 });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <FolioPage {...CTX} folioId="folio-1" />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("FolioPage (hoteles)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando folio");
  });

  it("estado de error real cuando el fetch del folio falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ folioOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando folio");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
    // Nunca se queda mostrando datos a medias (sin folio, no hay saldo que pintar).
    expect(rendered.container.textContent).not.toContain("Saldo:");
  });

  it("renderiza el folio real: saldo, cargos y su monto con impuesto incluido", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Hab. 101");
    expect(text).toContain("$2,320.00"); // saldo
    expect(text).toContain("2 noches");
    expect(text).toContain("$2,320.00"); // monto (2000) + impuesto (320) del cargo
    expect(text).toContain("Sin pagos.");
  });

  it("agregar cargo: POST .../folios/folio-1/cargos con descripcion/monto/concepto reales y recarga el folio", async () => {
    let current = FOLIO_ABIERTO;
    stubFetch({ folio: () => current });
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    changeValue(root.querySelector('input[placeholder="Descripción"]') as HTMLInputElement, "Minibar");
    changeValue(root.querySelector('input[placeholder="Monto"]') as HTMLInputElement, "150");
    current = { ...FOLIO_ABIERTO, cargos: [...FOLIO_ABIERTO.cargos, { id: "ch-nuevo", concepto: "extras", descripcion: "Minibar", monto: 150, impuesto: 24, revertidoPor: null, reversaDe: null, transferidoDe: null, creadoEn: "2026-09-19T00:00:00.000Z" }], saldo: 2494 };

    const forms = [...root.querySelectorAll("form")];
    const chargeForm = forms.find((f) => f.textContent?.includes("Agregar cargo"))!;
    await submitForm(chargeForm);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/folios/folio-1/cargos" && init?.method === "POST");
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(init.body as string)).toEqual({ descripcion: "Minibar", monto: 150, concepto: "extras" });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(rendered.container.textContent).toContain("Minibar");
  });

  it("agregar cargo con monto <= 0: muestra error de validación real y NUNCA llama a la API", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    changeValue(root.querySelector('input[placeholder="Descripción"]') as HTMLInputElement, "Minibar");
    changeValue(root.querySelector('input[placeholder="Monto"]') as HTMLInputElement, "0");
    const forms = [...root.querySelectorAll("form")];
    const chargeForm = forms.find((f) => f.textContent?.includes("Agregar cargo"))!;
    const callsAntes = fetchMock.mock.calls.length;
    await submitForm(chargeForm);

    expect(rendered.container.textContent).toContain("Descripción y monto (> 0) son requeridos.");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("cerrar folio (saldo en cero): abre el AlertDialog irreversible y solo al confirmar llama POST .../cerrar con el motivo real", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const cerrarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cerrar folio (saldo en cero)")!;
    await act(async () => {
      cerrarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/cerrar"))).toBe(false);
    expect(document.body.textContent).toContain("irreversible");

    const confirmBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Sí, cerrar folio")!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/cerrar"));
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("https://api.test/hoteles/prop-1/folios/folio-1/cerrar");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ motivo: "saldo_cero" });
  });
});

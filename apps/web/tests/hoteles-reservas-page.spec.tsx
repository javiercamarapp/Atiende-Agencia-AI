// @vitest-environment jsdom
//
// Smoke tests reales de <ReservasPage /> (recepción de hoteles — página donde el
// staff mueve dinero/estado real: crear reserva, transicionar check-in/check-out,
// cancelar). Mismo patrón que superadmin-salud-page.spec.tsx: `fetch` global
// mockeado por ruta real (nunca se mockea el módulo cliente completo — así lo que
// se prueba es el contrato HTTP real que arma reservas-client.ts: método, ruta y
// cuerpo, contra apps/api/src/routes/verticals/hoteles/reservas.ts), estados de
// carga/vacío/error, datos reales, y la interacción principal (transicionar estado
// y crear una reserva) verificando la llamada real a la API.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ReservasPage } from "../src/verticals/hoteles/pages/Reservas.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { ReservationSummary } from "../src/verticals/hoteles/lib/reservas-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
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

const RESERVA_BASE: ReservationSummary = {
  id: "res-1",
  propertyId: "prop-1",
  roomTypeId: "rt-1",
  guestId: null,
  checkInDate: "2026-10-01",
  checkOutDate: "2026-10-03",
  estado: "confirmada",
  montoTotal: 2450.5,
  penalizacionCancelacion: null,
  canceladaEn: null,
  creadaEn: "2026-09-18T10:00:00.000Z",
  roomId: null,
};

interface Handlers {
  reservas?: readonly ReservationSummary[] | (() => readonly ReservationSummary[]);
  reservasOk?: boolean;
  tiposHabitacion?: unknown;
  huespedes?: unknown;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/tipos-habitacion")) return jsonResponse(handlers.tiposHabitacion ?? []);
    if (url.includes("/huespedes")) return jsonResponse(handlers.huespedes ?? []);
    if (method === "GET" && /\/reservas$/.test(url)) {
      const list = typeof handlers.reservas === "function" ? handlers.reservas() : (handlers.reservas ?? []);
      return jsonResponse(list, handlers.reservasOk ?? true);
    }
    if (method === "POST" && /\/reservas$/.test(url)) {
      return jsonResponse({ ...RESERVA_BASE, id: "res-nueva" });
    }
    if (method === "PATCH" && url.includes("/transicion")) {
      return jsonResponse({ ...RESERVA_BASE, estado: "check_in" });
    }
    if (method === "POST" && url.includes("/cancelar")) {
      return jsonResponse({ ...RESERVA_BASE, estado: "cancelada", canceladaEn: "2026-09-19T00:00:00.000Z" });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <ReservasPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("ReservasPage (hoteles)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ reservas: [] });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando reservas");
  });

  it("estado vacío explícito cuando no hay reservas en el filtro — nunca un error", async () => {
    stubFetch({ reservas: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay reservas en este filtro");
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("estado de error real cuando el fetch de reservas falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ reservas: [], reservasOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando reservas");
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
  });

  it("renderiza una reserva real: fechas, monto formateado y badge de estado", async () => {
    stubFetch({ reservas: [RESERVA_BASE] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("2026-10-01");
    expect(text).toContain("2026-10-03");
    expect(text).toContain("$2,450.50");
    expect(text).toContain("Confirmada");
  });

  it("'Marcar Check-in' llama PATCH .../transicion con {toStatus:'check_in'} y recarga la lista", async () => {
    let current = [RESERVA_BASE];
    stubFetch({ reservas: () => current });
    rendered = renderPage();
    await esperarCarga();

    const marcarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar Check-in"))!;
    current = [{ ...RESERVA_BASE, estado: "check_in" }];
    await act(async () => {
      marcarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const transicionCall = fetchMock.mock.calls.find(([url]) => url.includes("/transicion"));
    expect(transicionCall).toBeDefined();
    const [url, init] = transicionCall!;
    expect(url).toBe("https://api.test/hoteles/prop-1/reservas/res-1/transicion");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ toStatus: "check_in" });
    expect(rendered.container.textContent).toContain("Check-in");
  });

  it("cancelar reserva: abre el AlertDialog (no cancela de inmediato) y solo al confirmar llama POST .../cancelar", async () => {
    stubFetch({ reservas: [RESERVA_BASE] });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar")!;
    click(cancelarBtn);
    // Todavía no se disparó ningún POST /cancelar solo por abrir el modal.
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/cancelar"))).toBe(false);
    // El AlertDialog (Radix) porta su contenido a `document.body`, no a `container`
    // (mismo criterio ya usado en superadmin-gasto-api-page.spec.tsx).
    expect(document.body.textContent).toContain("¿Cancelar la reserva");

    const confirmBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Sí, cancelar reserva")!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const cancelCall = fetchMock.mock.calls.find(([url]) => url.includes("/cancelar"));
    expect(cancelCall).toBeDefined();
    const [url, init] = cancelCall!;
    expect(url).toBe("https://api.test/hoteles/prop-1/reservas/res-1/cancelar");
    expect(init.method).toBe("POST");
  });

  it("crear reserva: arma POST /hoteles/prop-1/reservas con roomTypeId/fechas reales y manda Idempotency-Key", async () => {
    stubFetch({ reservas: [], tiposHabitacion: [{ id: "rt-1", nombre: "Doble", capacidadMaxima: 2 }] });
    rendered = renderPage();
    await esperarCarga();

    const nuevaBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nueva reserva"))!;
    click(nuevaBtn);
    await esperarCarga(); // fetchRoomTypes

    const root = rendered.container;
    changeValue(root.querySelector("#res-tipo-habitacion") as HTMLSelectElement, "rt-1");
    changeValue(root.querySelector("#res-checkin") as HTMLInputElement, "2026-11-01");
    changeValue(root.querySelector("#res-checkout") as HTMLInputElement, "2026-11-05");

    const form = root.querySelector("form")!;
    await submitForm(form);
    await esperarCarga();

    const createCall = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/reservas" && init?.method === "POST");
    expect(createCall).toBeDefined();
    const [, init] = createCall!;
    expect(JSON.parse(init.body as string)).toEqual({ roomTypeId: "rt-1", checkInDate: "2026-11-01", checkOutDate: "2026-11-05" });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("crear reserva sin tipo de habitación: muestra error de validación real y NUNCA llama a la API", async () => {
    stubFetch({ reservas: [] });
    rendered = renderPage();
    await esperarCarga();

    const nuevaBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nueva reserva"))!;
    click(nuevaBtn);
    await esperarCarga();

    const form = rendered.container.querySelector("form")!;
    const callsAntes = fetchMock.mock.calls.length;
    await submitForm(form);

    expect(rendered.container.textContent).toContain("Selecciona un tipo de habitación");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });
});

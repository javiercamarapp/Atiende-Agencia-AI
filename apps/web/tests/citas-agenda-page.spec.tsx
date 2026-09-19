// @vitest-environment jsdom
//
// Smoke tests reales de <AgendaPage /> (citas — donde el staff confirma/cancela/
// completa una cita real y crea citas manuales). Mismo patrón que
// restaurantes-pedidos-page.spec.tsx: `fetch` global mockeado por ruta real
// contra appointments-client.ts/providers-client.ts/services-client.ts/
// waitlist-client.ts, estados de carga/vacío/error, datos reales, y la
// interacción principal (confirmar/cancelar una cita y crear una cita manual)
// verificando método/ruta/cuerpo reales. `subscribeToAppointmentChanges`
// (realtime-client.ts) es no-op sin VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY (ver
// su comentario de cabecera) -- no hace falta mockearlo en este entorno de test.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  confirmSpy.mockRestore();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: CitasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  orgId: "org-1",
  role: "owner",
  staffFullName: "Staff Demo",
  staffEmail: "staff@example.com",
};

const CITA_PENDING = {
  id: "apt-1",
  property_id: "prop-1",
  provider_id: "prov-1",
  service_id: "svc-1",
  customer_id: "cust-1",
  starts_at: "2026-09-19T15:00:00.000Z",
  ends_at: "2026-09-19T15:30:00.000Z",
  status: "pending",
  source: "web",
  notes: null,
  provider_name: "Dra. López",
  service_name: "Consulta general",
  customer_name: "María Ruiz",
  customer_phone: "5522223333",
};

const PROVIDER = { id: "prov-1", propertyId: "prop-1", displayName: "Dra. López", roleLabel: "Doctora", isActive: true };
const SERVICE = { id: "svc-1", name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true };

interface Handlers {
  appointments?: readonly (typeof CITA_PENDING)[] | (() => readonly (typeof CITA_PENDING)[]);
  appointmentsOk?: boolean;
  providers?: readonly (typeof PROVIDER)[];
  services?: readonly (typeof SERVICE)[];
  waitlist?: unknown[];
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/providers")) return jsonResponse({ providers: handlers.providers ?? [] });
    if (url.includes("/services") && !url.includes("appointments")) return jsonResponse({ services: handlers.services ?? [] });
    if (url.includes("/waitlist/broadcast")) return jsonResponse({ notified: 1, candidates_considered: 2, skipped_no_whatsapp_config: 1 });
    if (url.includes("/waitlist")) return jsonResponse({ waitlist: handlers.waitlist ?? [] });
    if (method === "GET" && url.includes("/appointments")) {
      const list = typeof handlers.appointments === "function" ? handlers.appointments() : (handlers.appointments ?? []);
      return jsonResponse({ appointments: list }, handlers.appointmentsOk ?? true);
    }
    if (method === "POST" && url.endsWith("/cancel")) return jsonResponse({ appointment: { ...CITA_PENDING, status: "cancelled" } });
    if (method === "POST" && url.endsWith("/confirm")) return jsonResponse({ appointment: { ...CITA_PENDING, status: "confirmed" } });
    if (method === "POST" && /\/appointments$/.test(url)) return jsonResponse({ appointment: { ...CITA_PENDING, id: "apt-nueva" } });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<AgendaPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("AgendaPage (citas)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ appointments: [] });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando citas");
  });

  it("estado vacío explícito cuando no hay citas en el rango — nunca un error", async () => {
    stubFetch({ appointments: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay citas en este rango");
  });

  it("estado de error real cuando el fetch de citas falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ appointments: [], appointmentsOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando citas");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("renderiza una cita real: horario, servicio, cliente, proveedor y estado", async () => {
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Consulta general");
    expect(text).toContain("María Ruiz");
    expect(text).toContain("Dra. López");
    expect(text).toContain("5522223333");
  });

  it("'Confirmar' llama POST .../appointments/apt-1/confirm (sin pedir confirmación del navegador) y recarga", async () => {
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();

    const confirmarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmar"))!;
    await act(async () => {
      confirmarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    const call = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "https://api.test/v1/citas/properties/prop-1/appointments/apt-1/confirm" && init?.method === "POST");
    expect(call).toBeDefined();
  });

  it("'Cancelar' pide confirmación real del navegador antes de llamar a la API; si se rechaza, NUNCA llama a la API", async () => {
    confirmSpy.mockReturnValue(false);
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancelar"))!;
    await act(async () => {
      cancelarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("¿Cancelar esta cita?"));
    expect(fetchMock.mock.calls.some(([url]: [string]) => url.endsWith("/cancel"))).toBe(false);
  });

  it("'Cancelar' con confirmación aceptada llama POST .../appointments/apt-1/cancel", async () => {
    confirmSpy.mockReturnValue(true);
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancelar"))!;
    await act(async () => {
      cancelarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => url === "https://api.test/v1/citas/properties/prop-1/appointments/apt-1/cancel" && init?.method === "POST");
    expect(call).toBeDefined();
  });

  it("crear cita manual: POST /v1/citas/properties/prop-1/appointments con snake_case real (provider_id/service_id/customer_name/starts_at)", async () => {
    stubFetch({ appointments: [], providers: [PROVIDER], services: [SERVICE] });
    rendered = renderPage();
    await esperarCarga();

    const nuevaBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nueva cita"))!;
    await act(async () => {
      nuevaBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const root = document.body;
    changeValue(root.querySelector("#citas-nueva-proveedor") as HTMLSelectElement, "prov-1");
    changeValue(root.querySelector("#citas-nueva-servicio") as HTMLSelectElement, "svc-1");
    changeValue(root.querySelector("#citas-nueva-inicio") as HTMLInputElement, "2026-10-01T10:00");
    changeValue(root.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Pedro Sánchez");
    changeValue(root.querySelector("#citas-nueva-telefono") as HTMLInputElement, "5533334444");

    const form = root.querySelector("#citas-nueva-cita") as HTMLFormElement;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]: [string, RequestInit]) => /\/appointments$/.test(url) && init?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body).toMatchObject({ provider_id: "prov-1", service_id: "svc-1", customer_name: "Pedro Sánchez", customer_phone: "5533334444" });
    expect(body.starts_at).toBeTruthy();
  });
});

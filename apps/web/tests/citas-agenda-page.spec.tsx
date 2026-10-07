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
// PR-4 (shell unico, UX-04): las confirmaciones destructivas ya no usan
// `window.confirm` sino el <ConfirmDialog> de @atiende/ui via `useConfirm`. Se
// espia `window.confirm` para AFIRMAR que nunca se llama.
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

/** Diálogo de confirmación abierto (Radix AlertDialog, montado en el portal de document.body). */
function dialogoConfirmacion(): HTMLElement | null {
  return document.body.querySelector('[role="alertdialog"]');
}

/** Pulsa un botón del diálogo de confirmación por su texto exacto y deja correr las promesas. */
async function pulsarEnDialogo(texto: string): Promise<void> {
  const boton = [...dialogoConfirmacion()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  await act(async () => {
    boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
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

const ENTRADA_ESPERA = {
  id: "wl-nuevo",
  position: 1,
  customer_name: "Mario Chan",
  customer_phone: "9991234567",
  provider_id: "prov-1",
  service_id: "svc-1",
  preferred_date_from: null,
  preferred_date_to: null,
  preferred_time_window: "morning",
  notified_count: 0,
  created_at: "2026-10-01T10:00:00.000Z",
};

const PROVIDER = { id: "prov-1", propertyId: "prop-1", displayName: "Dra. López", roleLabel: "Doctora", isActive: true };
const SERVICE = { id: "svc-1", name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true };

interface Handlers {
  appointments?: readonly (typeof CITA_PENDING)[] | (() => readonly (typeof CITA_PENDING)[]);
  appointmentsOk?: boolean;
  providers?: readonly (typeof PROVIDER)[];
  services?: readonly (typeof SERVICE)[];
  waitlist?: unknown[];
  /** Corrección bloqueante de la ronda 2 de revisión del PR #180 — permite a
   * un test simular la base sin migrar (`queued: false, reason:
   * "not_available_yet"`) en vez del default (`queued: true`, base ya
   * migrada). */
  broadcastResponse?: unknown;
  /** Respuesta (status, cuerpo) del POST de alta en la lista de espera. */
  enrollResponse?: { readonly status: number; readonly body: unknown };
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/providers")) return jsonResponse({ providers: handlers.providers ?? [] });
    if (url.includes("/services") && !url.includes("appointments")) return jsonResponse({ services: handlers.services ?? [] });
    // Corrección post-revisión de f2-citas-lista-de-espera (hallazgo B) — el
    // body real ya no trae `notified` (el efecto corre post-commit) y
    // `skipped_no_whatsapp_config` es `boolean`, no `number`.
    if (method === "POST" && url.endsWith("/waitlist")) {
      const r = handlers.enrollResponse ?? { status: 201, body: { entry: ENTRADA_ESPERA, already_enrolled: false } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
    }
    if (url.includes("/waitlist/broadcast")) return jsonResponse(handlers.broadcastResponse ?? { queued: true, candidates_considered: 2, skipped_no_whatsapp_config: false });
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
    // `appointments` como función (no un array fijo): lee la MISMA variable
    // `current` en cada fetch, así que reasignarla entre el click y la
    // aserción simula la recarga real -- criterio ya usado en
    // despachos-cobranza-page.spec.tsx.
    let current: readonly (typeof CITA_PENDING)[] = [CITA_PENDING];
    stubFetch({ appointments: () => current });
    rendered = renderPage();
    await esperarCarga();

    const confirmarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmar"))!;
    current = [{ ...CITA_PENDING, status: "confirmed" }];
    await act(async () => {
      confirmarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(dialogoConfirmacion()).toBeNull();
    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/appointments/apt-1/confirm" && init?.method === "POST");
    expect(call).toBeDefined();
    // La recarga real: la cita ya viene con status "confirmed" -- solo las
    // citas "pending" ofrecen "Confirmar" (CONFIRMABLE_STATUSES), así que el
    // botón desaparece tras recargar (antes del click ya decía "Confirmar",
    // por eso no basta con buscar ese texto en la página).
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Confirmar"))).toBe(false);
  });

  it("'Cancelar' abre el diálogo de confirmación (nunca window.confirm) y si se elige 'Volver' NUNCA llama a la API", async () => {
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancelar"))!;
    await act(async () => {
      cancelarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(dialogoConfirmacion()!.textContent).toContain("¿Cancelar esta cita?");
    expect(dialogoConfirmacion()!.textContent).toContain("Esta acción no se puede deshacer.");
    await pulsarEnDialogo("Volver");
    expect(dialogoConfirmacion()).toBeNull();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/cancel"))).toBe(false);
  });

  it("'Cancelar' con confirmación aceptada llama POST .../appointments/apt-1/cancel", async () => {
    stubFetch({ appointments: [CITA_PENDING] });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Cancelar"))!;
    await act(async () => {
      cancelarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Cancelar cita");

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/appointments/apt-1/cancel" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("'No-show' pide confirmación con diálogo; al aceptar llama a la API, al cerrarlo con Escape no", async () => {
    stubFetch({ appointments: [{ ...CITA_PENDING, status: "confirmed" }] });
    rendered = renderPage();
    await esperarCarga();

    const noShowBtn = [...rendered.container.querySelectorAll("button")].find((b) => /no.?show/i.test(b.textContent ?? ""))!;
    await act(async () => {
      noShowBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(dialogoConfirmacion()!.textContent).toContain("¿Marcar esta cita como no-show?");
    await act(async () => {
      dialogoConfirmacion()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/no-show") || url.endsWith("/no_show"))).toBe(false);

    await act(async () => {
      noShowBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Marcar no-show");
    expect(fetchMock.mock.calls.some(([url, init]) => /no.?show/.test(url) && init?.method === "POST")).toBe(true);
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

    const call = fetchMock.mock.calls.find(([url, init]) => /\/appointments$/.test(url) && init?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body).toMatchObject({ provider_id: "prov-1", service_id: "svc-1", customer_name: "Pedro Sánchez", customer_phone: "5533334444" });
    expect(body.starts_at).toBeTruthy();
  });

  // Corrección de un no-bloqueante del veredicto de la ronda 2 ("ningún test
  // afirma el texto renderizado del broadcast") — el bug de la ronda 1
  // ('Avisados: undefined de N') se habría colado igual con la cobertura
  // anterior (solo mockeaba el fetch, nunca leía el DOM tras el click).
  const WAITLIST_ROW = {
    id: "wl-1",
    position: 1,
    customer_name: "Cliente en espera",
    customer_phone: "5511112222",
    provider_id: null,
    service_id: null,
    preferred_date_from: null,
    preferred_date_to: null,
    preferred_time_window: null,
    notified_count: 0,
    created_at: "2026-09-01T10:00:00.000Z",
  };

  async function clickAvisar(): Promise<void> {
    const avisarBtn = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Avisar a la lista de espera"))!;
    await act(async () => {
      avisarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    // El aviso real de WhatsApp exige confirmar en el diálogo.
    expect(dialogoConfirmacion()!.textContent).toContain("¿Avisar a la lista de espera?");
    await pulsarEnDialogo("Enviar aviso");
  }

  it("'Avisar a la lista de espera' con queued:true real muestra 'Aviso encolado para N candidatos' — nunca una cifra inventada", async () => {
    stubFetch({ appointments: [], waitlist: [WAITLIST_ROW], broadcastResponse: { queued: true, candidates_considered: 2, skipped_no_whatsapp_config: false } });
    rendered = renderPage();
    await esperarCarga();

    await clickAvisar();

    const text = rendered.container.textContent!;
    expect(text).toContain("Aviso encolado para 2 candidatos considerados; se procesa en segundo plano.");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("todavía no está disponible");
  });

  // Corrección bloqueante de la ronda 2 — con la base sin migrar (probe de
  // catálogo en `false`, admin.ts responde `queued:false` +
  // `reason:"not_available_yet"`), el panel NUNCA debe decir "Aviso
  // encolado" (sería la misma confirmación falsa que la ronda 2 encontró):
  // debe mostrar el mensaje honesto de "todavía no está disponible".
  it("'Avisar a la lista de espera' con queued:false (base sin migrar) muestra el mensaje honesto, NUNCA 'Aviso encolado'", async () => {
    stubFetch({ appointments: [], waitlist: [WAITLIST_ROW], broadcastResponse: { queued: false, reason: "not_available_yet", candidates_considered: 0, skipped_no_whatsapp_config: false } });
    rendered = renderPage();
    await esperarCarga();

    await clickAvisar();

    const text = rendered.container.textContent!;
    expect(text).toContain("todavía no está disponible");
    expect(text).not.toContain("Aviso encolado");
  });
});


describe("<AgendaPage /> -- anotar a un cliente en la lista de espera (QA-citas-R1-agentes-18)", () => {
  async function abrirFormulario() {
    const btn = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Anotar cliente"))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  it("POST /v1/citas/properties/prop-1/waitlist con el cuerpo real, avisa la posicion y recarga la lista", async () => {
    stubFetch({ appointments: [], providers: [PROVIDER], services: [SERVICE] });
    rendered = renderPage();
    await esperarCarga();
    await abrirFormulario();

    const root = document.body;
    changeValue(root.querySelector("#citas-espera-nombre") as HTMLInputElement, "Mario Chan");
    changeValue(root.querySelector("#citas-espera-telefono") as HTMLInputElement, "9991234567");
    changeValue(root.querySelector("#citas-espera-proveedor") as HTMLSelectElement, "prov-1");
    changeValue(root.querySelector("#citas-espera-servicio-alta") as HTMLSelectElement, "svc-1");
    changeValue(root.querySelector("#citas-espera-franja") as HTMLSelectElement, "morning");
    const listasAntes = fetchMock.mock.calls.filter(([url, init]) => /\/waitlist(\?|$)/.test(url) && (init?.method ?? "GET") === "GET").length;
    await submitForm(root.querySelector("#citas-espera-alta") as HTMLFormElement);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/waitlist" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toMatchObject({ customer_name: "Mario Chan", customer_phone: "9991234567", provider_id: "prov-1", service_id: "svc-1", preferred_time_window: "morning" });
    expect(rendered!.container.textContent).toContain("Cliente anotado en la posición 1");
    const listasDespues = fetchMock.mock.calls.filter(([url, init]) => /\/waitlist(\?|$)/.test(url) && (init?.method ?? "GET") === "GET").length;
    expect(listasDespues).toBeGreaterThan(listasAntes);
  });

  it("un cliente que ya estaba anotado se dice tal cual, sin prometer una alta nueva", async () => {
    stubFetch({ appointments: [], enrollResponse: { status: 200, body: { entry: ENTRADA_ESPERA, already_enrolled: true } } });
    rendered = renderPage();
    await esperarCarga();
    await abrirFormulario();
    const root = document.body;
    changeValue(root.querySelector("#citas-espera-nombre") as HTMLInputElement, "Mario Chan");
    changeValue(root.querySelector("#citas-espera-telefono") as HTMLInputElement, "9991234567");
    await submitForm(root.querySelector("#citas-espera-alta") as HTMLFormElement);
    await esperarCarga();
    expect(rendered!.container.textContent).toContain("ya estaba en la lista de espera");
  });

  it("si el servidor rechaza el alta (400) el motivo aparece en el formulario, que sigue abierto con lo escrito", async () => {
    stubFetch({ appointments: [], enrollResponse: { status: 400, body: { message: "customer_phone debe ser un teléfono válido (entre 7 y 15 dígitos)" } } });
    rendered = renderPage();
    await esperarCarga();
    await abrirFormulario();
    const root = document.body;
    changeValue(root.querySelector("#citas-espera-nombre") as HTMLInputElement, "Mario Chan");
    changeValue(root.querySelector("#citas-espera-telefono") as HTMLInputElement, "123");
    await submitForm(root.querySelector("#citas-espera-alta") as HTMLFormElement);
    await esperarCarga();
    expect(root.querySelector("#citas-espera-alta [role='alert']")?.textContent).toMatch(/teléfono válido|No se pudo/);
    expect((root.querySelector("#citas-espera-nombre") as HTMLInputElement).value).toBe("Mario Chan");
  });
});

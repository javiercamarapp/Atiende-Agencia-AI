// @vitest-environment jsdom
//
// QA-citas-R1-caos-11 (sobre el scaffold de C-19): pagina publica /reservar/:orgSlug renderizada por la App real, con la red simulada: flujo completo (servicio -> profesional
// -> dia -> horario -> datos -> confirmacion en la zona del negocio), 409 (horario tomado: recarga y explica), 429, negocio no listo
// (sin formulario) y 404. Contrato: reserva-client.ts + apps/api/src/routes/verticals/citas/publico.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { changeValue, click, esperarRutaCargada, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const SERVICIO = "11111111-1111-4111-8111-111111111111";
const PROF_A = "22222222-2222-4222-8222-222222222222";
const PROF_B = "33333333-3333-4333-8333-333333333333";
const CATALOGO = {
  lista: true,
  negocio: { nombre: "Clínica Mayab", zona_horaria: "America/Merida" },
  servicios: [{ id: SERVICIO, nombre: "Consulta general", duracion_minutos: 30, precio_centavos: 50000 }],
  profesionales: [
    { id: PROF_A, nombre: "Dra. Fernanda López", servicio_ids: [SERVICIO] },
    { id: PROF_B, nombre: "Dr. Mario Pat", servicio_ids: [SERVICIO] },
  ],
};
const SLOTS = { lista: true, zona_horaria: "America/Merida", slots: [{ starts_at: "2027-09-13T16:00:00.000Z", ends_at: "2027-09-13T16:30:00.000Z", provider_id: PROF_B }] };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
const esperar = () =>
  act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
function renderEn(ruta: string): RenderedComponent {
  window.history.pushState({}, "", ruta);
  return renderComponent(<App />);
}
const q = <T extends Element>(sel: string): T => rendered!.container.querySelector<T>(sel) as T;
const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const llamadas = (sufijo: string, metodo?: string) => fetchMock.mock.calls.filter(([u, init]) => String(u).endsWith(sufijo) && (!metodo || (init as RequestInit | undefined)?.method === metodo));

async function llegarAlFormulario() {
  rendered = renderEn("/reservar/clinica-mayab");
  await esperarRutaCargada(rendered.container);
  await esperar();
  act(() => click(boton("Cualquiera disponible")!));
  act(() => click(rendered!.container.querySelector<HTMLButtonElement>('button[aria-pressed][aria-label]')!));
  await esperar();
  act(() => click(boton("10:00")!));
}
async function llenarYEnviar(aceptar = true) {
  act(() => changeValue(q<HTMLInputElement>('input[autocomplete="name"]'), "Ana Prueba"));
  act(() => changeValue(q<HTMLInputElement>('input[type="tel"]'), "999 123 4567"));
  if (aceptar) act(() => click(q<HTMLInputElement>('input[type="checkbox"]')));
  await act(async () => {
    await submitForm(q<HTMLFormElement>("form"));
  });
  await esperar();
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

const CITA = { appointment: { id: "cita-1", starts_at: "2027-09-13T16:00:00.000Z", ends_at: "2027-09-13T16:30:00.000Z", status: "pending" } };

function stub(reservar: (n: number) => Response | Promise<Response>) {
  let n = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/publico/catalogo")) return json(CATALOGO);
    if (u.endsWith("/publico/disponibilidad")) return json(SLOTS);
    if (u.endsWith("/appointments") && init?.method === "POST") return reservar(++n);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const llaves = () => llamadas("/appointments", "POST").map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { idempotency_key: string }).idempotency_key);

describe("QA-citas-R1-caos-11: reserva publica con la red cortada", () => {
  it("la respuesta se pierde (error de red) y al pulsar de nuevo 'Confirmar reserva' se reintenta con la MISMA idempotency_key", async () => {
    stub((n) => {
      if (n === 1) throw new TypeError("connection reset"); // el servidor guardo la cita pero la respuesta se corto
      return json(CITA, 201);
    });
    await llegarAlFormulario();
    await llenarYEnviar();
    expect(rendered!.container.textContent).not.toContain("Tu cita quedó registrada");
    await act(async () => {
      await submitForm(q<HTMLFormElement>("form"));
    });
    await esperar();
    const ks = llaves();
    expect(ks).toHaveLength(2);
    expect(ks[1]).toBe(ks[0]);
    expect(rendered!.container.textContent).toContain("Tu cita quedó registrada");
  });

  it("un 503 del servidor tambien conserva la llave; un 409 (horario ocupado, decision del servidor) la renueva", async () => {
    stub((n) => (n === 1 ? json({ message: "Servicio no disponible" }, 503) : json({ message: "Ese horario ya no esta disponible" }, 409)));
    await llegarAlFormulario();
    await llenarYEnviar();
    await act(async () => {
      await submitForm(q<HTMLFormElement>("form"));
    });
    await esperar();
    const ks = llaves();
    expect(ks[1]).toBe(ks[0]); // tras el 503, misma llave
    // Tras el 409 se recargan los horarios: elegir uno de nuevo y reservar es OTRA reserva.
    act(() => click(boton("10:00")!));
    await esperar();
    await act(async () => {
      await submitForm(q<HTMLFormElement>("form"));
    });
    await esperar();
    const todas = llaves();
    expect(todas.length).toBeGreaterThanOrEqual(3);
    expect(todas[2]).not.toBe(todas[0]);
  });
});

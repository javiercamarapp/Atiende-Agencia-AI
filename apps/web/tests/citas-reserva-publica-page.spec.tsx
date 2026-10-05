// @vitest-environment jsdom
//
// C-19: pagina publica /reservar/:orgSlug renderizada por la App real, con la red simulada: flujo completo (servicio -> profesional
// -> dia -> horario -> datos -> confirmacion en la zona del negocio), 409 (horario tomado: recarga y explica), 429, negocio no listo
// (sin formulario) y 404. Contrato: reserva-client.ts + apps/api/src/routes/verticals/citas/publico.ts.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { diasDisponibles, etiquetaDia, formatoFechaHora, formatoHora, hoyEnZona, sumarDias, validarFormulario } from "../src/verticals/citas/reserva/reserva-client.ts";
import { esperarRutaCargada, changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

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
const esperar = async () => {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
  await esperarRutaCargada(document.body);
};
async function renderEn(ruta: string): Promise<RenderedComponent> {
  window.history.pushState({}, "", ruta);
  const r = renderComponent(<App />);
  await esperarRutaCargada(r.container);
  return r;
}
const q = <T extends Element>(sel: string): T => rendered!.container.querySelector<T>(sel) as T;
const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const llamadas = (sufijo: string, metodo?: string) => fetchMock.mock.calls.filter(([u, init]) => String(u).endsWith(sufijo) && (!metodo || (init as RequestInit | undefined)?.method === metodo));

async function llegarAlFormulario() {
  rendered = await renderEn("/reservar/clinica-mayab");
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
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/publico/catalogo")) return json(CATALOGO);
    if (u.endsWith("/publico/disponibilidad")) return json(SLOTS);
    if (u.endsWith("/appointments") && init?.method === "POST") return json({ appointment: { id: "cita-1", starts_at: "2027-09-13T16:00:00.000Z", ends_at: "2027-09-13T16:30:00.000Z", status: "pending" } }, 201);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("fechas en la zona del negocio", () => {
  it("hoyEnZona usa la zona del negocio, no la del navegador", () => {
    const instante = new Date("2027-09-14T03:30:00.000Z"); // 13 sep 21:30 en Merida (UTC-6), ya 14 sep en UTC
    expect(hoyEnZona("America/Merida", instante)).toBe("2027-09-13");
    expect(hoyEnZona("UTC", instante)).toBe("2027-09-14");
    expect(diasDisponibles("America/Merida", 3, instante)).toEqual(["2027-09-13", "2027-09-14", "2027-09-15"]);
    expect(sumarDias("2027-12-31", 1)).toBe("2028-01-01");
  });
  it("formatea hora y fecha larga en la zona del negocio", () => {
    expect(formatoHora("2027-09-13T16:00:00.000Z", "America/Merida")).toMatch(/10:00/);
    expect(formatoFechaHora("2027-09-13T16:00:00.000Z", "America/Merida")).toMatch(/lunes, 13 de septiembre de 2027/);
    expect(etiquetaDia("2027-09-13").larga).toMatch(/lunes,? 13 de septiembre de 2027/);
  });
});

describe("validarFormulario", () => {
  it("exige nombre, telefono de 10 digitos y aviso de privacidad; correo opcional pero valido", () => {
    expect(Object.keys(validarFormulario({ nombre: " ", telefono: "123", correo: "", acepta: false })).sort()).toEqual(["acepta", "nombre", "telefono"]);
    expect(validarFormulario({ nombre: "Ana", telefono: "+52 999 123 4567", correo: "", acepta: true })).toEqual({});
    expect(validarFormulario({ nombre: "Ana", telefono: "9991234567", correo: "ana@", acepta: true })).toHaveProperty("correo");
  });
});

describe("/reservar/:orgSlug", () => {
  it("flujo completo: reserva y confirma con resumen en la zona del negocio", async () => {
    await llegarAlFormulario();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:8787/v1/citas/clinica-mayab/publico/catalogo");
    // El servicio unico se preselecciona; "cualquiera" no manda provider_id.
    expect(JSON.parse(String((llamadas("/publico/disponibilidad")[0]![1] as RequestInit).body))).toMatchObject({ service_id: SERVICIO });
    expect(JSON.parse(String((llamadas("/publico/disponibilidad")[0]![1] as RequestInit).body)).provider_id).toBeUndefined();
    await llenarYEnviar();
    const post = JSON.parse(String((llamadas("/appointments", "POST")[0]![1] as RequestInit).body));
    expect(post).toMatchObject({ provider_id: PROF_B, service_id: SERVICIO, starts_at: "2027-09-13T16:00:00.000Z", customer_name: "Ana Prueba", customer_phone: "999 123 4567", source: "web" });
    expect(post.idempotency_key).toBeTruthy();
    const texto = rendered!.container.textContent ?? "";
    expect(texto).toContain("Tu cita quedó registrada");
    expect(texto).toContain("Dr. Mario Pat");
    expect(texto).toMatch(/lunes, 13 de septiembre de 2027/);
    expect(texto).toContain("America/Merida");
    expect(q("form")).toBeNull();
  });

  it("sin aceptar el aviso de privacidad no se envia nada", async () => {
    await llegarAlFormulario();
    await llenarYEnviar(false);
    expect(llamadas("/appointments", "POST")).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Acepta el aviso de privacidad");
  });

  it("409: explica que el horario se ocupo, recarga los horarios y conserva los datos escritos", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/publico/catalogo")) return json(CATALOGO);
      if (u.endsWith("/publico/disponibilidad")) return json(SLOTS);
      if (u.endsWith("/appointments") && init?.method === "POST") return json({ message: "El horario ya no está disponible" }, 409);
      return json({}, 404);
    });
    await llegarAlFormulario();
    const antes = llamadas("/publico/disponibilidad").length;
    await llenarYEnviar();
    expect(rendered!.container.textContent).toContain("Ese horario acaba de ocuparse");
    expect(llamadas("/publico/disponibilidad").length).toBe(antes + 1);
    expect(rendered!.container.textContent).not.toContain("Tu cita quedó registrada");
    expect(q("form")).not.toBeNull();
  });

  it("429: muestra el mensaje de demasiados intentos", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/publico/catalogo")) return json(CATALOGO);
      if (u.endsWith("/publico/disponibilidad")) return json(SLOTS);
      if (u.endsWith("/appointments") && init?.method === "POST") return json({ message: "x" }, 429);
      return json({}, 404);
    });
    await llegarAlFormulario();
    await llenarYEnviar();
    expect(rendered!.container.textContent).toContain("Demasiados intentos seguidos");
  });

  it("negocio no listo: no muestra el formulario ni pide mas datos", async () => {
    fetchMock.mockImplementation(async () => json({ lista: false, faltan: ["horario"] }));
    rendered = await renderEn("/reservar/clinica-mayab");
    await esperar();
    expect(rendered.container.textContent).toContain("aún no recibe reservas en línea");
    expect(q("form")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negocio inexistente: 404 honesto", async () => {
    fetchMock.mockImplementation(async () => json({ message: "Negocio no encontrado." }, 404));
    rendered = await renderEn("/reservar/no-existe");
    await esperar();
    expect(rendered.container.textContent).toContain("No encontramos este negocio");
    expect(q("form")).toBeNull();
  });

  it("sin horarios en el dia: estado vacio, sin formulario", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/publico/catalogo")) return json(CATALOGO);
      return json({ lista: true, zona_horaria: "America/Merida", slots: [] });
    });
    rendered = await renderEn("/reservar/clinica-mayab");
    await esperar();
    act(() => click(boton("Dra. Fernanda López")!));
    act(() => click(rendered!.container.querySelector<HTMLButtonElement>("button[aria-pressed][aria-label]")!));
    await esperar();
    expect(rendered.container.textContent).toContain("Sin horarios este día");
    expect(q("form input")).toBeNull();
  });
});

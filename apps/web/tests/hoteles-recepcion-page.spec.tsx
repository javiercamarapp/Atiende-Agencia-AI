// @vitest-environment jsdom
//
// H-28 -- <RecepcionPage />: `fetch` global mockeado por ruta real contra apps/api/.../hoteles/recepcion.ts. Cubre carga,
// llegadas/salidas/en casa/rack, check-in de un clic con habitacion elegida, check-out con aviso de folios, cambio de
// habitacion, errores del servidor, gating cosmetico por rol y avisos honestos de base sin migrar.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { RecepcionPage } from "../src/verticals/hoteles/pages/Recepcion.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "frontdesk", staffFullName: "Ana", staffEmail: "ana@example.com" };

const mov = (over: Record<string, unknown>) => ({
  reservaId: "res-1",
  estado: "confirmada",
  huesped: { id: "g1", nombre: "Ana Torres" },
  tipoHabitacion: { id: "doble", nombre: "Doble" },
  habitacion: null,
  entrada: "2026-12-02",
  salida: "2026-12-05",
  noches: 3,
  salidaVencida: false,
  identidadRegistrada: false,
  ...over,
});

const rack = [
  { roomId: "r101", codigo: "101", tipoHabitacionId: "doble", tipoHabitacion: "Doble", estado: "disponible", limpieza: null, fueraDeServicio: null, ocupacion: "libre", reserva: null },
  { roomId: "r102", codigo: "102", tipoHabitacionId: "doble", tipoHabitacion: "Doble", estado: "ocupada", limpieza: { tareaId: "t1", tipo: "estancia", estado: "pendiente" }, fueraDeServicio: null, ocupacion: "ocupada", reserva: { reservaId: "res-2", huesped: "Beto Ruiz", entrada: "2026-12-01", salida: "2026-12-04" } },
  { roomId: "r103", codigo: "103", tipoHabitacionId: "doble", tipoHabitacion: "Doble", estado: "sucia", limpieza: null, fueraDeServicio: null, ocupacion: "libre", reserva: null },
  { roomId: "r104", codigo: "104", tipoHabitacionId: "doble", tipoHabitacion: "Doble", estado: "fuera_de_servicio", limpieza: null, fueraDeServicio: { motivo: "Fuga de agua", regresoEstimado: "2026-12-10" }, ocupacion: "libre", reserva: null },
];

function tablero(over: Record<string, unknown> = {}) {
  return {
    fecha: "2026-12-02",
    tareasDisponibles: true,
    identidadDisponible: true,
    resumen: { llegadas: 1, llegadasPendientes: 1, salidas: 1, salidasPendientes: 1, enCasa: 1, habitacionesLibres: 1, habitacionesSucias: 1, habitacionesFueraDeServicio: 1 },
    llegadas: [mov({})],
    salidas: [mov({ reservaId: "res-2", estado: "en_estancia", huesped: { id: "g2", nombre: "Beto Ruiz" }, habitacion: { id: "r102", codigo: "102" }, entrada: "2026-12-01", salida: "2026-12-02", identidadRegistrada: true })],
    enCasa: [mov({ reservaId: "res-2", estado: "en_estancia", huesped: { id: "g2", nombre: "Beto Ruiz" }, habitacion: { id: "r102", codigo: "102" }, entrada: "2026-12-01", salida: "2026-12-02", identidadRegistrada: true })],
    rack,
    ...over,
  };
}

function stubFetch(over: { tablero?: Record<string, unknown>; falla?: { url: RegExp; status: number; code: string; message: string } } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as unknown as Response;
    if (over.falla && method === "POST" && over.falla.url.test(url)) return json({ code: over.falla.code, message: over.falla.message }, over.falla.status);
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/recepcion")) return json(tablero(over.tablero));
    if (method === "POST" && url.endsWith("/check-in")) return json({ id: "res-1", estado: "en_estancia", habitacion: { id: "r101", codigo: "101" }, identidadRegistrada: false });
    if (method === "POST" && url.endsWith("/check-out")) return json({ id: "res-2", estado: "check_out", habitacionMarcadaSucia: true, foliosAbiertos: 1 });
    if (method === "POST" && url.endsWith("/cambiar-habitacion")) return json({ roomId: "r101", habitacionAnteriorId: "r102", habitacionId: "r101" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const montar = (ctx: HotelesShellContext = CTX) => {
  rendered = renderComponent(
    <MemoryRouter>
      <RecepcionPage {...ctx} />
    </MemoryRouter>,
  );
};
const botones = () => [...rendered!.container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
function pestana(nombre: string) {
  const t = [...rendered!.container.querySelectorAll('[role="tab"]')].find((x) => x.textContent === nombre)!;
  // Radix Tabs activa con mousedown.
  act(() => {
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    (t as HTMLElement).focus();
  });
}
async function pulsar(texto: string) {
  await act(async () => {
    click(boton(texto));
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

describe("RecepcionPage (hoteles)", () => {
  it("carga el resumen del dia y las llegadas con su accion", async () => {
    stubFetch();
    montar();
    expect(rendered!.container.textContent).toContain("Cargando recepción");
    await esperar();
    const text = rendered!.container.textContent ?? "";
    expect(text).toContain("Recepción");
    expect(text).toContain("Ana Torres");
    expect(text).toContain("Sin habitacion asignada");
    expect(text).toContain("Sin identidad registrada");
    expect(botones()).toContain("Check-in");
  });

  it("check-in de un clic: exige elegir habitacion, ofrece solo libres y limpias del mismo tipo y llama a la API", async () => {
    stubFetch();
    montar();
    await esperar();
    expect(boton("Check-in").disabled).toBe(true);
    const select = rendered!.container.querySelector('select[aria-label="Habitacion para Ana Torres"]') as HTMLSelectElement;
    const opciones = [...select.options].map((o) => o.value);
    expect(opciones).toEqual(["", "r101"]);
    changeValue(select, "r101");
    await pulsar("Check-in");
    await esperar();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/reservas/res-1/check-in"));
    expect(JSON.parse(post![1].body as string)).toEqual({ roomId: "r101" });
    expect(rendered!.container.textContent).toContain("Check-in de Ana Torres en la habitacion 101");
    expect(rendered!.container.textContent).toContain("Falta registrar su identidad");
  });

  it("check-out de un clic avisa de la habitacion sucia y de los folios abiertos", async () => {
    stubFetch();
    montar();
    await esperar();
    pestana("En casa");
    await esperar();
    await pulsar("Check-out");
    await esperar();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/reservas/res-2/check-out"))).toBe(true);
    const text = rendered!.container.textContent ?? "";
    expect(text).toContain("quedo sucia");
    expect(text).toContain("Quedan 1 folio(s) abierto(s)");
  });

  it("cambio de habitacion: abre el panel con candidatas (sin la actual), envia motivo y confirma", async () => {
    stubFetch();
    montar();
    await esperar();
    pestana("En casa");
    await esperar();
    await pulsar("Cambiar habitacion");
    const select = [...rendered!.container.querySelectorAll("select")].pop() as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "r101"]);
    changeValue(select, "r101");
    const motivo = rendered!.container.querySelector('input[maxlength="200"]') as HTMLInputElement;
    changeValue(motivo, "Ruido");
    await pulsar("Confirmar cambio");
    await esperar();
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/cambiar-habitacion"));
    expect(JSON.parse(post![1].body as string)).toEqual({ roomId: "r101", motivo: "Ruido" });
    expect(rendered!.container.textContent).toContain("cambio a la habitacion 101");
  });

  it("muestra el error real del servidor (409 habitacion ocupada) sin ocultarlo", async () => {
    stubFetch({ falla: { url: /check-in$/, status: 409, code: "habitacion_ocupada", message: "La habitacion 101 tiene otra reserva en esas fechas." } });
    montar();
    await esperar();
    changeValue(rendered!.container.querySelector("select") as HTMLSelectElement, "r101");
    await pulsar("Check-in");
    await esperar();
    expect(rendered!.container.textContent).toContain("La habitacion 101 tiene otra reserva en esas fechas.");
  });

  it("el rack muestra ocupacion, limpieza y fuera de servicio con su motivo", async () => {
    stubFetch();
    montar();
    await esperar();
    pestana("Rack");
    await esperar();
    const text = rendered!.container.textContent ?? "";
    expect(text).toContain("Habitacion 102");
    expect(text).toContain("Beto Ruiz");
    expect(text).toContain("Limpieza: pendiente");
    expect(text).toContain("Fuga de agua");
    expect(text).toContain("Sucia");
  });

  it("reservations ve el tablero pero no opera; housekeeping no tiene acceso", async () => {
    stubFetch();
    montar({ ...CTX, role: "reservations" });
    await esperar();
    expect(botones()).not.toContain("Check-in");
    expect(rendered!.container.textContent).toContain("Ana Torres");
    rendered!.unmount();
    stubFetch();
    montar({ ...CTX, role: "housekeeping" });
    await esperar();
    expect(rendered!.container.textContent).toContain("no tiene acceso");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base sin migrar: avisa honesto de limpieza e identidad no disponibles", async () => {
    stubFetch({ tablero: { tareasDisponibles: false, identidadDisponible: false, llegadas: [mov({ identidadRegistrada: null })] } });
    montar();
    await esperar();
    const text = rendered!.container.textContent ?? "";
    expect(text).toContain("estado de limpieza por habitación aún no está activo");
    expect(text).toContain("bóveda de identidad aún no está activa");
    expect(text).not.toContain("Sin identidad registrada");
  });

  it("sin llegadas muestra el vacio honesto", async () => {
    stubFetch({ tablero: { llegadas: [] } });
    montar();
    await esperar();
    expect(rendered!.container.textContent).toContain("No hay llegadas para esta fecha.");
  });
});

describe("RecepcionPage (hoteles): Cambiar fechas (H-28)", () => {
  it("las llegadas por llegar y los huespedes en casa ofrecen 'Cambiar fechas'; abre el dialogo con las fechas de la reserva", async () => {
    stubFetch();
    montar();
    await esperar();
    expect(botones()).toContain("Cambiar fechas");
    await pulsar("Cambiar fechas");
    expect((document.body.querySelector("#cf-entrada") as HTMLInputElement).value).toBe("2026-12-02");
    expect((document.body.querySelector("#cf-salida") as HTMLInputElement).value).toBe("2026-12-05");
    rendered!.unmount();
    stubFetch();
    montar();
    await esperar();
    pestana("En casa");
    await esperar();
    await pulsar("Cambiar fechas");
    // con el huesped en casa la llegada no se edita
    expect((document.body.querySelector("#cf-entrada") as HTMLInputElement).disabled).toBe(true);
  });

  it("reservations (que no opera check-in/out) si puede cambiar fechas; housekeeping no ve la pantalla", async () => {
    stubFetch();
    montar({ ...CTX, role: "reservations" });
    await esperar();
    expect(botones()).toContain("Cambiar fechas");
    expect(botones()).not.toContain("Check-in");
  });
});

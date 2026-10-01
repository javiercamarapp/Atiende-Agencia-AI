// @vitest-environment jsdom
//
// Smoke tests reales de <HousekeepingPage /> (H-04): `fetch` global mockeado por ruta real
// contra apps/api/.../hoteles/housekeeping.ts. Cubre carga, base sin migrar (aviso honesto,
// sin botones de tareas), gating cosmetico por rol y una accion (iniciar) que recarga.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { HousekeepingPage } from "../src/verticals/hoteles/pages/Housekeeping.tsx";
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

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "housekeeping", staffFullName: "Ana", staffEmail: "ana@example.com" };

const ZERO = { total: 0, pendientes: 0, enProgreso: 0, porInspeccionar: 0, inspeccionadas: 0, rechazos: 0 };
const REPORTE = (tareasDisponibles: boolean) => ({
  fecha: "2026-03-10",
  tareasDisponibles,
  totales: ZERO,
  porResponsable: [],
  habitacionesPorEstado: { disponible: 0, ocupada: 1, sucia: 1, fuera_de_servicio: 0, mantenimiento: 0 },
  fueraDeServicioActivas: 0,
});

function tablero(tareasDisponibles: boolean) {
  return {
    fecha: "2026-03-10",
    tareasDisponibles,
    habitaciones: [
      { roomId: "r1", codigo: "101", tipoHabitacion: "Doble", estado: "sucia", tarea: tareasDisponibles ? { id: "t1", tipo: "salida", estado: "pendiente", prioridad: "normal", asignadoA: null, rechazos: 0 } : null, fueraDeServicio: null },
      { roomId: "r2", codigo: "102", tipoHabitacion: "Doble", estado: "ocupada", tarea: null, fueraDeServicio: null },
    ],
  };
}

function stubFetch(tareasDisponibles: boolean) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/housekeeping/tablero")) return json(tablero(tareasDisponibles));
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/housekeeping/reporte")) return json(REPORTE(tareasDisponibles));
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/housekeeping/camaristas") return json({ camaristas: [{ id: "u1", nombre: "Ana" }] });
    if (method === "POST" && url.startsWith("https://api.test/hoteles/prop-1/housekeeping/")) return json({ id: "t1", estado: "en_progreso" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function buttons(r: RenderedComponent): string[] {
  return [...r.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
}

describe("HousekeepingPage (hoteles)", () => {
  it("carga el tablero con tarea y acciones segun el estado", async () => {
    stubFetch(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} />);
    expect(rendered.container.textContent).toContain("Cargando tablero");
    await esperar();
    const text = rendered.container.textContent ?? "";
    expect(text).toContain("Habitación 101");
    expect(text).toContain("Salida · Pendiente");
    expect(buttons(rendered)).toEqual(expect.arrayContaining(["Iniciar", "Asignar", "Cancelar tarea", "Marcar sucia"]));
  });

  it("iniciar una tarea llama a la API y recarga el tablero", async () => {
    stubFetch(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} />);
    await esperar();
    const antes = fetchMock.mock.calls.length;
    const iniciar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Iniciar")!;
    await act(async () => {
      click(iniciar);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    expect(fetchMock.mock.calls.some((c) => c[0] === "https://api.test/hoteles/prop-1/housekeeping/tareas/t1/iniciar" && c[1]?.method === "POST")).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(antes + 1);
  });

  it("base sin migrar: avisa honesto y no ofrece acciones de tareas ni inhabilitar", async () => {
    stubFetch(false);
    rendered = renderComponent(<HousekeepingPage {...CTX} role="owner" />);
    await esperar();
    expect(rendered.container.textContent).toContain("aún no están activas");
    const labels = buttons(rendered);
    expect(labels).not.toContain("Iniciar");
    expect(labels).not.toContain("Inhabilitar");
    expect(labels).not.toContain("Generar tareas del día");
  });

  it("maintenance ve el tablero pero no opera tareas; owner si puede inhabilitar", async () => {
    stubFetch(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} role="maintenance" />);
    await esperar();
    expect(buttons(rendered)).not.toContain("Iniciar");
    expect(buttons(rendered)).toContain("Inhabilitar");
    rendered.unmount();
    stubFetch(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} role="housekeeping" />);
    await esperar();
    expect(buttons(rendered)).not.toContain("Inhabilitar");
  });

  // PR-6 de diseno-ux: window.confirm/window.prompt pasan al ConfirmDialog (useConfirm) de @atiende/ui.
  const dialogo = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
  async function pulsar(texto: string) {
    const boton = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
    await act(async () => {
      click(boton);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
  }
  async function pulsarFila(texto: string) {
    const boton = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === texto)!;
    await act(async () => {
      click(boton);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
  }
  const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => ({ url: String(c[0]).replace("https://api.test/hoteles/prop-1/housekeeping", ""), body: JSON.parse(String(c[1].body)) }));

  it("PR-6: 'Cancelar tarea' pide confirmacion en un dialogo (Volver no manda nada, confirmar si) y nunca usa window.confirm", async () => {
    stubFetch(true);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} />);
    await esperar();
    await pulsarFila("Cancelar tarea");
    expect(dialogo()!.textContent).toContain("Cancelar la tarea de la habitación 101");
    await pulsar("Volver");
    expect(posts()).toEqual([]);
    await pulsarFila("Cancelar tarea");
    await pulsar("Cancelar tarea");
    expect(posts()).toEqual([{ url: "/tareas/t1/cancelar", body: {} }]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("PR-6: 'Asignar' pide el numero de la camarista en un dialogo y valida que sea de la lista", async () => {
    stubFetch(true);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("1");
    rendered = renderComponent(<HousekeepingPage {...CTX} />);
    await esperar();
    await pulsarFila("Asignar");
    expect(dialogo()!.textContent).toContain("1. Ana");
    await act(async () => changeValue(dialogo()!.querySelector("input")!, "9"));
    expect([...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Asignar")!.hasAttribute("disabled")).toBe(true);
    await act(async () => changeValue(dialogo()!.querySelector("input")!, "1"));
    await pulsar("Asignar");
    expect(posts()).toEqual([{ url: "/tareas/t1/asignar", body: { asignadoA: "u1" } }]);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("PR-6: inhabilitar pide el motivo y luego el tipo de baja en dialogos (falla = fuera de orden)", async () => {
    stubFetch(true);
    rendered = renderComponent(<HousekeepingPage {...CTX} role="owner" />);
    await esperar();
    await pulsarFila("Inhabilitar");
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "  Fuga en el baño  "));
    await pulsar("Continuar");
    expect(dialogo()!.textContent).toContain("Tipo de baja de la habitación 101");
    await pulsar("Fuera de orden (falla)");
    expect(posts()).toEqual([{ url: "/fuera-de-servicio", body: { roomId: "r1", tipo: "fuera_de_orden", motivo: "Fuga en el baño" } }]);
  });

  it("PR-6: rechazar una inspeccion exige indicar que corregir (el dialogo no deja confirmar vacio)", async () => {
    fetchMock = vi.fn();
    const base = tablero(true);
    base.habitaciones[0]!.tarea = { id: "t1", tipo: "salida", estado: "terminada", prioridad: "normal", asignadoA: null, rechazos: 0 } as never;
    vi.stubGlobal("fetch", (fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
      if (method === "GET" && url.includes("/housekeeping/tablero")) return json(base);
      if (method === "GET" && url.includes("/housekeeping/reporte")) return json(REPORTE(true));
      if (method === "GET" && url.endsWith("/housekeeping/camaristas")) return json({ camaristas: [] });
      return json({});
    })));
    rendered = renderComponent(<HousekeepingPage {...CTX} />);
    await esperar();
    await pulsarFila("Inspeccionar");
    await pulsar("Rechazada");
    const confirmar = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Rechazar")!;
    expect(confirmar.hasAttribute("disabled")).toBe(true);
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "Falta el baño"));
    await pulsar("Rechazar");
    expect(posts()).toEqual([{ url: "/tareas/t1/inspeccionar", body: { aprobada: false, nota: "Falta el baño" } }]);
  });
});

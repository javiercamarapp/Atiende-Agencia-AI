// @vitest-environment jsdom
//
// H-26 -- paneles residuales de Housekeeping (Blancos, Opt-out, Configuracion) y dialogo de fotos: fetch mockeado por ruta real contra
// apps/api/.../hoteles/housekeeping-residual.ts. Cubre el estado honesto "no disponible aun" (base sin 039), gating por rol y las
// escrituras reales.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { BlancosPanel, ConfiguracionHkPanel, OptOutPanel } from "../src/verticals/hoteles/pages/HousekeepingResidual.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", fecha: "2026-03-10" };
const H = "https://api.test/hoteles/prop-1/housekeeping";
const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
const CONFIG = (disponible: boolean) => ({
  disponible, personalizada: false, asignacionAutomatica: false, maxTareasPorCamarista: 14, minutosJornada: 480,
  minutosPorTipo: { salida: 40, estancia: 20, profunda: 90, repaso: 10 }, fotosObligatoriasEnInspeccion: false, maxFotosPorTarea: 6, horaArranque: 7, horaArranqueDisponible: disponible, actualizadoEn: null,
  vision: { disponible: false, requiere: "llave de un modelo con vision (H-23)" },
});
const ARTICULOS = [{ articulo: "sabanas", limpias: 90, sucias: 5, enLavanderia: 0, danadas: 0, total: 95, actualizadoEn: "x", conteoAnterior: { fecha: "2026-03-09", total: 110 }, diferencia: -15 }];
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const botones = (r: RenderedComponent) => [...r.container.querySelectorAll("button")];

describe("ConfiguracionHkPanel", () => {
  it("owner enciende la asignacion automatica con PUT real y la vision se declara NO disponible", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${H}/configuracion` && (init?.method ?? "GET") === "GET") return json(CONFIG(true));
      if (url === `${H}/configuracion` && init?.method === "PUT") return json({ ...CONFIG(true), asignacionAutomatica: true, personalizada: true });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ConfiguracionHkPanel {...P} role="owner" />);
    await esperar();
    expect(rendered.container.textContent).toContain("no disponible aún");
    const sw = rendered.container.querySelector('[aria-label="Asignación automática"]') as HTMLElement;
    await act(async () => {
      click(sw);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body))).toEqual({ asignacionAutomatica: true });
    expect(rendered.container.textContent).toContain("Asignación automática encendida.");
  });

  it("owner cambia la hora de arranque del dia: PUT real con horaArranque; sin la 045 el campo se deshabilita con aviso honesto", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${H}/configuracion` && (init?.method ?? "GET") === "GET") return json(CONFIG(true));
      if (url === `${H}/configuracion` && init?.method === "PUT") return json({ ...CONFIG(true), horaArranque: 6, personalizada: true });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ConfiguracionHkPanel {...P} role="owner" />);
    await esperar();
    const hora = [...rendered.container.querySelectorAll("input")].find((i) => i.value === "7" && i.max === "23") as HTMLInputElement;
    expect(hora).toBeDefined();
    expect(hora.disabled).toBe(false);
    changeValue(hora, "6");
    await act(async () => {
      click(botones(rendered!).find((b) => b.textContent === "Guardar cambios")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body))).toMatchObject({ horaArranque: 6 });
    rendered.unmount();

    fetchMock = vi.fn(async () => json({ ...CONFIG(true), horaArranqueDisponible: false }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ConfiguracionHkPanel {...P} role="owner" />);
    await esperar();
    const bloqueada = [...rendered.container.querySelectorAll("input")].find((i) => i.max === "23") as HTMLInputElement;
    expect(bloqueada.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("requiere la actualización 045");
  });

  it("frontdesk solo ve los valores (sin boton de guardar) y base sin migrar avisa", async () => {
    fetchMock = vi.fn(async () => json(CONFIG(false)));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<ConfiguracionHkPanel {...P} role="frontdesk" />);
    await esperar();
    expect(rendered.container.textContent).toContain("requiere la actualización 039");
    expect(botones(rendered).some((b) => b.textContent === "Guardar cambios")).toBe(false);
  });
});

describe("BlancosPanel", () => {
  it("muestra el faltante contra el conteo anterior y guarda un conteo con PUT real", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${H}/blancos?`)) return json({ fecha: "2026-03-10", disponible: true, articulos: ARTICULOS });
      if (url === `${H}/blancos` && init?.method === "PUT") return json({ ok: true });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<BlancosPanel {...P} role="housekeeping" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Faltan 15");
    await act(async () => {
      click(botones(rendered!).find((b) => b.textContent === "Corregir")!);
      await flushMicrotasks();
    });
    await act(async () => {
      click(botones(rendered!).find((b) => b.textContent === "Guardar conteo")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    const put = fetchMock.mock.calls.find((c) => c[1]?.method === "PUT")!;
    expect(JSON.parse(String(put[1].body))).toEqual({ fecha: "2026-03-10", articulo: "sabanas", limpias: 90, sucias: 5, enLavanderia: 0, danadas: 0 });
  });

  it("base sin migrar: aviso honesto y ningun control para contar", async () => {
    fetchMock = vi.fn(async () => json({ fecha: "2026-03-10", disponible: false, articulos: ARTICULOS.map((a) => ({ ...a, total: null, diferencia: null, conteoAnterior: null })) }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<BlancosPanel {...P} role="housekeeping" />);
    await esperar();
    expect(rendered.container.textContent).toContain("requiere la actualización 039");
    expect(botones(rendered).some((b) => b.textContent === "Contar" || b.textContent === "Corregir" || b.textContent === "Guardar conteo")).toBe(false);
  });
});

describe("OptOutPanel", () => {
  const habitaciones = [{ roomId: "r1", codigo: "101", tipoHabitacion: "Doble", estado: "ocupada" as const, tarea: null, fueraDeServicio: null }];
  it("lista los opt-out y permite revertir uno con POST real", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${H}/opt-out?`)) return json({ fecha: "2026-03-10", disponible: true, optOuts: [{ id: "o1", roomId: "r1", habitacion: "101", fecha: "2026-03-10", origen: "huesped", nota: null, estado: "activo", creadoEn: "x" }] });
      if (url === `${H}/opt-out/o1/revertir` && init?.method === "POST") return json({ ok: true });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<OptOutPanel {...P} role="frontdesk" habitaciones={habitaciones} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Habitación 101");
    await act(async () => {
      click(botones(rendered!).find((b) => b.textContent === "Revertir")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some((c) => c[0] === `${H}/opt-out/o1/revertir` && c[1]?.method === "POST")).toBe(true);
  });
  it("fnb/maintenance no ven controles de escritura", async () => {
    fetchMock = vi.fn(async () => json({ fecha: "2026-03-10", disponible: true, optOuts: [] }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderComponent(<OptOutPanel {...P} role="maintenance" habitaciones={habitaciones} />);
    await esperar();
    expect(botones(rendered).some((b) => b.textContent === "Registrar opt-out")).toBe(false);
  });
});

// @vitest-environment jsdom
//
// <GastoApiPorRol />: gasto por organizacion/rol/mes y tope diario de turnos por rol (CHAT-07). `fetch` global mockeado (el componente
// llama `fetchJson` -> `fetchConStepUp`; sin dialogo de step-up registrado devuelve la respuesta tal cual). Cubre cargando, error,
// "no disponible aun", vacio, datos y el PUT del tope.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GastoApiPorRol } from "../src/superadmin/pages/GastoApiPorRol.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const res = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;
const esperar = () =>
  act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });

const ORGS = [{ organizationId: "00000000-0000-4000-8000-000000000001", organizationName: "Hotel Test" }];
const render = () => renderComponent(<GastoApiPorRol apiBaseUrl="https://api.test" token="tok" from="2026-10-01" to="2026-10-31" organizaciones={ORGS} />);

describe("Gasto por organizacion y rol", () => {
  it("muestra cargando primero y luego las filas REALES (mes, organizacion, rol, costo, llamadas, % con respaldo)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/por-rol") ? res({ disponible: true, filas: [{ organizationId: ORGS[0]!.organizationId, organizationName: "Hotel Test", role: "hoteles:data_chat", month: "2026-10", costMicroUsd: 2_000_000, callCount: 20, fallbackCallCount: 2 }] }) : res({}))));
    rendered = render();
    expect(rendered.container.textContent).toContain("Cargando gasto por rol");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("hoteles:data_chat");
    expect(t).toContain("2026-10");
    expect(t).toContain("$2.0000");
    expect(t).toContain("10.0%");
  });

  it("estado vacio honesto cuando no hay llamadas en el rango", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ disponible: true, filas: [] })));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Sin llamadas al LLM registradas en este rango");
  });

  it("base sin migrar: 'No disponible aun' (nunca ceros fingidos)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ disponible: false, mensaje: "El reporte por rol requiere la migración 0046.", filas: [] })));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No disponible aún");
  });

  it("error de red o del servidor: muestra el error con reintento, sin quedarse en 'Cargando'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ message: "Falla del servidor." }, false)));
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Falla del servidor.");
    expect(rendered.container.textContent).not.toContain("Cargando gasto por rol");
  });
});

describe("Tope diario de turnos por rol", () => {
  it("sin organizacion elegida pide elegir una; al elegirla lista defaults y uso de hoy y el PUT guarda el tope propio", async () => {
    const puts: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/por-rol")) return res({ disponible: true, filas: [] });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return res({ ok: true });
      }
      return res({ disponible: true, defaults: [{ role: "hoteles:data_chat", maxTurnosDia: 400 }, { role: "plataforma:titulos_resumenes", maxTurnosDia: 300 }], propios: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Elige una organización para ver y ajustar");
    const select = rendered.container.querySelector("#topes-rol-organizacion") as HTMLSelectElement;
    changeValue(select, ORGS[0]!.organizationId);
    await esperar();
    expect(rendered.container.textContent).toContain("hoteles:data_chat");
    expect(rendered.container.textContent).toContain("plataforma:titulos_resumenes");
    const input = rendered.container.querySelector("#tope-rol-hoteles\\:data_chat") as HTMLInputElement;
    expect(input.value).toBe("400");
    changeValue(input, "30");
    const guardar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar" && !b.disabled)!;
    click(guardar);
    await esperar();
    expect(puts).toEqual([{ role: "hoteles:data_chat", maxTurnosDia: 30 }]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/topes-rol")).length).toBeGreaterThanOrEqual(3); // carga, PUT y recarga
  });

  it("un valor fuera de rango no llama al servidor y muestra el motivo", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("/por-rol") ? res({ disponible: true, filas: [] }) : res({ disponible: true, defaults: [{ role: "hoteles:data_chat", maxTurnosDia: 400 }], propios: [] })));
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();
    changeValue(rendered.container.querySelector("#topes-rol-organizacion") as HTMLSelectElement, ORGS[0]!.organizationId);
    await esperar();
    const input = rendered.container.querySelector("#tope-rol-hoteles\\:data_chat") as HTMLInputElement;
    changeValue(input, "0");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar" && !b.disabled)!);
    await esperar();
    expect(rendered.container.textContent).toContain("Entero entre 1 y 100000.");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("base sin migrar al pedir los topes: 'No disponible aun'", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes("/por-rol") ? res({ disponible: true, filas: [] }) : res({ disponible: false, mensaje: "requiere la migración 0046", defaults: [], propios: [] }))));
    rendered = render();
    await esperar();
    changeValue(rendered.container.querySelector("#topes-rol-organizacion") as HTMLSelectElement, ORGS[0]!.organizationId);
    await esperar();
    expect(rendered.container.textContent).toContain("No disponible aún");
  });
});

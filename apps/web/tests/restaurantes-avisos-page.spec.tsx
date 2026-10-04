// @vitest-environment jsdom
//
// R-16: pantalla Avisos. Cada persona ve y edita SUS avisos; owner/admin ven ademas la matriz del equipo y el tiempo de gracia de la entrega
// tardia por sucursal. Cada control llama al servidor (que re-valida) y el estado solo cambia cuando el servidor confirma.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvisosStaffPage } from "../src/verticals/restaurantes/pages/AvisosStaff.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const RUTA = "https://api.test/v1/restaurantes/prop-1/admin/avisos";

const EVENTOS = [
  { tipo: "restaurantes.pedido.nuevo", etiqueta: "Pedido nuevo", descripcion: "Entra un pedido.", sonidoAplica: true },
  { tipo: "restaurantes.pedido.entrega_tardia", etiqueta: "Entrega tardía", descripcion: "Un pedido pasó de su hora prometida.", sonidoAplica: false },
];
const pref = (tipo: string, enabled = true, sonido = true) => ({ tipo, enabled, sonido });
const MIAS = EVENTOS.map((e) => pref(e.tipo));
const OWNER_BODY = {
  disponible: true,
  eventos: EVENTOS,
  mias: MIAS,
  equipo: [
    { userId: "u-ana", fullName: "Ana", email: "ana@example.com", verticalRole: "owner", preferencias: MIAS },
    { userId: "u-beto", fullName: "Beto", email: "beto@example.com", verticalRole: "staff", preferencias: MIAS },
  ],
  umbrales: [
    { propertyId: "p1", nombre: "Centro", entregaTardiaMin: 30 },
    { propertyId: "p2", nombre: "Norte", entregaTardiaMin: null },
  ],
  umbralMin: 10,
  umbralMax: 240,
  umbralDefectoMin: 45,
};
const STAFF_BODY = { disponible: true, eventos: EVENTOS, mias: MIAS, equipo: null, umbrales: null, umbralDefectoMin: 45 };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function conGet(body: unknown) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? json({ ok: true }) : json(body)));
}
const puts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
const cuerpo = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
const q = (sel: string) => rendered!.container.querySelector<HTMLElement>(sel);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("AvisosStaffPage -- Mis avisos", () => {
  it("el staff ve SOLO 'Mis avisos' (sin matriz del equipo ni tiempo de gracia)", async () => {
    conGet(STAFF_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Mis avisos");
    expect(texto).toContain("Pedido nuevo");
    expect(texto).not.toContain("Avisos del equipo");
    expect(texto).not.toContain("Entrega tardía por sucursal");
    expect(fetchMock.mock.calls[0]![0]).toBe(RUTA);
  });

  it("apagar un aviso manda la preferencia PROPIA (sin userId) y el interruptor cambia al confirmar el servidor", async () => {
    conGet(STAFF_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    const sw = q("button[role='switch'][aria-label='Avisarme: Entrega tardía']")!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    click(sw);
    await esperar();
    expect(puts()).toHaveLength(1);
    expect(String(puts()[0]![0])).toBe(`${RUTA}/preferencias`);
    expect(cuerpo(puts()[0]!)).toEqual({ tipo: "restaurantes.pedido.entrega_tardia", enabled: false, sonido: true });
    expect(q("button[role='switch'][aria-label='Avisarme: Entrega tardía']")!.getAttribute("aria-checked")).toBe("false");
    expect(rendered.container.textContent).toContain("Cambio guardado.");
  });

  it("el sonido (solo del pedido nuevo) se guarda aparte y se deshabilita si el aviso esta apagado", async () => {
    conGet(STAFF_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    const sonido = Array.from(rendered.container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")).find((i) => i.closest("label")?.textContent?.includes("Sonido en el navegador"))!;
    expect(rendered.container.textContent!.match(/Sonido en el navegador/g)).toHaveLength(1);
    click(sonido);
    await esperar();
    expect(cuerpo(puts()[0]!)).toEqual({ tipo: "restaurantes.pedido.nuevo", enabled: true, sonido: false });
    click(q("button[role='switch'][aria-label='Avisarme: Pedido nuevo']")!);
    await esperar();
    expect(cuerpo(puts()[1]!)).toMatchObject({ tipo: "restaurantes.pedido.nuevo", enabled: false });
    const despues = Array.from(rendered.container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")).find((i) => i.closest("label")?.textContent?.includes("Sonido en el navegador"))!;
    expect(despues.disabled).toBe(true);
  });

  it("si el servidor rechaza el cambio muestra el error y NO cambia el interruptor", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? json({ error: "forbidden", message: "No tienes permiso." }, 403) : json(STAFF_BODY)));
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    click(q("button[role='switch'][aria-label='Avisarme: Entrega tardía']")!);
    await esperar();
    expect(q("button[role='switch'][aria-label='Avisarme: Entrega tardía']")!.getAttribute("aria-checked")).toBe("true");
    expect(rendered.container.querySelector("[role='status']")?.textContent).toMatch(/permiso|No se pudo/);
  });

  it("base sin migrar: estado honesto 'no disponibles aun' y ningun control", async () => {
    conGet({ ...STAFF_BODY, disponible: false, mias: [] });
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Avisos no disponibles aún");
    expect(q("button[role='switch']")).toBeNull();
  });

  it("error de carga: muestra el error y 'Reintentar' vuelve a pedir", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: "internal", message: "Falla del servidor." }, 500));
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="staff" />);
    await esperar();
    const reintentar = Array.from(rendered.container.querySelectorAll("button")).find((b) => /reintentar/i.test(b.textContent ?? ""));
    expect(reintentar).toBeDefined();
    fetchMock.mockImplementation(async () => json(STAFF_BODY));
    click(reintentar!);
    await esperar();
    expect(rendered.container.textContent).toContain("Mis avisos");
  });
});

describe("AvisosStaffPage -- owner/admin", () => {
  it("la matriz lista al equipo; apagar un aviso de OTRA persona manda su userId", async () => {
    conGet(OWNER_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Avisos del equipo");
    click(q("input[aria-label='Entrega tardía para Beto']")!);
    await esperar();
    expect(cuerpo(puts()[0]!)).toEqual({ tipo: "restaurantes.pedido.entrega_tardia", enabled: false, sonido: true, userId: "u-beto" });
    expect((q("input[aria-label='Entrega tardía para Beto']") as HTMLInputElement).checked).toBe(false);
  });

  it("la fila propia se guarda como preferencia propia (sin userId) y refresca 'Mis avisos'", async () => {
    conGet(OWNER_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} />);
    await esperar();
    click(q("input[aria-label='Entrega tardía para Ana']")!);
    await esperar();
    expect(cuerpo(puts()[0]!)).not.toHaveProperty("userId");
    expect(q("button[role='switch'][aria-label='Avisarme: Entrega tardía']")!.getAttribute("aria-checked")).toBe("false");
  });

  it("un administrador ve DESHABILITADA la fila de un dueño (el servidor lo rechazaria)", async () => {
    conGet(OWNER_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} role="admin" staffEmail="admin@example.com" />);
    await esperar();
    expect((q("input[aria-label='Entrega tardía para Ana']") as HTMLInputElement).disabled).toBe(true);
    expect((q("input[aria-label='Entrega tardía para Beto']") as HTMLInputElement).disabled).toBe(false);
  });

  it("guarda el tiempo de gracia de una sucursal (PUT con propertyId y minutos) y recarga", async () => {
    conGet(OWNER_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} />);
    await esperar();
    const input = q("input[aria-label='Minutos de gracia en Norte']") as HTMLInputElement;
    expect(input.placeholder).toBe("45");
    changeValue(input, "60");
    const guardar = Array.from(rendered.container.querySelectorAll("section[aria-label='Entrega tardía por sucursal'] button")).filter((b) => b.textContent === "Guardar")[1]!;
    click(guardar);
    await esperar();
    expect(String(puts()[0]![0])).toBe(`${RUTA}/umbral`);
    expect(cuerpo(puts()[0]!)).toEqual({ propertyId: "p2", minutos: 60 });
    expect(rendered.container.textContent).toContain("Tiempo de gracia guardado.");
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "PUT").length).toBeGreaterThanOrEqual(2);
  });

  it("un valor que no es entero no llega al servidor", async () => {
    conGet(OWNER_BODY);
    rendered = renderComponent(<AvisosStaffPage {...CTX} />);
    await esperar();
    changeValue(q("input[aria-label='Minutos de gracia en Norte']") as HTMLInputElement, "abc");
    click(Array.from(rendered.container.querySelectorAll("section[aria-label='Entrega tardía por sucursal'] button")).filter((b) => b.textContent === "Guardar")[1]!);
    await esperar();
    expect(puts()).toHaveLength(0);
    expect(rendered.container.textContent).toContain("número entero");
  });
});

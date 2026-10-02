// @vitest-environment jsdom
//
// C-16 -- <AvisosPage /> (citas): datos reales del servidor, gate por rol, estados "no disponible aun" distintos del vacio, telefono
// enmascarado y acciones de seguimiento que llaman al endpoint real (con nota opcional) y recargan la bandeja.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvisosPage } from "../src/verticals/citas/pages/Avisos.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const ctx = { apiBaseUrl: "https://api.test", token: "tok-1", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Sam", staffEmail: "sam@example.com" } as CitasShellContext;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const ESC = (over: Record<string, unknown> = {}) => ({ id: "e-1", canal: "whatsapp", palabraClave: "crisis", telefono: "***4567", creadaEn: "2026-10-01T10:00:00.000Z", seguimiento: "pending", seguimientoEn: null, nota: null, ...over });

function datos(over: Record<string, unknown> = {}) {
  return {
    generadoEn: "2026-10-01T12:00:00.000Z",
    porConfirmar: { horas: 72, total: 1, items: [{ id: "c-1", iniciaEn: "2026-10-02T15:00:00.000Z", proveedor: "Dra. Lupita", servicio: "Consulta general", origen: "whatsapp" }] },
    recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [{ canal: "whatsapp", estado: "dead", total: 2 }, { canal: "whatsapp", estado: "sent", total: 9 }] },
    escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: [ESC()] },
    ...over,
  };
}

function stub(respuesta: () => Response, onPost?: (url: string, body: unknown) => Response) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url === "https://api.test/v1/citas/properties/prop-1/admin/avisos") return respuesta();
    if (init?.method === "POST") return onPost ? onPost(url, JSON.parse(String(init.body))) : jsonResponse({ id: "e-1", estado: "in_progress", en: "x" });
    throw new Error(`fetch no esperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const montar = () => renderComponent(<MemoryRouter><AvisosPage {...ctx} /></MemoryRouter>);
const botones = () => Array.from(rendered!.container.querySelectorAll("button"));

describe("AvisosPage (citas)", () => {
  it("muestra por confirmar, estado de entrega y escalaciones con el telefono enmascarado", async () => {
    stub(() => jsonResponse(datos()));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Citas por confirmar");
    expect(t).toContain("Consulta general · Dra. Lupita");
    expect(t).toContain("Agotaron sus reintentos");
    expect(t).toContain("Enviados");
    expect(t).toContain("Señal «crisis» · cliente ***4567");
    expect(t).toContain("Sin seguimiento");
    expect(rendered.container.querySelector("a[href='/citas/demo/agenda']")).not.toBeNull();
    expect(rendered.container.querySelector("a[href='/citas/demo/mensajes-whatsapp']")).not.toBeNull();
  });

  it("vacio real de cada bloque (distinto de 'no disponible')", async () => {
    stub(() => jsonResponse(datos({ porConfirmar: { horas: 72, total: 0, items: [] }, recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [] }, escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: [] } })));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Nada por confirmar en las próximas 72 horas.");
    expect(t).toContain("No hay recordatorios en este periodo.");
    expect(t).toContain("Sin escalaciones.");
  });

  it("rol staff: lo sensible no se muestra (visible:false) y se dice por que", async () => {
    stub(() => jsonResponse(datos({ recordatorios: { visible: false, disponible: false, ventanaDias: 7, filas: [] }, escalaciones: { visible: false, disponible: false, seguimientoDisponible: false, items: [] } })));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Solo los roles owner o admin ven el estado de entrega");
    expect(t).toContain("Solo los roles owner o admin ven las escalaciones de crisis");
  });

  it("base sin migrar: declara 'no disponible aun', sin botones de seguimiento ni ceros inventados", async () => {
    stub(() => jsonResponse(datos({ recordatorios: { visible: true, disponible: false, ventanaDias: 7, filas: [] }, escalaciones: { visible: true, disponible: true, seguimientoDisponible: false, items: [ESC({ seguimiento: null })] } })));
    rendered = montar();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Todavía no disponible en este ambiente");
    expect(t).toContain("El seguimiento todavía no está disponible");
    expect(botones().some((b) => b.textContent?.includes("Tomar seguimiento"))).toBe(false);
    expect(botones().some((b) => b.textContent?.includes("Marcar resuelta"))).toBe(false);
  });

  it("'Tomar seguimiento' manda POST real con el estado y la nota, y recarga la bandeja", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    stub(() => jsonResponse(datos()), (url, body) => {
      posts.push({ url, body });
      return jsonResponse({ id: "e-1", estado: "in_progress", en: "2026-10-01T12:05:00.000Z" });
    });
    rendered = montar();
    await esperar();
    changeValue(rendered.container.querySelector("textarea[aria-label='Nota de seguimiento']") as HTMLTextAreaElement, "  Llamé al cliente  ");
    click(botones().find((b) => b.textContent?.includes("Tomar seguimiento"))!);
    await esperar();
    expect(posts).toEqual([{ url: "https://api.test/v1/citas/properties/prop-1/admin/escalaciones/e-1/seguimiento", body: { estado: "in_progress", nota: "Llamé al cliente" } }]);
    const gets = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "POST");
    expect(gets.length).toBe(2);
  });

  it("un error del servidor al guardar el seguimiento se muestra junto a la fila", async () => {
    stub(() => jsonResponse(datos()), () => jsonResponse({ message: "El seguimiento todavía no está disponible en este ambiente (migración pendiente)." }, false, 503));
    rendered = montar();
    await esperar();
    click(botones().find((b) => b.textContent?.includes("Marcar resuelta"))!);
    await esperar();
    expect(rendered.container.querySelector("[role='alert']")?.textContent).toContain("migración pendiente");
  });

  it("error de carga: muestra el error con reintento, no una bandeja vacia", async () => {
    stub(() => jsonResponse({ message: "boom" }, false, 500));
    rendered = montar();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudieron cargar los avisos");
    expect(rendered.container.textContent).not.toContain("Sin escalaciones.");
  });
});

// @vitest-environment jsdom
//
// PR-6 de diseno-ux (hoteles): cerrar un ticket de mantenimiento pedia el costo real y la nota con
// window.prompt; ahora son dialogos de ConfirmDialog (useConfirm). Se afirma que window.prompt NUNCA
// se llama, que cancelar cualquiera de los dos dialogos no cierra el ticket y que confirmar manda el
// POST .../cerrar con el costo y la nota.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MantenimientoPage } from "../src/verticals/hoteles/pages/Mantenimiento.tsx";
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

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "gm", staffFullName: "Ana", staffEmail: "ana@example.com" };
const TICKET = {
  id: "m1", roomId: "r1", titulo: "Aire sin enfriar", descripcion: "No enfria", origen: "staff", severidad: "alta", estado: "abierto", asignadoA: null,
  costoEstimado: 1500, costoReal: null, notaResolucion: null, creadoPor: "u1", cerradoEn: null, creadoEn: "2026-03-10T10:00:00.000Z", actualizadoEn: "2026-03-10T10:00:00.000Z",
};

function stub(tickets: unknown[] = [TICKET]) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url.includes("/hoteles/prop-1/mantenimiento/tickets")) return json(tickets);
    if (method === "POST" && url.endsWith("/mantenimiento/tickets")) return json({ ...TICKET, id: "m2" });
    if (method === "POST" && url.endsWith("/mantenimiento/tickets/m1/cerrar")) return json({ ...TICKET, estado: "cerrado" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const dialogo = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
async function pulsarEnDialogo(texto: string) {
  const boton = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  await act(async () => {
    click(boton);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
async function abrirCierre() {
  const boton = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Cerrar ticket")!;
  await act(async () => {
    click(boton);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => ({ url: String(c[0]).replace("https://api.test/hoteles/prop-1/mantenimiento", ""), body: JSON.parse(String(c[1].body)) }));

describe("MantenimientoPage (hoteles) — cierre con dialogos", () => {
  it("cancelar el dialogo del costo no cierra el ticket", async () => {
    stub();
    rendered = renderComponent(<MantenimientoPage {...CTX} />);
    await esperar();
    await abrirCierre();
    expect(dialogo()!.textContent).toContain('Cerrar el ticket "Aire sin enfriar"');
    expect((dialogo()!.querySelector("input") as HTMLInputElement).value).toBe("1500");
    await pulsarEnDialogo("Cancelar");
    expect(posts()).toEqual([]);
  });

  it("cancelar el dialogo de la nota de cierre (segundo paso) no cierra el ticket", async () => {
    stub();
    rendered = renderComponent(<MantenimientoPage {...CTX} />);
    await esperar();
    await abrirCierre();
    await pulsarEnDialogo("Continuar");
    expect(dialogo()!.querySelector("textarea")).not.toBeNull();
    await pulsarEnDialogo("Cancelar");
    await esperar();
    expect(posts()).toEqual([]);
  });

  it("un costo invalido bloquea el boton; con costo y nota manda POST .../cerrar y nunca usa window.prompt", async () => {
    stub();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("no debe usarse");
    rendered = renderComponent(<MantenimientoPage {...CTX} />);
    await esperar();
    await abrirCierre();
    await act(async () => changeValue(dialogo()!.querySelector("input")!, "-5"));
    expect([...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Continuar")!.hasAttribute("disabled")).toBe(true);
    await act(async () => changeValue(dialogo()!.querySelector("input")!, "1800"));
    await pulsarEnDialogo("Continuar");
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "Se cambió el compresor"));
    await pulsarEnDialogo("Cerrar ticket");
    expect(posts()).toEqual([{ url: "/tickets/m1/cerrar", body: { actualCost: 1800, notaResolucion: "Se cambió el compresor" } }]);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("sin costo estimado muestra 'Sin estimar' y no 'Estimado: $0'", async () => {
    stub([{ ...TICKET, costoEstimado: 0 }]);
    rendered = renderComponent(<MantenimientoPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Sin estimar");
    expect(rendered.container.textContent).not.toContain("Estimado");
  });

  it("Nuevo ticket abre un FormDialog; sin titulo no envia, con datos manda POST .../tickets", async () => {
    stub();
    rendered = renderComponent(<MantenimientoPage {...CTX} />);
    await esperar();
    const nuevo = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nuevo ticket"))!;
    await act(async () => click(nuevo));
    const modal = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
    const crear = () => [...modal().querySelectorAll("button")].find((b) => b.textContent?.includes("Crear ticket"))!;
    await act(async () => {
      click(crear());
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(modal().textContent).toContain("Título y descripción son requeridos.");
    expect(posts()).toEqual([]);
    await act(async () => changeValue(modal().querySelector("input")!, "Fuga en baño"));
    await act(async () => changeValue(modal().querySelector("textarea")!, "Gotea la llave"));
    await act(async () => {
      click(crear());
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(posts()).toEqual([{ url: "/tickets", body: { titulo: "Fuga en baño", descripcion: "Gotea la llave", severidad: "media", origen: "staff" } }]);
  });
});

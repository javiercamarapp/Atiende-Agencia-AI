// @vitest-environment jsdom
//
// UNI-C-hoteles (operacion): la pagina de Pedidos F&B pedia la nota de cocina con window.prompt. Ahora usa
// useConfirm: Cancelar/Escape NO confirma; confirmar manda POST .../confirmar-cocina con la nota. El alta
// vive en un FormDialog y exige al menos un platillo con nombre.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosFnbPage } from "../src/verticals/hoteles/pages/PedidosFnb.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "fnb", staffFullName: "Ana", staffEmail: "ana@example.com" };
const PEDIDO = {
  id: "p1", roomId: "101", items: [{ nombre: "Pasta" }], notas: null, alergiaDeclarada: true, alergiaDetectadaVia: "campo",
  cocineroConfirmoEn: null, cocineroConfirmoPor: null, puedeAsegurarSeguridad: false, mensajeSeguridad: "Falta confirmar en cocina.",
  seguridadAseguradaEn: null, creadoEn: "2026-03-10T18:00:00.000Z",
};

function stub() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url.endsWith("/hoteles/prop-1/pedidos-fnb")) return json([PEDIDO]);
    if (method === "POST") return json(PEDIDO);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => ({ url: String(c[0]).replace("https://api.test/hoteles/prop-1/pedidos-fnb", ""), body: JSON.parse(String(c[1].body)) }));
const dialogo = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
const botonPagina = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
async function abrirConfirmacion() {
  await act(async () => {
    click(botonPagina("Confirmar en cocina"));
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

describe("PedidosFnbPage (hoteles)", () => {
  it("la nota de cocina se pide con un dialogo, no con window.prompt, y Cancelar no escribe", async () => {
    stub();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("no debe usarse");
    rendered = renderComponent(<PedidosFnbPage {...CTX} />);
    await esperar();
    await abrirConfirmacion();
    expect(dialogo()).not.toBeNull();
    const cancelar = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar")!;
    await act(async () => {
      click(cancelar);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(posts()).toEqual([]);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("Escape tampoco confirma en cocina", async () => {
    stub();
    rendered = renderComponent(<PedidosFnbPage {...CTX} />);
    await esperar();
    await abrirConfirmacion();
    await act(async () => {
      keydown(dialogo()!, "Escape");
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(posts()).toEqual([]);
  });

  it("confirmar con nota manda POST .../p1/confirmar-cocina", async () => {
    stub();
    rendered = renderComponent(<PedidosFnbPage {...CTX} />);
    await esperar();
    await abrirConfirmacion();
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "Sin gluten verificado"));
    const ok = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Confirmar en cocina")!;
    await act(async () => {
      click(ok);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(posts()).toEqual([{ url: "/p1/confirmar-cocina", body: { nota: "Sin gluten verificado" } }]);
  });

  it("Tomar pedido sin platillo con nombre no envia; con platillo manda POST", async () => {
    stub();
    rendered = renderComponent(<PedidosFnbPage {...CTX} />);
    await esperar();
    await act(async () => click(botonPagina("Tomar pedido")));
    const modal = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
    const enviar = () => [...modal().querySelectorAll("button")].find((b) => b.textContent?.includes("Tomar pedido"))!;
    await act(async () => {
      click(enviar());
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(modal().textContent).toContain("Agrega al menos un platillo con nombre.");
    expect(posts()).toEqual([]);
    await act(async () => changeValue(modal().querySelector('input[aria-label="Platillo 1"]') as HTMLInputElement, "Sopa"));
    await act(async () => {
      click(enviar());
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(posts()).toEqual([{ url: "", body: { items: [{ nombre: "Sopa" }], alergiaDeclarada: false } }]);
  });
});

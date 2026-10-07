// @vitest-environment jsdom
//
// UNI-C-hoteles (operacion): el reverso de un cargo pedia el motivo con window.prompt. Ahora es un dialogo de
// useConfirm: Cancelar o Escape NO escriben; confirmar con motivo manda POST .../cargos/:id/reverso.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { FolioPage } from "../src/verticals/hoteles/pages/Folio.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { FolioSummary } from "../src/verticals/hoteles/lib/folios-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "GM", staffEmail: "gm@example.com" };
const FOLIO: FolioSummary = {
  id: "folio-1", estado: "abierto", reservationId: "res-1", etiqueta: "Hab. 101", esPrincipal: true, cerradoEn: null, motivoCierre: null,
  cargos: [{ id: "ch-1", concepto: "hospedaje", descripcion: "2 noches", monto: 2000, impuesto: 320, revertidoPor: null, reversaDe: null, transferidoDe: null, creadoEn: "2026-09-18T10:00:00.000Z" }],
  pagos: [], saldo: 2320,
};

function stub() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && /\/folios\/folio-1$/.test(url)) return json(FOLIO);
    if (method === "GET" && url.includes("/folios?")) return json([]);
    if (method === "POST" && url.endsWith("/reverso")) return json({ id: "rv-1" });
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
const reversos = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[0]).endsWith("/reverso"));
async function abrirReverso() {
  const boton = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reversar")!;
  await act(async () => {
    click(boton);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
function montar() {
  rendered = renderComponent(
    <MemoryRouter>
      <FolioPage {...CTX} folioId="folio-1" />
    </MemoryRouter>,
  );
}

describe("Folio: reverso de cargo con confirmacion", () => {
  it("abre un dialogo (nunca window.prompt) y Cancelar no escribe", async () => {
    stub();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("no debe usarse");
    montar();
    await esperar();
    await abrirReverso();
    expect(dialogo()).not.toBeNull();
    await act(async () => {
      click([...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(reversos()).toHaveLength(0);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("Escape no escribe", async () => {
    stub();
    montar();
    await esperar();
    await abrirReverso();
    await act(async () => {
      keydown(dialogo()!, "Escape");
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(reversos()).toHaveLength(0);
  });

  it("sin motivo el boton queda deshabilitado; con motivo manda POST .../reverso", async () => {
    stub();
    montar();
    await esperar();
    await abrirReverso();
    const ok = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reversar cargo")!;
    expect(ok().hasAttribute("disabled")).toBe(true);
    await act(async () => changeValue(dialogo()!.querySelector("input")!, "Cobro duplicado"));
    await act(async () => {
      click(ok());
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(reversos()).toHaveLength(1);
    expect(String(reversos()[0][0])).toContain("/folios/folio-1/cargos/ch-1/reverso");
    expect(JSON.parse(String(reversos()[0][1].body))).toEqual({ motivo: "Cobro duplicado" });
  });
});

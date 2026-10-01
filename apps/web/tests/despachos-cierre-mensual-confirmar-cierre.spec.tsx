// @vitest-environment jsdom
//
// PR-8 de diseno-ux (despachos): el cierre de periodo (irreversible) pasa del AlertDialog armado a mano al
// <ConfirmDialog> de @atiende/ui con campo de confirmacion escrita. Se afirma, igual que antes:
//   - el primer clic NO cierra nada (solo abre el dialogo);
//   - mientras el texto no sea exactamente AAAA-MM el boton de confirmar esta deshabilitado;
//   - Cancelar no llama al servidor;
//   - confirmar manda POST .../cerrar con { confirmacion } y recarga el periodo;
//   - si el servidor rechaza, el dialogo SIGUE abierto y muestra el error.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CierreMensualDetallePage } from "../src/verticals/despachos/pages/CierreMensualDetalle.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

const PERIODO = { id: "per-1", organizationId: "org-1", propertyId: "prop-1", year: 2026, month: 8, status: "open" as const, openedAt: "2026-09-01T00:00:00.000Z", closedAt: null, closedBy: null };
const DETALLE = { periodo: PERIODO, tareas: [], estado: { totalTasks: 0, done: 0, skipped: 0, pending: 0, inProgress: 0, progressPercent: 40, blocked: [], overdue: [] } };

function res(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function stubFetch(cerrar: () => Response) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/cierre-mensual/periodos/per-1")) return res(DETALLE);
    if (method === "POST" && url.endsWith("/cierre-mensual/periodos/per-1/cerrar")) return cerrar();
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montar(): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter initialEntries={["/despachos/demo/cierre-mensual/per-1"]}>
      <Routes>
        <Route path="/despachos/:orgSlug/cierre-mensual/:periodoId" element={<CierreMensualDetallePage {...CTX} />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  return r;
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;

async function abrirDialogo(r: RenderedComponent): Promise<void> {
  click([...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cerrar período")!);
  await act(async () => {
    await flushMicrotasks();
  });
}

describe("CierreMensualDetalle — cierre irreversible con ConfirmDialog", () => {
  it("el primer clic solo abre el dialogo (no llama al servidor) y exige teclear AAAA-MM", async () => {
    stubFetch(() => res({}));
    rendered = await montar();
    expect(dialogo()).toBeNull();
    await abrirDialogo(rendered);
    expect(dialogo()).not.toBeNull();
    expect(posts()).toHaveLength(0);
    expect(dialogo()!.textContent).toContain("irreversible");
    expect(botonDialogo("Confirmar cierre irreversible").disabled).toBe(true);
    changeValue(dialogo()!.querySelector("input")!, "2026-07");
    expect(botonDialogo("Confirmar cierre irreversible").disabled).toBe(true);
    changeValue(dialogo()!.querySelector("input")!, "2026-08");
    expect(botonDialogo("Confirmar cierre irreversible").disabled).toBe(false);
  });

  it("Cancelar no ejecuta el cierre", async () => {
    stubFetch(() => res({}));
    rendered = await montar();
    await abrirDialogo(rendered);
    changeValue(dialogo()!.querySelector("input")!, "2026-08");
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    expect(posts()).toHaveLength(0);
  });

  it("confirmar manda POST .../cerrar con la confirmacion tecleada", async () => {
    stubFetch(() => res({ ...PERIODO, status: "closed" }));
    rendered = await montar();
    await abrirDialogo(rendered);
    changeValue(dialogo()!.querySelector("input")!, "2026-08");
    await act(async () => {
      click(botonDialogo("Confirmar cierre irreversible"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain("/despachos/prop-1/cierre-mensual/periodos/per-1/cerrar");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ confirmacion: "2026-08" });
  });

  it("si el servidor rechaza, el dialogo sigue abierto mostrando el error", async () => {
    stubFetch(() => res({ error: "Hay tareas requeridas sin completar" }, false));
    rendered = await montar();
    await abrirDialogo(rendered);
    changeValue(dialogo()!.querySelector("input")!, "2026-08");
    await act(async () => {
      click(botonDialogo("Confirmar cierre irreversible"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.querySelector('[role="alert"]')).not.toBeNull();
  });
});

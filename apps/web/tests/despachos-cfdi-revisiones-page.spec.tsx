// @vitest-environment jsdom
//
// Cola de revision humana de <CfdiPage /> de despachos: es un DataTable (CFDI con enlace, motivo, fecha y acciones por fila).
// Las acciones (nota, Aprobar, Rechazar) solo existen para admin/contador. `fetch` global mockeado por ruta real.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const BASE: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contador", staffEmail: "c@example.com" };

const REVISIONES = [
  { id: "rev-1", invoiceId: "inv-1", motivo: "Total no cuadra con los conceptos", estado: "pendiente", creadoEn: "2026-09-01T10:00:00Z" },
  { id: "rev-2", invoiceId: "inv-2", motivo: "RFC receptor distinto", estado: "pendiente", creadoEn: "2026-09-02T10:00:00Z" },
];

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function cargar(role: string, revisiones: unknown[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/efos/alertas")) return ok({ lista: { estado: "disponible", periodo: "2026-09", filas: 0, ingestadoEn: null }, estado: "disponible", alertas: [] });
    if (init?.method === "POST" && url.includes("/revisiones/")) return ok({ ...REVISIONES[0], estado: "aprobado" });
    if (url.endsWith("/revisiones")) return ok(revisiones);
    if (url.includes("/cfdi")) return ok([]);
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  rendered = renderComponent(
    <MemoryRouter>
      <CfdiPage {...BASE} role={role as DespachosShellContext["role"]} />
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return fetchMock;
}

const ETIQUETA = 'table[aria-label="Cola de revisión humana"]';

describe("CfdiPage (despachos): cola de revision humana", () => {
  it("lista cada revision en una tabla con enlace al CFDI, motivo y fecha", async () => {
    await cargar("contador", REVISIONES);
    const tabla = rendered!.container.querySelector(ETIQUETA);
    expect(tabla).not.toBeNull();
    expect(tabla!.textContent).toContain("Total no cuadra con los conceptos");
    expect(tabla!.textContent).toContain("RFC receptor distinto");
    expect(tabla!.querySelector('a[href="/despachos/demo/cfdi/inv-1"]')).not.toBeNull();
    expect(tabla!.querySelector('a[href="/despachos/demo/cfdi/inv-2"]')).not.toBeNull();
  });

  it("admin/contador ven nota, Aprobar y Rechazar por fila y Aprobar llama al endpoint real", async () => {
    const fetchMock = await cargar("contador", REVISIONES);
    const tabla = rendered!.container.querySelector(ETIQUETA)!;
    expect(tabla.querySelector("#revision-nota-rev-1")).not.toBeNull();
    expect(tabla.querySelector("#revision-nota-rev-2")).not.toBeNull();
    const botones = Array.from(tabla.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(botones.filter((t) => t === "Aprobar")).toHaveLength(2);
    expect(botones.filter((t) => t === "Rechazar")).toHaveLength(2);

    const aprobar = Array.from(tabla.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Aprobar")!;
    await act(async () => {
      aprobar.click();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes("/revisiones/rev-1") && (i as RequestInit | undefined)?.method === "POST")).toBe(true);
  });

  it("un rol sin permiso ve la leyenda y ninguna accion", async () => {
    await cargar("lector", REVISIONES);
    const tabla = rendered!.container.querySelector(ETIQUETA)!;
    expect(tabla.textContent).toContain("Tu rol no puede resolver revisiones");
    expect(tabla.querySelector("input")).toBeNull();
    expect(Array.from(tabla.querySelectorAll("button")).some((b) => /Aprobar|Rechazar/.test(b.textContent ?? ""))).toBe(false);
  });

  it("sin revisiones pendientes no pinta tabla y avisa", async () => {
    await cargar("contador", []);
    expect(rendered!.container.querySelector(ETIQUETA)).toBeNull();
    expect(rendered!.container.textContent).toContain("No hay CFDI pendientes de revisión humana.");
  });
});

// @vitest-environment jsdom
//
// UNI-C-hoteles (operacion): cobertura de la pagina de Aprobaciones de agentes. La decision (aprobar/rechazar)
// pide un motivo en un dialogo: Cancelar/Escape NO deciden, un motivo corto bloquea el boton y confirmar manda
// POST .../aprobaciones/:id/aprobar con el motivo. Sin la tabla en la base muestra "no disponible aun".
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AprobacionesAgentesPage } from "../src/verticals/hoteles/pages/Aprobaciones.tsx";
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

const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "GM", staffEmail: "gm@example.com" };
const APROBACION = {
  id: "ap-1", agente: "revenue", accion: "descuento_tarifa", resumen: "Bajar 10% la tarifa del fin de semana", detalle: {}, montoCentavos: null, porcentaje: 10,
  destinatarios: null, contenido: null, estado: "pendiente", propuestaPor: null, propuestaPorAgente: true, autoaprobada: false, motivoBloqueo: null,
  expiraEn: "2026-10-30T00:00:00.000Z", decididaPor: null, decididaEn: null, motivoDecision: null, ejecutadaEn: null, referenciaEjecucion: null, creadaEn: "2026-10-01T00:00:00.000Z",
};

function stub(disponible = true) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;
    if (method === "GET" && url.includes("/hoteles/prop-1/aprobaciones")) {
      return json({ disponible, ahora: "2026-10-07T00:00:00.000Z", aprobaciones: disponible ? [APROBACION] : [] });
    }
    if (method === "POST" && url.endsWith("/aprobar")) return json({ ...APROBACION, estado: "aprobada" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const dialogo = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
async function abrirAprobar() {
  const boton = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Aprobar")!;
  await act(async () => {
    click(boton);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}

describe("AprobacionesAgentesPage (hoteles)", () => {
  it("lista la solicitud pendiente con su accion y su origen de agente", async () => {
    stub();
    rendered = renderComponent(<AprobacionesAgentesPage {...CTX} />);
    await esperar();
    const texto = rendered.container.textContent!;
    expect(texto).toContain("Bajar 10% la tarifa del fin de semana");
    expect(texto).toContain("Agente: revenue");
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("Cancelar en el dialogo del motivo no aprueba", async () => {
    stub();
    rendered = renderComponent(<AprobacionesAgentesPage {...CTX} />);
    await esperar();
    await abrirAprobar();
    expect(dialogo()).not.toBeNull();
    await act(async () => {
      click([...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Volver")!);
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(0);
  });

  it("Escape tampoco aprueba", async () => {
    stub();
    rendered = renderComponent(<AprobacionesAgentesPage {...CTX} />);
    await esperar();
    await abrirAprobar();
    await act(async () => {
      keydown(dialogo()!, "Escape");
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(0);
  });

  it("un motivo corto bloquea el boton; con motivo valido manda POST .../ap-1/aprobar", async () => {
    stub();
    rendered = renderComponent(<AprobacionesAgentesPage {...CTX} />);
    await esperar();
    await abrirAprobar();
    const ok = () => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Aprobar")!;
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "ok"));
    expect(ok().hasAttribute("disabled")).toBe(true);
    await act(async () => changeValue(dialogo()!.querySelector("textarea")!, "Ocupacion baja ese fin de semana"));
    await act(async () => {
      click(ok());
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toBe("https://api.test/hoteles/prop-1/aprobaciones/ap-1/aprobar");
    expect(JSON.parse(String(posts()[0][1].body))).toEqual({ motivo: "Ocupacion baja ese fin de semana" });
  });

  it("sin la tabla en la base muestra un estado honesto de 'aun no esta activo', nunca una lista vacia silenciosa", async () => {
    stub(false);
    rendered = renderComponent(<AprobacionesAgentesPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toMatch(/aún|no está activ|no disponible/i);
    expect(rendered.container.textContent).not.toContain("Bajar 10%");
  });
});

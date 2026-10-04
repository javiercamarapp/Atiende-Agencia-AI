// @vitest-environment jsdom
//
// UNI-C despachos (.1/.2) -- Contabilidad electronica: un solo h1, estado "Sin permiso" para roles sin acceso, labels en cada
// control y confirmar "listo para timbrar" pasa por useConfirm (Cancelar no llama a la API).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContabilidadElectronicaPage } from "../src/verticals/despachos/pages/ContabilidadElectronica.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { pulsarEnDialogo } from "./test-utils/confirm.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Contadora", staffEmail: "c@example.com" });
const PAQUETE = {
  periodo: "2026-09", ejercicio: 2026, mes: 9, rfc: "AAA010101AAA", razonSocial: "Cliente SA",
  catalogo: { xml: "<c/>", sha1: "abc", cuentas: 1 },
  balanza: { xml: "<b/>", sha1: "def", cuadrada: true, cuentas: 1 },
  resumenBalanza: { periodo: "2026-09", cuentas: 1, totalDebe: "100", totalHaber: "100", cuadrada: true, saldosAnomalos: [], lineas: [] },
  estado: "listo_para_timbrar", generadoEn: "2026-10-01T00:00:00.000Z",
};

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() } as unknown as Response;
}
function stubFetch() {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/catalogo-base")) return json({ catalogo: [] });
    if (method === "POST" && url.endsWith("/contabilidad-electronica/paquete")) return json(PAQUETE);
    if (method === "POST" && url.endsWith("/listo-para-timbrar")) return json({ estado: "listo_para_timbrar" });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function montar(role: string) {
  rendered = renderComponent(<ContabilidadElectronicaPage {...CTX(role)} />);
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const boton = (texto: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const listos = () => fetchMock.mock.calls.filter(([u, i]) => (i as RequestInit | undefined)?.method === "POST" && String(u).endsWith("/listo-para-timbrar"));

describe("ContabilidadElectronicaPage -- estructura y confirmacion", () => {
  it("un rol sin acceso ve \"Sin permiso\" (un solo h1) y no llama a la API", async () => {
    stubFetch();
    await montar("auditor");
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered!.container.textContent).toContain("Sin permiso");
    expect(boton("Generar catálogo")).toBeUndefined();
  });

  it("todo control tiene label asociado", async () => {
    stubFetch();
    await montar("contador");
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    for (const c of rendered!.container.querySelectorAll("input,select,textarea")) {
      const id = c.getAttribute("id");
      expect(id !== null && rendered!.container.querySelector(`label[for="${id}"]`) !== null).toBe(true);
    }
  });

  it("confirmar listo para timbrar: Cancelar no llama a la API; confirmar si", async () => {
    stubFetch();
    await montar("contador");
    const cuenta = rendered!.container.querySelector('input[id^="asiento-cuenta-"]') as HTMLInputElement;
    await act(async () => {
      changeValue(cuenta, "1101");
      await flushMicrotasks();
    });
    await act(async () => {
      click(boton("Generar catálogo")!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(rendered!.container.textContent).toContain("Periodo:");
    await act(async () => {
      click(boton("Confirmar listo para timbrar")!);
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Cancelar");
    expect(listos()).toHaveLength(0);
    await act(async () => {
      click(boton("Confirmar listo para timbrar")!);
      await flushMicrotasks();
    });
    await pulsarEnDialogo("Confirmar");
    expect(listos()).toHaveLength(1);
  });
});

// @vitest-environment jsdom
//
// D-P3-14 -- boton «Generar pólizas del periodo» del libro contable (jsdom): confirmacion, POST real con el periodo, resultado del servidor (generadas, ya tenian poliza,
// con revision pendiente, clasificacion dudosa, para registrar a mano), error visible, columna de categoria/confianza y control por rol.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibroContablePage } from "../src/verticals/despachos/pages/LibroContable.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });
const CUENTAS = [{ codigo: "1050000", descripcion: "Clientes", naturaleza: "D" }];
const BALANZA = { estado: "disponible", periodo: "2026-07", lineas: [], totales: { debeCentavos: 0, haberCentavos: 0, cuadrada: true } };
const CFDI = (armables: boolean) => ({
  periodo: "2026-07",
  truncado: false,
  cfdi: [
    { id: "inv-1", folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", direccion: "recibido", fecha: "2026-07-10", totalCentavos: 116000, estadoSat: "vigente", poliza: null, armable: armables, motivo: armables ? null : "Sin clasificar", categoriaContable: "equipo_computo", confianzaClasificacion: 0.9 },
    { id: "inv-2", folioFiscal: "22222222-2222-3333-4444-555555555555", tipo: "I", direccion: "recibido", fecha: "2026-07-11", totalCentavos: 50000, estadoSat: "vigente", poliza: null, armable: false, motivo: "Moneda extranjera", categoriaContable: null, confianzaClasificacion: null },
  ],
});

let llamadas: { url: string; method: string; body: unknown }[];
let rendered: RenderedComponent | undefined;

function stubFetch(opciones: { armables?: boolean; generar?: () => Response } = {}) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") {
        if (url.endsWith("/libro/cuentas")) return new Response(JSON.stringify({ estado: "disponible", cuentas: CUENTAS }), { status: 200 });
        if (url.includes("/libro/polizas?")) return new Response(JSON.stringify({ estado: "disponible", polizas: [] }), { status: 200 });
        if (url.includes("/libro/balanza")) return new Response(JSON.stringify(BALANZA), { status: 200 });
        if (url.includes("/libro/cfdi")) return new Response(JSON.stringify(CFDI(opciones.armables ?? true)), { status: 200 });
      }
      if (url.endsWith("/libro/polizas/generar-periodo")) return (opciones.generar ?? (() => new Response(JSON.stringify({ periodo: "2026-07", candidatos: 2, generadas: 1, yaTenian: 0, porRevision: 0, porClasificacion: 0, noArmables: [], fallidas: [] }), { status: 200 })))();
      return new Response("{}", { status: 404 });
    }),
  );
}

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function montar(role: string): Promise<RenderedComponent> {
  const r = renderComponent(
    <MemoryRouter>
      <LibroContablePage {...CTX(role)} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
  return r;
}
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
async function abrirPestanaCfdi() {
  const t = [...document.body.querySelectorAll('[role="tab"]')].find((x) => x.textContent?.includes("CFDI del periodo")) as HTMLElement;
  await act(async () => {
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    t.focus();
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
}
const esperar = async () => {
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
};

describe("Libro contable -- Generar pólizas del periodo (D-P3-14)", () => {
  it("el contador ve el boton con cuantos CFDI estan listos, la categoria y su confianza; el auditor y el readonly no lo ven", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirPestanaCfdi();
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("1 CFDI listos para contabilizar");
    expect(texto).toContain("equipo computo · 90 %");
    expect(boton("Generar pólizas del periodo")).toBeDefined();
    rendered.unmount();
    for (const rol of ["auditor", "readonly"]) {
      stubFetch();
      rendered = await montar(rol);
      await abrirPestanaCfdi();
      expect(boton("Generar pólizas del periodo")).toBeUndefined();
      rendered.unmount();
    }
    rendered = undefined;
  });

  it("sin CFDI armables el boton esta deshabilitado (nada que contabilizar)", async () => {
    stubFetch({ armables: false });
    rendered = await montar("contador");
    await abrirPestanaCfdi();
    expect(boton("Generar pólizas del periodo")!.disabled).toBe(true);
  });

  it("pide confirmacion, NO llama al servidor hasta confirmar, y luego manda POST {periodo} y muestra el resultado real", async () => {
    stubFetch({
      generar: () => new Response(JSON.stringify({ periodo: "2026-07", candidatos: 4, generadas: 2, yaTenian: 1, porRevision: 1, porClasificacion: 1, noArmables: [{ folioFiscal: "x", motivo: "Moneda extranjera" }], fallidas: [] }), { status: 200 }),
    });
    rendered = await montar("contador");
    await abrirPestanaCfdi();
    click(boton("Generar pólizas del periodo")!);
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("si lo repites no duplica nada");
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);
    click(boton("Generar pólizas", dialogo()!)!);
    await esperar();
    const post = llamadas.find((l) => l.url.endsWith("/libro/polizas/generar-periodo"))!;
    expect(post.method).toBe("POST");
    expect(post.body).toEqual({ periodo: expect.stringMatching(/^\d{4}-\d{2}$/) });
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("2 póliza(s) generada(s)");
    expect(texto).toContain("1 ya tenían póliza");
    expect(texto).toContain("1 con revisión pendiente");
    expect(texto).toContain("1 con clasificación dudosa");
    expect(texto).toContain("1 para registrar a mano");
    expect(dialogo()).toBeNull();
    // Despues de generar vuelve a pedir el libro (el listado queda al dia).
    expect(llamadas.filter((l) => l.url.includes("/libro/cfdi")).length).toBeGreaterThanOrEqual(2);
  });

  it("un error del servidor (periodo cerrado) se muestra en el dialogo y no se cierra ni inventa un resultado", async () => {
    stubFetch({ generar: () => new Response(JSON.stringify({ code: "conflict", message: "El periodo 2026-07 está cerrado." }), { status: 409 }) });
    rendered = await montar("contador");
    await abrirPestanaCfdi();
    click(boton("Generar pólizas del periodo")!);
    click(boton("Generar pólizas", dialogo()!)!);
    await esperar();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.querySelector('[role="alert"]')?.textContent ?? "").toContain("cerrado");
    expect(document.body.textContent).not.toContain("póliza(s) generada(s)");
  });
});

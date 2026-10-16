// @vitest-environment jsdom
//
// D-24 -- pantalla del libro contable (jsdom): polizas del periodo, CFDI por contabilizar, balanza, catalogo, alta de poliza con cuadre en vivo
// y validacion antes de enviar, reversa, base sin migrar, y acciones ocultas por rol.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibroContablePage } from "../src/verticals/despachos/pages/LibroContable.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });

const CUENTAS = [
  { codigo: "1050000", descripcion: "Clientes", naturaleza: "D" },
  { codigo: "4080000", descripcion: "Ingresos por servicios", naturaleza: "A" },
  { codigo: "2600400", descripcion: "IVA trasladado", naturaleza: "A" },
];
const POLIZA = { id: "00000000-0000-0000-0000-0000000000a1", ejercicio: 2026, mes: 7, tipo: "ingreso", folio: 1, fecha: "2026-07-20", concepto: "Honorarios de julio", origen: "manual", invoiceId: null, reversaDe: null, reversada: false, totalCentavos: 116000 };
const BALANZA = {
  estado: "disponible",
  periodo: "2026-07",
  lineas: [
    { cuenta: "1050000", descripcion: "Clientes", naturaleza: "D", saldoInicialCentavos: 0, debeCentavos: 116000, haberCentavos: 0, saldoFinalCentavos: 116000 },
    { cuenta: "4080000", descripcion: "Ingresos por servicios", naturaleza: "A", saldoInicialCentavos: 0, debeCentavos: 0, haberCentavos: 116000, saldoFinalCentavos: 116000 },
  ],
  totales: { debeCentavos: 116000, haberCentavos: 116000, cuadrada: true },
};
const CFDI = {
  periodo: "2026-07",
  truncado: false,
  cfdi: [
    { id: "inv-1", folioFiscal: "11111111-2222-3333-4444-555555555555", tipo: "I", direccion: "emitido", fecha: "2026-07-10", totalCentavos: 116000, estadoSat: "vigente", poliza: null, armable: true, motivo: null },
    { id: "inv-2", folioFiscal: "99999999-2222-3333-4444-555555555555", tipo: "N", direccion: "emitido", fecha: "2026-07-11", totalCentavos: 50000, estadoSat: "vigente", poliza: null, armable: false, motivo: "Un CFDI emitido de tipo N no genera póliza automática: regístrala a mano." },
  ],
};

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

function stubFetch(opciones: { cuentas?: unknown; polizas?: unknown; escritura?: () => Response } = {}) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") {
        if (url.endsWith("/libro/cuentas")) return new Response(JSON.stringify(opciones.cuentas ?? { estado: "disponible", cuentas: CUENTAS }), { status: 200 });
        if (url.includes("/libro/polizas?")) return new Response(JSON.stringify(opciones.polizas ?? { estado: "disponible", polizas: [POLIZA] }), { status: 200 });
        if (url.includes("/libro/balanza")) return new Response(JSON.stringify(BALANZA), { status: 200 });
        if (url.includes("/libro/pagos-rep")) return new Response(JSON.stringify({ estado: "disponible", pagos: [] }), { status: 200 });
        if (url.includes("/libro/cfdi")) return new Response(JSON.stringify(CFDI), { status: 200 });
        if (url.includes(`/libro/polizas/${POLIZA.id}`)) return new Response(JSON.stringify({ ...POLIZA, movimientos: [{ linea: 1, cuenta: "1050000", concepto: "", debeCentavos: 116000, haberCentavos: 0 }, { linea: 2, cuenta: "4080000", concepto: "", debeCentavos: 0, haberCentavos: 116000 }] }), { status: 200 });
      }
      return opciones.escritura ? opciones.escritura() : new Response(JSON.stringify({ polizaId: "nueva", folio: 2 }), { status: 201 });
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
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const pestana = (nombre: string) => [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(nombre)) as HTMLElement;
const abrirPestana = async (nombre: string) => {
  await act(async () => {
    const t = pestana(nombre);
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    t.focus();
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
  });
};

describe("LibroContablePage", () => {
  it("lista las polizas del periodo con folio, concepto, origen, total en pesos y estado", async () => {
    stubFetch();
    rendered = await montar("contador");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Libro contable");
    expect(texto).toContain("Ingreso 1");
    expect(texto).toContain("Honorarios de julio");
    expect(texto).toContain("$1,160.00");
    expect(texto).toContain("Vigente");
    expect(texto).toContain("Nueva póliza");
    expect(llamadas.find((l) => l.url.includes("/libro/polizas?"))!.url).toMatch(/ejercicio=\d{4}&mes=\d+/);
  });

  it("auditor/readonly ven pero no escriben: sin Nueva poliza ni Revertir", async () => {
    stubFetch();
    rendered = await montar("readonly");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Honorarios de julio");
    expect(texto).not.toContain("Nueva póliza");
    expect(texto).not.toContain("Revertir");
  });

  it("base sin migrar: aviso honesto y ninguna accion de escritura", async () => {
    stubFetch({ cuentas: { estado: "no_disponible", cuentas: [] }, polizas: { estado: "no_disponible", polizas: [] } });
    rendered = await montar("admin");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("falta aplicar la migración 020");
    expect(texto).not.toContain("Nueva póliza");
  });

  it("alta de poliza: validacion en el cliente (nada se envia) y luego POST en centavos con el cuadre en vivo", async () => {
    stubFetch();
    rendered = await montar("contador");
    click(boton("Nueva póliza")!);
    expect(dialogo()).not.toBeNull();
    await submitForm(document.getElementById("form-poliza") as HTMLFormElement);
    expect(dialogo()!.textContent).toContain("El concepto es obligatorio.");
    expect(dialogo()!.textContent).toContain("Partida 1: Elige la cuenta.");
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);

    changeValue(document.getElementById("poliza-concepto") as HTMLInputElement, "Honorarios agosto");
    const selects = [...dialogo()!.querySelectorAll("select")].filter((s) => s.getAttribute("aria-label")?.startsWith("Cuenta"));
    changeValue(selects[0] as HTMLSelectElement, "1050000");
    changeValue(selects[1] as HTMLSelectElement, "4080000");
    changeValue(dialogo()!.querySelector('[aria-label="Debe de la partida 1"]') as HTMLInputElement, "1,000.00");
    changeValue(dialogo()!.querySelector('[aria-label="Haber de la partida 2"]') as HTMLInputElement, "999.99");
    expect(dialogo()!.textContent).toContain("Diferencia $0.01");
    await submitForm(document.getElementById("form-poliza") as HTMLFormElement);
    expect(dialogo()!.textContent).toContain("La póliza no cuadra: diferencia de $0.01.");
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);

    changeValue(dialogo()!.querySelector('[aria-label="Haber de la partida 2"]') as HTMLInputElement, "1000");
    expect(dialogo()!.textContent).toContain("Cuadra");
    await submitForm(document.getElementById("form-poliza") as HTMLFormElement);
    for (let i = 0; i < 4; i++) await act(async () => flushMicrotasks());
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toBe("https://api.test/despachos/p1/libro/polizas");
    expect(post.body).toMatchObject({ tipo: "diario", concepto: "Honorarios agosto", movimientos: [{ cuenta: "1050000", debe: 100000, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 100000 }] });
    expect(dialogo()).toBeNull();
    expect(rendered.container.textContent).toContain("folio 2 registrada");
  });

  it("alta: el error del servidor (periodo cerrado) se muestra y el dialogo sigue abierto", async () => {
    stubFetch({ escritura: () => new Response(JSON.stringify({ code: "conflict", message: "el periodo 2026-07 está cerrado" }), { status: 409 }) });
    rendered = await montar("admin");
    click(boton("Nueva póliza")!);
    changeValue(document.getElementById("poliza-concepto") as HTMLInputElement, "x");
    const selects = [...dialogo()!.querySelectorAll("select")].filter((s) => s.getAttribute("aria-label")?.startsWith("Cuenta"));
    changeValue(selects[0] as HTMLSelectElement, "1050000");
    changeValue(selects[1] as HTMLSelectElement, "4080000");
    changeValue(dialogo()!.querySelector('[aria-label="Debe de la partida 1"]') as HTMLInputElement, "10");
    changeValue(dialogo()!.querySelector('[aria-label="Haber de la partida 2"]') as HTMLInputElement, "10");
    await submitForm(document.getElementById("form-poliza") as HTMLFormElement);
    for (let i = 0; i < 4; i++) await act(async () => flushMicrotasks());
    expect(dialogo()!.textContent).toContain("el periodo 2026-07 está cerrado");
  });

  it("ver una poliza muestra sus partidas; revertir manda fecha y concepto", async () => {
    stubFetch();
    rendered = await montar("contador");
    click(boton("Ver")!);
    for (let i = 0; i < 4; i++) await act(async () => flushMicrotasks());
    expect(dialogo()!.textContent).toContain("1050000");
    expect(dialogo()!.textContent).toContain("1,160.00");
    click(boton("Cerrar", dialogo()!)!);
    click(boton("Revertir")!);
    expect(dialogo()!.textContent).toContain("Revertir póliza");
    changeValue(document.getElementById("reversa-fecha") as HTMLInputElement, "2026-07-25");
    changeValue(document.getElementById("reversa-concepto") as HTMLInputElement, "Corrige captura");
    await submitForm(document.getElementById("form-reversa") as HTMLFormElement);
    for (let i = 0; i < 4; i++) await act(async () => flushMicrotasks());
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toBe(`https://api.test/despachos/p1/libro/polizas/${POLIZA.id}/reversar`);
    expect(post.body).toEqual({ fecha: "2026-07-25", concepto: "Corrige captura" });
  });

  it("CFDI del periodo: Contabilizar solo en los armables y el motivo visible en los demas", async () => {
    stubFetch();
    rendered = await montar("contador");
    await abrirPestana("CFDI del periodo");
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("11111111…");
    expect(texto).toContain("no genera póliza automática");
    expect(document.body.querySelectorAll("button").length).toBeGreaterThan(0);
    const contabilizar = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.includes("Contabilizar"));
    expect(contabilizar).toHaveLength(1);
    click(contabilizar[0]!);
    for (let i = 0; i < 4; i++) await act(async () => flushMicrotasks());
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toBe("https://api.test/despachos/p1/libro/polizas/desde-cfdi");
    expect(post.body).toEqual({ invoiceId: "inv-1" });
  });

  it("balanza: muestra que cuadra y los saldos", async () => {
    stubFetch();
    rendered = await montar("auditor");
    await abrirPestana("Balanza");
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("La balanza cuadra");
    expect(texto).toContain("Ingresos por servicios");
  });
});

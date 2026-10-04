// @vitest-environment jsdom
//
// D-32 -- pantalla de Honorarios (jsdom): lista de igualas y prefacturas del periodo, estado HONESTO del PAC (sin credencial no hay boton "Timbrar" y la
// pantalla dice que el timbrado esta pendiente), base sin migrar, acciones ocultas por rol, alta de iguala con validacion y cuerpo en centavos,
// generar prefacturas, timbrar con confirmacion y cancelar con motivo (01 exige folio) y confirmacion.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HonorariosPage } from "../src/verticals/despachos/pages/Honorarios.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { ListaIgualas, ListaPrefacturas, Prefactura } from "../src/verticals/despachos/lib/honorarios-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });
const MSG_PAC = "Timbrado pendiente: falta credencial del PAC (D-20)";
const U = "11111111-1111-4111-8111-111111111111";

const IGUALA = { id: "i1", concepto: "Iguala contable mensual", claveProdServ: "84111500", claveUnidad: "E48", claveSatEstado: "por_verificar", montoBaseCentavos: 100_000, tasaIvaBp: 1600, retencionIsrBp: 0, retieneIvaDosTercios: false, periodicidad: "mensual", diaEmision: 5, usoCfdi: "G03", activa: true } as const;
const prefactura = (extra: Partial<Prefactura> = {}): Prefactura => ({
  id: "f1", igualaId: "i1", periodo: "2026-07", estado: "aprobada", concepto: "Iguala contable mensual", receptor: { rfc: "RRR010101RR1", razonSocial: "Receptor Uno SA de CV", regimenFiscal: "601", codigoPostal: "64000" }, fechaEmision: "2026-07-05",
  baseCentavos: 100_000, ivaCentavos: 16_000, retencionIsrCentavos: 0, retencionIvaCentavos: 0, totalCentavos: 116_000, uuid: null, urlPdf: null, urlXml: null, errorTimbrado: null, motivoCancelacion: null, timbrable: { ok: true }, ...extra,
});

interface Llamada { readonly url: string; readonly method: string; readonly body: unknown }
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

function stubFetch(opciones: { igualas?: ListaIgualas; prefacturas?: ListaPrefacturas; escritura?: (url: string, method: string) => Response }) {
  llamadas = [];
  const igualas: ListaIgualas = opciones.igualas ?? { estado: "disponible", igualas: [IGUALA] };
  const lista: ListaPrefacturas = opciones.prefacturas ?? { estado: "disponible", periodo: null, pac: { configurado: false, mensaje: MSG_PAC }, prefacturas: [prefactura()] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.includes("/honorarios/igualas")) return new Response(JSON.stringify(igualas), { status: 200 });
      if (method === "GET" && url.includes("/honorarios/prefacturas")) return new Response(JSON.stringify(lista), { status: 200 });
      return opciones.escritura ? opciones.escritura(url, method) : new Response(JSON.stringify({ ok: true, generadas: 1, yaExistian: 0, omitidas: [], periodo: "2026-07", prefactura: prefactura(), yaTimbrada: false, advertencias: [], igualaId: "i9" }), { status: 200 });
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
  const r = renderComponent(<HonorariosPage {...CTX(role)} />);
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
  return r;
}
const flush = async () => act(async () => { for (let i = 0; i < 8; i++) await flushMicrotasks(); });
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
const escrituras = () => llamadas.filter((l) => l.method !== "GET");
const dialogoConfirmar = () => document.body.querySelector('[role="alertdialog"]');

describe("HonorariosPage: lectura y estado honesto", () => {
  it("muestra igualas y prefacturas con su desglose, y SIN PAC no ofrece Timbrar: dice que el timbrado esta pendiente", async () => {
    stubFetch({});
    rendered = await montar("admin");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Iguala contable mensual");
    expect(texto).toContain("$1,000.00");
    expect(texto).toContain("Por verificar");
    expect(texto).toContain("Receptor Uno SA de CV");
    expect(texto).toContain("$1,160.00");
    expect(texto).toContain("Aprobada");
    expect(texto).toContain(MSG_PAC);
    expect(boton("Timbrar", rendered.container)).toBeUndefined();
    expect(escrituras()).toHaveLength(0);
  });
  it("con PAC configurado una aprobada si se puede timbrar", async () => {
    stubFetch({ prefacturas: { estado: "disponible", periodo: null, pac: { configurado: true, mensaje: null }, prefacturas: [prefactura()] } });
    rendered = await montar("admin");
    expect(rendered.container.textContent).toContain("PAC configurado");
    expect(boton("Timbrar", rendered.container)).toBeDefined();
  });
  it("una aprobada con retenciones NO ofrece Timbrar aunque haya PAC: muestra el motivo del servidor", async () => {
    stubFetch({ prefacturas: { estado: "disponible", periodo: null, pac: { configurado: true, mensaje: null }, prefacturas: [prefactura({ retencionIsrCentavos: 10_000, totalCentavos: 106_000, timbrable: { ok: false, motivo: "Esta prefactura lleva retenciones y el timbrado con retenciones aun no esta verificado" } })] } });
    rendered = await montar("admin");
    expect(boton("Timbrar", rendered.container)).toBeUndefined();
    expect(rendered.container.textContent).toContain("lleva retenciones");
    expect(rendered.container.textContent).toContain("retenciones $100.00");
  });
  it("base sin migrar: lo dice y no muestra controles ni listas vacias engañosas", async () => {
    stubFetch({ igualas: { estado: "no_disponible", igualas: [] }, prefacturas: { estado: "no_disponible", periodo: null, pac: { configurado: false, mensaje: MSG_PAC }, prefacturas: [] } });
    rendered = await montar("admin");
    expect(rendered.container.textContent).toContain("migración 023");
    expect(boton("Nueva iguala", rendered.container)).toBeUndefined();
    expect(boton("Generar prefacturas", rendered.container)).toBeUndefined();
  });
  it("el contador (y los demas roles) ve pero no tiene acciones de escritura", async () => {
    stubFetch({});
    for (const rol of ["contador", "auditor", "readonly"]) {
      rendered = await montar(rol);
      for (const texto of ["Nueva iguala", "Generar prefacturas", "Aprobar", "Cancelar", "Editar", "Eliminar", "Timbrar"]) expect(boton(texto, rendered.container), `${rol} ${texto}`).toBeUndefined();
      expect(rendered.container.textContent).toContain("Iguala contable mensual");
      rendered.unmount();
      rendered = undefined;
    }
  });
  it("un error de carga se muestra con reintento", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Servicio caido" }), { status: 500 })));
    rendered = await montar("admin");
    expect(rendered.container.textContent).toContain("Servicio caido");
  });
});

describe("HonorariosPage: escrituras", () => {
  it("crear iguala: valida en el cliente y manda el cuerpo en centavos enteros", async () => {
    stubFetch({});
    rendered = await montar("admin");
    click(boton("Nueva iguala", rendered.container)!);
    await flush();
    const form = document.getElementById("form-iguala") as HTMLFormElement;
    await submitForm(form);
    expect(escrituras()).toHaveLength(0);
    expect(form.textContent).toContain("De 3 a 200 caracteres.");
    changeValue(document.getElementById("form-iguala-concepto") as HTMLInputElement, "Iguala fiscal");
    changeValue(document.getElementById("form-iguala-monto") as HTMLInputElement, "2,500.50");
    changeValue(document.getElementById("form-iguala-isr") as HTMLInputElement, "10");
    await submitForm(form);
    await flush();
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]).toMatchObject({ method: "POST", url: "https://api.test/despachos/p1/honorarios/igualas", body: { concepto: "Iguala fiscal", montoBaseCentavos: 250_050, tasaIvaBp: 1600, retencionIsrBp: 1000, retieneIvaDosTercios: false, diaEmision: 1, usoCfdi: "G03", activa: true } });
  });
  it("un rechazo del servidor al guardar la iguala se muestra dentro del dialogo", async () => {
    stubFetch({ escritura: () => new Response(JSON.stringify({ message: "tope de 50 igualas por cliente" }), { status: 409 }) });
    rendered = await montar("admin");
    click(boton("Nueva iguala", rendered.container)!);
    await flush();
    changeValue(document.getElementById("form-iguala-concepto") as HTMLInputElement, "Iguala fiscal");
    changeValue(document.getElementById("form-iguala-monto") as HTMLInputElement, "100");
    await submitForm(document.getElementById("form-iguala") as HTMLFormElement);
    await flush();
    expect(document.getElementById("form-iguala")!.textContent).toContain("tope de 50 igualas por cliente");
  });
  it("generar prefacturas manda el periodo y lista las omitidas con su motivo", async () => {
    stubFetch({ escritura: () => new Response(JSON.stringify({ periodo: "2026-07", generadas: 0, yaExistian: 0, omitidas: [{ igualaId: "i1", concepto: "Iguala contable mensual", motivo: "el cliente no tiene ficha fiscal (RFC, regimen, CP)" }] }), { status: 200 }) });
    rendered = await montar("admin");
    await act(async () => { click(boton("Generar prefacturas", rendered!.container)!); });
    await flush();
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]!.method).toBe("POST");
    expect(escrituras()[0]!.url).toMatch(/\/honorarios\/generar-prefacturas\?periodo=\d{4}-\d{2}$/);
    expect(rendered.container.textContent).toContain("no tiene ficha fiscal");
  });
  it("aprobar un borrador manda POST .../aprobar", async () => {
    stubFetch({ prefacturas: { estado: "disponible", periodo: null, pac: { configurado: false, mensaje: MSG_PAC }, prefacturas: [prefactura({ estado: "borrador" })] } });
    rendered = await montar("admin");
    await act(async () => { click(boton("Aprobar", rendered!.container)!); });
    await flush();
    expect(escrituras().map((l) => l.url)).toEqual(["https://api.test/despachos/p1/honorarios/prefacturas/f1/aprobar"]);
  });
  it("timbrar pide confirmacion: Cancelar no llama al servidor; confirmar manda POST .../timbrar", async () => {
    stubFetch({ prefacturas: { estado: "disponible", periodo: null, pac: { configurado: true, mensaje: null }, prefacturas: [prefactura()] } });
    rendered = await montar("admin");
    await act(async () => { click(boton("Timbrar", rendered!.container)!); });
    await flush();
    expect(dialogoConfirmar()).not.toBeNull();
    expect(dialogoConfirmar()!.textContent).toContain("solo se deshace cancelándolo ante el SAT");
    await act(async () => { click(boton("Cancelar", dialogoConfirmar() as HTMLElement)!); });
    await flush();
    expect(escrituras()).toHaveLength(0);
    await act(async () => { click(boton("Timbrar", rendered!.container)!); });
    await flush();
    await act(async () => { click(boton("Timbrar", dialogoConfirmar() as HTMLElement)!); });
    await flush();
    expect(escrituras().map((l) => l.url)).toEqual(["https://api.test/despachos/p1/honorarios/prefacturas/f1/timbrar"]);
  });
  it("un fallo del PAC (502) al timbrar no se simula como exito: el aviso sale del servidor y no hay UUID", async () => {
    stubFetch({
      prefacturas: { estado: "disponible", periodo: null, pac: { configurado: true, mensaje: null }, prefacturas: [prefactura()] },
      escritura: () => new Response(JSON.stringify({ code: "pac_error", message: "El PAC no pudo timbrar la prefactura; puedes reintentar." }), { status: 502 }),
    });
    rendered = await montar("admin");
    await act(async () => { click(boton("Timbrar", rendered!.container)!); });
    await flush();
    await act(async () => { click(boton("Timbrar", dialogoConfirmar() as HTMLElement)!); });
    await flush();
    expect(escrituras()).toHaveLength(1);
    expect(rendered.container.textContent).not.toMatch(/[0-9a-f]{8}…/);
  });
  it("cancelar: exige motivo; el 01 exige folio UUID; luego confirma y manda POST .../cancelar", async () => {
    stubFetch({});
    rendered = await montar("admin");
    await act(async () => { click(boton("Cancelar", rendered!.container)!); });
    await flush();
    const form = document.getElementById("form-cancelar-prefactura") as HTMLFormElement;
    await submitForm(form);
    expect(form.textContent).toContain("Elige el motivo");
    changeValue(document.getElementById("cancelar-motivo") as HTMLSelectElement, "01");
    await flush();
    await submitForm(form);
    expect(form.textContent).toContain("exige el folio fiscal");
    expect(escrituras()).toHaveLength(0);
    changeValue(document.getElementById("cancelar-folio") as HTMLInputElement, U);
    await submitForm(form);
    await flush();
    expect(dialogoConfirmar()).not.toBeNull();
    expect(escrituras()).toHaveLength(0);
    await act(async () => { click(boton("Cancelar prefactura", dialogoConfirmar() as HTMLElement)!); });
    await flush();
    expect(escrituras()).toHaveLength(1);
    expect(escrituras()[0]).toMatchObject({ method: "POST", url: "https://api.test/despachos/p1/honorarios/prefacturas/f1/cancelar", body: { motivo: "01", folioSustitucion: U } });
  });
  it("eliminar una iguala pide confirmacion y manda DELETE", async () => {
    stubFetch({});
    rendered = await montar("admin");
    await act(async () => { click(boton("Eliminar", rendered!.container)!); });
    await flush();
    expect(escrituras()).toHaveLength(0);
    await act(async () => { click(boton("Eliminar", dialogoConfirmar() as HTMLElement)!); });
    await flush();
    expect(escrituras()).toMatchObject([{ method: "DELETE", url: "https://api.test/despachos/p1/honorarios/igualas/i1" }]);
  });
});

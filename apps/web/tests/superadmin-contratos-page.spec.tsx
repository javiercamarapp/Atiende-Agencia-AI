// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminContratosPage } from "../src/superadmin/pages/Contratos.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, clone() { return this; }, status: ok ? 200 : 400 }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const ORGS = [{ id: "o1", name: "Los Taquitos de PM", vertical: "restaurantes", status: "active", slug: "taquitos" }, { id: "o2", name: "Hotel Sin Contrato", vertical: "hoteles", status: "active", slug: "hotel" }];
const V1 = { id: "v1", contractId: "c1", organizationId: "o1", organizacion: "Los Taquitos de PM", version: 1, vigenteDesde: "2026-01-01", vigenteHasta: null, moneda: "MXN", baseCentavos: 590_000, porSucursalCentavos: 400_000, sucursalesIncluidas: 1, bolsaMinutos: 10_000, excedenteCentavosMinuto: 300, instalacionCentavos: 4_500_000, descuentoBp: 1_000, descuentoFijoCentavos: 5_000, motivo: "Alta del contrato segun la propuesta firmada.", creadoPor: "u1", creadoPorCorreo: "ana@atiende.ai", creadoEnMs: Date.parse("2026-01-02T10:00:00Z") };
const V2 = { ...V1, id: "v2", version: 2, vigenteDesde: "2026-10-16", baseCentavos: 790_000, motivo: "Sube la base por el alta de la cuarta sucursal.", creadoPorCorreo: "beto@atiende.ai" };
const EST = {
  estado: "estimado", diasDelMes: 31,
  segmentos: [
    { version: 1, desde: "2026-10-01", hasta: "2026-10-15", dias: 15, sucursalesExtra: 2, mensualCentavos: 1_251_000, proporcionalCentavos: 605_323 },
    { version: 2, desde: "2026-10-16", hasta: "2026-10-31", dias: 16, sucursalesExtra: 2, mensualCentavos: 1_590_000, proporcionalCentavos: 820_645 },
  ],
  recurrenteCentavos: 1_425_968, bolsaMinutos: 10_000, minutosUsados: 10_500, minutosExcedentes: 500, tarifaExcedenteCentavosMinuto: 300, excedenteCentavos: 150_000, totalCentavos: 1_575_968, razonTotal: null,
  supuestos: ["Subtotal antes de IVA, en MXN, en centavos enteros. Es una estimacion: no cobra ni emite ninguna factura."],
};

interface Opts {
  disponible?: boolean;
  versiones?: unknown[];
  estimacion?: unknown;
  onWrite?: (method: string, url: string, body: unknown) => void;
  fallaEscritura?: boolean;
}

function stub(opts: Opts = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      opts.onWrite?.(init.method, url, init.body ? JSON.parse(String(init.body)) : null);
      return opts.fallaEscritura ? json({ message: "Las vigencias de dos contratos no pueden traslaparse." }, false) : json({ ok: true });
    }
    if (url.endsWith("/superadmin/organizations")) return json({ organizations: ORGS });
    if (url.includes("/superadmin/contratos/estimacion")) {
      if (url.includes("organizationId=o2")) return json({ disponible: true, estimacion: { ...EST, estado: "sin_contrato", segmentos: [], recurrenteCentavos: null, excedenteCentavos: null, totalCentavos: null } });
      return json({ disponible: true, insumos: { sucursalesActivas: 3, minutosVoz: 10_500, eventosVoz: 12 }, estimacion: opts.estimacion ?? EST });
    }
    if (url.includes("/superadmin/contratos")) {
      if (opts.disponible === false) return json({ disponible: false, mensaje: "Falta aplicar la migración 0037_superadmin_contrato_cliente.", versiones: [] });
      if (url.includes("organizationId=o2")) return json({ disponible: true, versiones: [] });
      return json({ disponible: true, versiones: opts.versiones ?? [V2, V1] });
    }
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const render = () => renderComponent(<SuperAdminContratosPage apiBaseUrl="https://api.test" token="tok" />);
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto);
function campo(etiqueta: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.textContent?.includes(etiqueta));
  if (!label) throw new Error(`sin etiqueta: ${etiqueta}`);
  return document.getElementById(label.getAttribute("for") ?? "") as HTMLInputElement;
}
const dialogForm = () => document.body.querySelector('[role="dialog"] form') as HTMLFormElement;
function llenarAlta(parche: Record<string, string> = {}) {
  const v: Record<string, string> = { "Vigente desde": "2026-11-01", "Base mensual": "5900", "Por sucursal adicional": "4000", "Sucursales incluidas": "1", "Bolsa de minutos": "10000", "Excedente por minuto": "3", "Motivo": "Alta del contrato segun la propuesta firmada.", ...parche };
  for (const [etiqueta, valor] of Object.entries(v)) changeValue(campo(etiqueta), valor);
}

describe("SuperAdminContratosPage -- lectura", () => {
  it("muestra la facturacion estimada en pesos (de centavos enteros), el prorrateo por version y los supuestos", async () => {
    stub();
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Contratos por cliente");
    expect(t).toContain("$14,259.68");
    expect(t).toContain("$1,500.00");
    expect(t).toContain("$15,759.68");
    expect(t).toContain("15 de 31");
    expect(t).toContain("16 de 31");
    expect(t).toContain("Sucursales activas: 3");
    expect(t).toContain("Minutos usados: 10500");
    expect(t).toContain("no cobra ni emite ninguna factura");
  });

  it("historial: versiones con quien las cambio, descuentos y solo la ultima es «Vigente» con boton para cambiar", async () => {
    stub();
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("ana@atiende.ai");
    expect(t).toContain("beto@atiende.ai");
    expect(t).toContain("16/10/2026");
    expect(t).toContain("sin fin");
    expect(t).toContain("10 %");
    expect(t).toContain("− $50.00 fijo");
    expect(t).toContain("excedente $3.00/min");
    expect(t.match(/Vigente/gu)?.length).toBeGreaterThanOrEqual(1);
    expect([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Cambiar condiciones")).toHaveLength(1);
  });

  it("sin minutos medidos: total «No disponible» con su razon, nunca $0.00 inventado", async () => {
    stub({ estimacion: { ...EST, minutosUsados: null, minutosExcedentes: null, excedenteCentavos: null, totalCentavos: null, razonTotal: "Los minutos de voz del mes no estan medidos todavia: solo se conoce el recurrente." } });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Total no disponible");
    expect(t).toContain("no estan medidos todavia");
    expect(t).toContain("Minutos usados: no medidos");
    expect(t).not.toContain("$0.00");
  });

  it("organizacion sin contrato: aviso honesto y estado vacio", async () => {
    stub();
    rendered = render();
    await esperar();
    changeValue(rendered.container.querySelector("select") as HTMLSelectElement, "o2");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Sin contrato vigente en este mes");
    expect(t).toContain("todavía no tiene contrato registrado");
  });

  it("base sin migrar: aviso, sin boton de alta ni de cambio", async () => {
    stub({ disponible: false });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Todavía no disponible en esta base");
    expect(rendered.container.textContent).toContain("0037");
    const botones = [...rendered.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(botones).not.toContain("Nuevo contrato");
    expect(botones).not.toContain("Cambiar condiciones");
  });
});

describe("SuperAdminContratosPage -- alta y enmienda", () => {
  it("alta: valida montos y motivo sin llamar al backend; valida manda centavos ENTEROS y puntos base", async () => {
    const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    stub({ onWrite: (method, url, body) => writes.push({ method, url, body: body as Record<string, unknown> }) });
    rendered = render();
    await esperar();
    click(boton("Nuevo contrato")!);
    await esperar();

    llenarAlta({ "Por sucursal adicional": "40.999" });
    await submitForm(dialogForm());
    expect(document.body.textContent).toContain("hasta 2 decimales");
    llenarAlta({ "Por sucursal adicional": "4000", "Motivo": "corto" });
    await submitForm(dialogForm());
    expect(document.body.textContent).toContain("al menos 20 caracteres");
    llenarAlta({ "Motivo": "Alta del contrato segun la propuesta firmada.", "Descuento porcentual": "100.5" });
    await submitForm(dialogForm());
    expect(document.body.textContent).toContain("de 0 a 100");
    expect(writes).toHaveLength(0);

    llenarAlta({ "Descuento porcentual": "12.5", "Instalación": "45000", "Descuento fijo": "19.99", "Vigente hasta": "2027-10-31" });
    await submitForm(dialogForm());
    await esperar();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: "POST",
      url: "https://api.test/superadmin/contratos",
      body: { organizationId: "o1", vigenteDesde: "2026-11-01", vigenteHasta: "2027-10-31", baseCentavos: 590_000, porSucursalCentavos: 400_000, sucursalesIncluidas: 1, bolsaMinutos: 10_000, excedenteCentavosMinuto: 300, instalacionCentavos: 4_500_000, descuentoBp: 1_250, descuentoFijoCentavos: 1_999 },
    });
    for (const n of ["baseCentavos", "porSucursalCentavos", "excedenteCentavosMinuto", "instalacionCentavos", "descuentoBp", "descuentoFijoCentavos"]) expect(Number.isInteger(writes[0]?.body[n]), n).toBe(true);
  });

  it("alta sin fecha de fin manda null, y un rechazo del servidor (vigencias traslapadas) se muestra sin cerrar el formulario", async () => {
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    stub({ fallaEscritura: true, onWrite: (_m, url, body) => writes.push({ url, body: body as Record<string, unknown> }) });
    rendered = render();
    await esperar();
    click(boton("Nuevo contrato")!);
    await esperar();
    llenarAlta();
    await submitForm(dialogForm());
    await esperar();
    expect(writes[0]?.body.vigenteHasta).toBeNull();
    expect(document.body.textContent).toContain("no pueden traslaparse");
    expect(dialogForm()).not.toBeNull();
  });

  it("cambiar condiciones: precarga la version vigente, exige motivo y manda la ENMIENDA al contrato (no una alta)", async () => {
    const writes: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    stub({ onWrite: (method, url, body) => writes.push({ method, url, body: body as Record<string, unknown> }) });
    rendered = render();
    await esperar();
    click(boton("Cambiar condiciones")!);
    await esperar();
    expect(campo("Base mensual").value).toBe("7900");
    expect(campo("Descuento porcentual").value).toBe("10");
    expect(campo("Descuento fijo").value).toBe("50");
    changeValue(campo("Vigente desde"), "2026-11-10");
    changeValue(campo("Base mensual"), "8500.50");
    changeValue(campo("Motivo"), "Sube la base por el alta de la quinta sucursal.");
    await submitForm(dialogForm());
    await esperar();
    expect(writes[0]).toMatchObject({ method: "POST", url: "https://api.test/superadmin/contratos/c1/enmiendas", body: { vigenteDesde: "2026-11-10", baseCentavos: 850_050, descuentoBp: 1_000, descuentoFijoCentavos: 5_000 } });
    expect(writes[0]?.body).not.toHaveProperty("organizationId");
  });
});

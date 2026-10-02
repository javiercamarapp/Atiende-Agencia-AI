// @vitest-environment jsdom
//
// D-25 -- pantalla de pagos provisionales (jsdom): papel con ISR/IVA, exclusiones, aviso de PPD, parametros (601), calcular/guardar,
// presentar con confirmacion, registro de REP, base sin migrar y acciones ocultas por rol.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagosProvisionalesPage } from "../src/verticals/despachos/pages/PagosProvisionales.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });

function papel(parcial: Record<string, unknown> = {}) {
  return {
    ejercicio: 2026,
    mes: 7,
    cliente: { rfc: "CLI010101CL1", razonSocial: "Cliente SA de CV", regimenes: ["601"] },
    regimen: "601",
    parametros: { coeficienteUtilidad: "0.2" },
    guardados: [],
    guardadoDisponible: true,
    papel: {
      ejercicio: 2026,
      mes: 7,
      regimen: "601",
      isr: {
        impuesto: "ISR",
        estado: "calculado",
        motivo: null,
        lineas: [
          { clave: "ingresos", concepto: "Ingresos nominales acumulados (cobrados, sin IVA)", centavos: 10_000_000 },
          { clave: "isr", concepto: "ISR determinado (30%)", centavos: 600_000 },
        ],
        baseCentavos: 2_000_000,
        determinadoCentavos: 600_000,
        acreditableCentavos: 200_000,
        aCargoCentavos: 400_000,
        aFavorCentavos: 0,
      },
      iva: { impuesto: "IVA", estado: "calculado", motivo: null, lineas: [{ clave: "trasladado", concepto: "IVA trasladado efectivamente cobrado", centavos: 640_000 }], baseCentavos: 640_000, determinadoCentavos: 640_000, acreditableCentavos: 320_000, aCargoCentavos: 320_000, aFavorCentavos: 0 },
      documentosIncluidos: 3,
      exclusiones: [{ motivo: "Pago en efectivo mayor a $2,000.00 (LISR 27-III y LIVA 5-I)", cantidad: 1, importeCentavos: 1_160_000 }],
      pendientesPpd: { cantidad: 1, importeCentavos: 5_800_000 },
      advertencias: ["1 CFDI PPD del periodo no tienen complemento de pago registrado: no cuentan como flujo de efectivo hasta que lo registres."],
    },
    ...parcial,
  };
}

interface Llamada {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}
let llamadas: Llamada[];
let rendered: RenderedComponent | undefined;

function stubFetch(respuestaGet: unknown = papel(), escritura: (url: string, method: string) => Response = () => new Response(JSON.stringify(papel({ guardado: { isr: true, iva: true } })), { status: 200 })) {
  llamadas = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      llamadas.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.includes("/exportar")) return new Response(new Blob(["%PDF-1.7"]), { status: 200, headers: { "content-disposition": 'attachment; filename="pagos-provisionales-2026-07.pdf"' } });
      if (method === "GET") return new Response(JSON.stringify(respuestaGet), { status: 200 });
      return escritura(url, method);
    }),
  );
}

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
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
      <PagosProvisionalesPage {...CTX(role)} />
    </MemoryRouter>,
  );
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
  return r;
}
const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const drenar = async () => {
  for (let i = 0; i < 5; i++) await act(async () => flushMicrotasks());
};
/** Espera real (macrotareas) hasta que la condicion se cumpla: la lectura de un Blob no se resuelve solo con microtareas. */
const esperar = async (condicion: () => boolean, intentos = 100) => {
  for (let i = 0; i < intentos && !condicion(); i++) await act(async () => new Promise<void>((r) => setTimeout(r, 5)));
};

describe("PagosProvisionalesPage", () => {
  it("muestra el papel: cliente, ISR a cargo, IVA a cargo, lineas, exclusiones con motivo y el aviso de PPD pendientes", async () => {
    stubFetch();
    rendered = await montar("contador");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Pagos provisionales");
    expect(texto).toContain("CLI010101CL1");
    expect(texto).toContain("A cargo $4,000.00");
    expect(texto).toContain("A cargo $3,200.00");
    expect(texto).toContain("Ingresos nominales acumulados");
    expect(texto).toContain("$100,000.00");
    expect(texto).toContain("Pago en efectivo mayor a $2,000.00");
    expect(texto).toContain("no tienen complemento de pago registrado");
    expect(llamadas[0]!.url).toMatch(/\/despachos\/p1\/pagos-provisionales\/\d{4}-\d{2}$/);
  });

  it("601 pide el coeficiente de utilidad; Calcular manda los parametros en centavos y NO guarda", async () => {
    stubFetch();
    rendered = await montar("contador");
    changeValue(document.getElementById("pp-coef") as HTMLInputElement, "0.3");
    changeValue(document.getElementById("pp-perdidas") as HTMLInputElement, "1,000.50");
    click(boton("Calcular")!);
    await drenar();
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toMatch(/\/pagos-provisionales\/\d{4}-\d{2}\/calcular$/);
    expect(post.body).toEqual({ regimen: "601", coeficienteUtilidad: "0.3", perdidasPendientesCentavos: 100050 });
    expect(llamadas.some((l) => l.method === "PUT")).toBe(false);
  });

  it("un coeficiente invalido bloquea Calcular y Guardar (nada se envia)", async () => {
    stubFetch();
    rendered = await montar("contador");
    changeValue(document.getElementById("pp-coef") as HTMLInputElement, "0.2345678");
    expect(rendered.container.textContent).toContain("hasta 6 decimales");
    expect(boton("Calcular")!.disabled).toBe(true);
    expect(boton("Guardar borrador")!.disabled).toBe(true);
  });

  it("sin coeficiente el ISR dice 'faltan datos' (no inventa un monto)", async () => {
    const r = papel({ parametros: {} });
    (r.papel as { isr: unknown }).isr = { impuesto: "ISR", estado: "faltan_parametros", motivo: "Captura el coeficiente de utilidad del contribuyente (art. 14 LISR)", lineas: [], baseCentavos: 0, determinadoCentavos: 0, acreditableCentavos: 0, aCargoCentavos: 0, aFavorCentavos: 0 };
    stubFetch(r);
    rendered = await montar("contador");
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Faltan datos");
    expect(texto).toContain("Captura el coeficiente de utilidad");
  });

  it("guardar borrador: PUT con los parametros y aviso", async () => {
    stubFetch();
    rendered = await montar("admin");
    click(boton("Guardar borrador")!);
    await drenar();
    expect(llamadas.find((l) => l.method === "PUT")!.body).toEqual({ regimen: "601", coeficienteUtilidad: "0.2" });
    expect(rendered.container.textContent).toContain("Borrador de ISR e IVA guardado.");
  });

  it("presentar: exige la confirmacion exacta; luego POST con centavos, fecha y confirmacion", async () => {
    stubFetch(papel({ guardados: [{ id: "g1", mes: 7, impuesto: "ISR", estado: "borrador", aCargoCentavos: 400_000, aFavorCentavos: 0, montoPagadoCentavos: null, fechaPresentacion: null, updatedAt: "2026-08-01" }] }));
    rendered = await montar("contador");
    click(boton("Marcar ISR presentado")!);
    expect(dialogo()!.textContent).toContain("Marcar ISR de");
    changeValue(document.getElementById("pres-monto") as HTMLInputElement, "4,000.00");
    changeValue(document.getElementById("pres-confirmacion") as HTMLInputElement, "ISR 2000-01");
    await submitForm(document.getElementById("form-presentar") as HTMLFormElement);
    expect(llamadas.some((l) => l.method === "POST")).toBe(false);
    expect(dialogo()!.textContent).toContain("para confirmar");
    const periodo = (document.getElementById("pp-periodo") as HTMLInputElement).value;
    changeValue(document.getElementById("pres-confirmacion") as HTMLInputElement, `ISR ${periodo}`);
    await submitForm(document.getElementById("form-presentar") as HTMLFormElement);
    await drenar();
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toMatch(/\/presentar$/);
    expect(post.body).toMatchObject({ impuesto: "ISR", montoPagadoCentavos: 400000, confirmacion: `ISR ${periodo}` });
  });

  it("un papel presentado se muestra como tal y ya no ofrece presentar", async () => {
    stubFetch(papel({ guardados: [{ id: "g1", mes: 7, impuesto: "ISR", estado: "presentado", aCargoCentavos: 400_000, aFavorCentavos: 0, montoPagadoCentavos: 400_000, fechaPresentacion: "2026-08-14", updatedAt: "2026-08-14" }] }));
    rendered = await montar("contador");
    expect(rendered.container.textContent).toContain("ISR presentado el");
    expect(boton("Marcar ISR presentado")).toBeUndefined();
    expect(boton("Marcar IVA presentado")).toBeUndefined(); // sin borrador de IVA guardado: no hay nada que presentar
  });

  it("registrar REP: manda el XML y muestra el resumen con los omitidos y su motivo", async () => {
    stubFetch(papel(), () => new Response(JSON.stringify({ folioFiscalRep: "99999999-9999-9999-9999-999999999999", flujo: "trasladado", registrados: 1, yaExistian: 0, omitidos: [{ idDocumento: "bbbbbbbb-bbbb", motivo: "El CFDI pagado no está en este cliente: súbelo antes de registrar el pago." }], rechazados: [], advertencias: [] }), { status: 201 }));
    rendered = await montar("contador");
    const input = document.getElementById("pp-rep-archivo") as HTMLInputElement;
    const archivo = new File(["<cfdi:Comprobante/>"], "rep.xml", { type: "text/xml" });
    Object.defineProperty(archivo, "text", { value: async () => "<cfdi:Comprobante/>" });
    Object.defineProperty(input, "files", { value: [archivo], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    await drenar();
    click(boton("Registrar pagos")!);
    await drenar();
    const post = llamadas.find((l) => l.method === "POST")!;
    expect(post.url).toMatch(/\/pagos-provisionales\/rep$/);
    expect(post.body).toEqual({ xml: "<cfdi:Comprobante/>" });
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("1 pago(s) registrado(s)");
    expect(texto).toContain("no está en este cliente");
  });

  it("exportar PDF/Excel descarga el archivo real del servidor", async () => {
    stubFetch();
    rendered = await montar("auditor");
    click(boton("PDF")!);
    await esperar(() => (URL.createObjectURL as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);
    expect(llamadas.some((l) => l.url.includes("/exportar?formato=pdf&regimen=601"))).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("auditor/readonly: calculan y exportan pero no guardan, presentan ni registran REP", async () => {
    stubFetch(papel({ guardados: [{ id: "g1", mes: 7, impuesto: "ISR", estado: "borrador", aCargoCentavos: 400_000, aFavorCentavos: 0, montoPagadoCentavos: null, fechaPresentacion: null, updatedAt: "x" }] }));
    rendered = await montar("readonly");
    expect(boton("Calcular")).toBeDefined();
    expect(boton("Guardar borrador")).toBeUndefined();
    expect(boton("Marcar ISR presentado")).toBeUndefined();
    expect(rendered.container.textContent).not.toContain("Registrar complemento de pago");
  });

  it("base sin la migracion 020: aviso honesto y sin guardar ni REP", async () => {
    stubFetch(papel({ guardadoDisponible: false }));
    rendered = await montar("admin");
    expect(rendered.container.textContent).toContain("falta la migración 020");
    expect(boton("Guardar borrador")).toBeUndefined();
    expect(boton("Registrar pagos")!.disabled).toBe(true);
  });

  it("error del servidor (503 sin la 018) con reintento", async () => {
    llamadas = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "service_unavailable", message: "falta aplicar la migración 018" }), { status: 503 })));
    rendered = await montar("admin");
    expect(rendered.container.textContent).toContain("falta aplicar la migración 018");
  });
});

// @vitest-environment jsdom
//
// D-P3-02/03/08/09 -- pantalla de nómina: periodicidad y fecha de pago, antigüedad/SBC/prima RT/prestaciones por empleado, desglose
// de subsidio e IMSS por rama, error del servidor visible y los datos nuevos del XML (registro patronal, NSS). La respuesta del
// servidor la produce el motor real (procesarNomina), no un fixture escrito a mano.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { procesarNomina } from "@atiende/domain-despachos";
import { NominaPage } from "../src/verticals/despachos/pages/Nomina.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role: "contador", staffFullName: "Staff", staffEmail: "s@example.com" };

let rendered: RenderedComponent | undefined;
let cuerpos: Array<{ url: string; body: Record<string, unknown> }>;

function stubFetch(responder: (url: string, body: Record<string, unknown>) => Response) {
  cuerpos = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      cuerpos.push({ url, body });
      return responder(url, body);
    }),
  );
}

const real = (body: Record<string, unknown>) =>
  procesarNomina(body["period"] as never, body["employees"] as never, null, "p1");

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

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const formDeCalculo = () => el("nomina-mes").closest("form") as HTMLFormElement;

function capturarEmpleado() {
  const key = (document.querySelector('[id^="nomina-bruto-"]') as HTMLElement).id.replace("nomina-bruto-", "");
  changeValue(el("nomina-mes"), "2");
  changeValue(el("nomina-anio"), "2026");
  changeValue(el(`nomina-bruto-${key}`), "9000");
  changeValue(el(`nomina-nombre-${key}`), "Ana");
  return key;
}

describe("NominaPage -- paridad3", () => {
  it("manda periodicidad, fecha de pago, antigüedad, prima RT en fracción y conceptos; nunca tenantId; muestra subsidio e IMSS por rama", async () => {
    stubFetch((_u, body) => new Response(JSON.stringify(real(body)), { status: 200 }));
    rendered = renderComponent(<NominaPage {...CTX} />);
    const key = capturarEmpleado();
    changeValue(el("nomina-fecha-pago"), "2026-02-15");
    changeValue(el(`nomina-antig-${key}`), "5");
    changeValue(el(`nomina-rt-${key}`), "1");
    changeValue(el(`nomina-aguinaldo-${key}`), "1000");
    await submitForm(formDeCalculo());

    const llamada = cuerpos[0]!;
    expect(llamada.url).toBe("https://api.test/despachos/p1/nomina/calcular");
    expect(llamada.body).not.toHaveProperty("tenantId");
    expect(llamada.body["period"]).toMatchObject({ month: 2, year: 2026, periodicidad: "mensual", fechaPago: "2026-02-15" });
    const emp = (llamada.body["employees"] as Array<Record<string, unknown>>)[0]!;
    expect(emp).toMatchObject({ salarioBruto: 9000, antiguedadAnios: 5, primaRt: 0.01, conceptos: { aguinaldo: 1000 } });

    const texto = document.body.textContent ?? "";
    expect(texto).toContain("Subsidio causado");
    expect(texto).toContain("Fecha de pago: 2026-02-15");
    expect(texto).toContain("IMSS por rama --");
    expect(texto).toContain("Cesantía y vejez");
    expect(texto).toContain("INFONAVIT (aportación patronal)");
    expect(document.body.textContent).toContain("pendientes de validación del fiscalista");
  });

  it("al elegir quincenal los días pasan a 15 y se envía la periodicidad", async () => {
    stubFetch((_u, body) => new Response(JSON.stringify(real(body)), { status: 200 }));
    rendered = renderComponent(<NominaPage {...CTX} />);
    capturarEmpleado();
    changeValue(el("nomina-periodicidad"), "quincenal");
    expect(el("nomina-dias").value).toBe("15");
    await submitForm(formDeCalculo());
    expect(cuerpos[0]!.body["period"]).toMatchObject({ periodicidad: "quincenal", diasPagados: 15 });
    expect(document.body.textContent).toContain("Subsidio causado");
  });

  it("muestra el error del servidor (vigencia sin cargar) en vez de un resultado", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "No hay UMA cargado para la fecha 2025-12-31 (el motor cubre desde 2026-01-01)." }), { status: 400 }));
    rendered = renderComponent(<NominaPage {...CTX} />);
    capturarEmpleado();
    await submitForm(formDeCalculo());
    const alerta = document.body.querySelector('p[role="alert"]');
    expect(alerta?.textContent).toContain("No hay UMA cargado");
    expect(document.body.textContent).not.toContain("IMSS por rama --");
  });

  it("quincenal de punta a punta: el sueldo capturado es el de la quincena y el XML manda las fechas del periodo", async () => {
    stubFetch((url, body) => {
      if (url.endsWith("/calcular")) return new Response(JSON.stringify(real(body)), { status: 200 });
      return new Response(JSON.stringify({ idempotencyKey: "k", comprobantes: [{ employeeId: "", folio: "F1", xml: "<xml/>" }] }), { status: 200 });
    });
    rendered = renderComponent(<NominaPage {...CTX} />);
    const key = capturarEmpleado();
    changeValue(el("nomina-periodicidad"), "quincenal");
    changeValue(el("nomina-fecha-pago"), "2026-02-15");
    changeValue(el("nomina-fecha-inicial"), "2026-02-01");
    changeValue(el("nomina-fecha-final"), "2026-02-15");
    changeValue(el(`nomina-bruto-${key}`), "4500");
    await submitForm(formDeCalculo());
    const calc = cuerpos[0]!.body;
    expect(calc["period"]).toMatchObject({ periodicidad: "quincenal", diasPagados: 15, fechaPago: "2026-02-15" });
    expect((calc["employees"] as Array<Record<string, unknown>>)[0]).toMatchObject({ salarioBruto: 4500 });
    // Cifras reales del motor: una quincena de 4,500 no puede arrojar un neto cercano a un mes completo.
    const e = real(calc).employees[0];
    expect(e.diasPagados).toBe(15);
    expect(e.neto).toBeLessThanOrEqual(4500);
    expect(e.neto).toBeGreaterThan(3900);

    changeValue(el("emisor-rfc"), "DESP010101AB1");
    changeValue(el("emisor-nombre"), "DESPACHO SA");
    changeValue(el("emisor-regimen"), "601");
    changeValue(el("emisor-lugar"), "06600");
    for (const [id, v] of [["xml-rfc", "PEAA850101ABC"], ["xml-cp", "01000"], ["xml-folio", "F1"], ["xml-curp", "PEAA850101HDFRRN08"], ["xml-num", "E1"], ["xml-contrato", "01"], ["xml-regimen", "02"], ["xml-periodicidad", "04"], ["xml-entfed", "CMX"]] as const) {
      changeValue(el(`${id}-${key}`), v);
    }
    await submitForm(el("emisor-rfc").closest("form") as HTMLFormElement);
    const xml = cuerpos.find((c) => c.url.endsWith("/generar-xml"))!;
    expect(xml.body["period"]).toMatchObject({ periodicidad: "quincenal", diasPagados: 15, fechaPago: "2026-02-15", fechaInicialPago: "2026-02-01", fechaFinalPago: "2026-02-15" });
    expect((xml.body["employees"] as Array<Record<string, unknown>>)[0]).toMatchObject({ salarioBruto: 4500 });
  });

  it("el XML manda registro patronal del emisor y NSS/riesgo de puesto del empleado, con las mismas cifras de prestaciones", async () => {
    stubFetch((url, body) => {
      if (url.endsWith("/calcular")) return new Response(JSON.stringify(real(body)), { status: 200 });
      return new Response(JSON.stringify({ idempotencyKey: "k", comprobantes: [{ employeeId: "", folio: "F1", xml: "<xml/>" }] }), { status: 200 });
    });
    rendered = renderComponent(<NominaPage {...CTX} />);
    const key = capturarEmpleado();
    await submitForm(formDeCalculo());
    changeValue(el("emisor-rfc"), "DESP010101AB1");
    changeValue(el("emisor-nombre"), "DESPACHO SA");
    changeValue(el("emisor-regimen"), "601");
    changeValue(el("emisor-lugar"), "06600");
    changeValue(el("emisor-registro-patronal"), "A1234567891");
    for (const [id, v] of [["xml-rfc", "PEAA850101ABC"], ["xml-cp", "01000"], ["xml-folio", "F1"], ["xml-curp", "peaa850101hdfrrn08"], ["xml-num", "E1"], ["xml-contrato", "01"], ["xml-regimen", "02"], ["xml-periodicidad", "05"], ["xml-entfed", "cmx"], ["xml-nss", "12345678901"], ["xml-riesgo", "1"]] as const) {
      changeValue(el(`${id}-${key}`), v);
    }
    await submitForm(el("emisor-rfc").closest("form") as HTMLFormElement);
    const xml = cuerpos.find((c) => c.url.endsWith("/generar-xml"))!;
    expect(xml.body).not.toHaveProperty("tenantId");
    expect((xml.body["emisor"] as Record<string, unknown>)["registroPatronal"]).toBe("A1234567891");
    expect((xml.body["employees"] as Array<Record<string, unknown>>)[0]).toMatchObject({ numSeguridadSocial: "12345678901", riesgoPuesto: "1", curp: "PEAA850101HDFRRN08", claveEntFed: "CMX", salarioBruto: 9000 });
    expect(document.body.textContent).toContain("Folio F1");
  });
});

// @vitest-environment jsdom
//
// Smoke tests reales de <CfdiPage /> (CFDI de UN folio — timbrar hospedaje,
// timbrar complemento de pago, cancelar; dinero/cumplimiento fiscal real).
// Mismo patrón que hoteles-folio-page.spec.tsx / hoteles-cfdi-listado-page.spec.tsx:
// `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/cfdi.ts + folios.ts, estados de carga/
// error, datos reales, y las interacciones principales (timbrar hospedaje,
// timbrar complemento de pago, cancelar) verificando método/ruta/cuerpo exactos.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CfdiPage } from "../src/verticals/hoteles/pages/Cfdi.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { CfdiEmisionSummary } from "../src/verticals/hoteles/lib/cfdi-client.ts";
import type { FolioSummary } from "../src/verticals/hoteles/lib/folios-client.ts";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

const FOLIO_SIN_CFDI: FolioSummary = {
  id: "folio-1",
  estado: "abierto",
  reservationId: "res-1",
  etiqueta: "Hab. 101",
  esPrincipal: true,
  cerradoEn: null,
  motivoCierre: null,
  cargos: [{ id: "ch-1", concepto: "hospedaje", descripcion: "2 noches", monto: 2000, impuesto: 320, revertidoPor: null, reversaDe: null, transferidoDe: null, creadoEn: "2026-09-18T10:00:00.000Z" }],
  pagos: [],
  saldo: 2320,
};

const CFDI_HOSPEDAJE_PPD: CfdiEmisionSummary = {
  id: "cfdi-1",
  folioId: "folio-1",
  tipo: "hospedaje",
  uuidFiscal: "AAAA1111-BBBB-2222-CCCC-333344445555",
  estado: "timbrado",
  pac: "finkok",
  subtotal: 2000,
  iva: 320,
  impuestosLocales: { ishTasa: 0, ishMonto: 0, dsaMonto: 0 },
  total: 2320,
  rfcReceptor: "XAXX010101000",
  usoCfdi: "S01",
  metodoPago: "PPD",
  esExtranjero: false,
  esGlobal: false,
  esNoShow: false,
  relacionadoCfdiId: null,
  creadoEn: "2026-09-18T10:00:00.000Z",
  canceladoEn: null,
};

interface Handlers {
  folio?: FolioSummary | (() => FolioSummary);
  cfdis?: readonly CfdiEmisionSummary[] | (() => readonly CfdiEmisionSummary[]);
  folioOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && /\/folios\/folio-1$/.test(url)) {
      const folio = typeof handlers.folio === "function" ? handlers.folio() : (handlers.folio ?? FOLIO_SIN_CFDI);
      return jsonResponse(folio, handlers.folioOk ?? true);
    }
    if (method === "GET" && /\/folios\/folio-1\/cfdi$/.test(url)) {
      const cfdis = typeof handlers.cfdis === "function" ? handlers.cfdis() : (handlers.cfdis ?? []);
      return jsonResponse(cfdis, handlers.folioOk ?? true);
    }
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/folios/folio-1/cfdi") {
      return jsonResponse({ ...CFDI_HOSPEDAJE_PPD, metodoPago: "PUE" }, true);
    }
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/folios/folio-1/cfdi/pago") {
      return jsonResponse({ id: "cfdi-pago-1", folioId: "folio-1", tipo: "pago", estado: "timbrado" });
    }
    if (method === "POST" && /\/cfdi\/cfdi-1\/cancelar$/.test(url)) {
      return jsonResponse({ id: "cfdi-1", estado: "cancelado" });
    }
    if (method === "POST" && /\/cfdi\/cfdi-1\/consultar-estado$/.test(url)) {
      return jsonResponse({ ...CFDI_HOSPEDAJE_PPD, estado: "en_proceso_cancelacion", estadoReal: "en_proceso_cancelacion" });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <CfdiPage {...CTX} folioId="folio-1" />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CfdiPage (hoteles)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando CFDI del folio");
  });

  it("estado de error real cuando falla la carga — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ folioOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando CFDI del folio");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("estado vacío honesto (sin CFDI) y muestra el formulario para timbrar hospedaje", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Este folio todavía no tiene ningún CFDI timbrado.");
    expect(text).toContain("Timbrar CFDI de hospedaje");
    expect(text).toContain("Hab. 101");
    expect(text).toContain("$2,320.00");
  });

  it("timbrar hospedaje: valida RFC/uso requeridos cuando no es extranjero/global y NUNCA llama a la API", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const callsAntes = fetchMock.mock.calls.length;

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Timbrar CFDI de hospedaje"))!;
    await submitForm(form);

    expect(rendered.container.textContent).toContain("RFC receptor y uso de CFDI son obligatorios");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("timbrar hospedaje real: POST .../folios/folio-1/cfdi con RFC/uso/metodoPago exactos, header idempotency-key, y recarga (formulario desaparece)", async () => {
    let cfdisActuales: readonly CfdiEmisionSummary[] = [];
    stubFetch({ cfdis: () => cfdisActuales });
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    changeValue(root.querySelector('input[placeholder="RFC receptor"]') as HTMLInputElement, "xaxx010101000");
    changeValue(root.querySelector('input[placeholder="Uso de CFDI (p. ej. G03)"]') as HTMLInputElement, "g03");
    cfdisActuales = [{ ...CFDI_HOSPEDAJE_PPD, metodoPago: "PUE", rfcReceptor: "XAXX010101000", usoCfdi: "G03" }];

    const form = [...root.querySelectorAll("form")].find((f) => f.textContent?.includes("Timbrar CFDI de hospedaje"))!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/folios/folio-1/cfdi" && init?.method === "POST");
    expect(call).toBeDefined();
    const [, init] = call!;
    // Los inputs suben en mayúsculas (onChange hace toUpperCase) — verifica el
    // cuerpo real enviado, no una copia idealizada.
    expect(JSON.parse(init.body as string)).toEqual({
      rfcReceptor: "XAXX010101000",
      usoCfdi: "G03",
      metodoPago: "PUE",
      esExtranjero: false,
      esGlobal: false,
      esNoShow: false,
    });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    // El formulario de timbrado desaparece porque ya hay un CFDI de hospedaje vigente.
    expect(root.textContent).not.toContain("Timbrar CFDI de hospedaje");
    expect(root.textContent).toContain("Hospedaje");
  });

  it("huésped extranjero: oculta RFC/uso y manda esExtranjero:true sin rfcReceptor/usoCfdi", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const root = rendered.container;
    const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const extranjeroCheckbox = checkboxes.find((c) => c.closest("label")?.textContent?.includes("extranjero"))!;
    await act(async () => {
      extranjeroCheckbox.click();
    });

    expect(root.querySelector('input[placeholder="RFC receptor"]')).toBeNull();

    const form = [...root.querySelectorAll("form")].find((f) => f.textContent?.includes("Timbrar CFDI de hospedaje"))!;
    await submitForm(form);

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/folios/folio-1/cfdi" && init?.method === "POST");
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.esExtranjero).toBe(true);
    expect(body.rfcReceptor).toBeUndefined();
    expect(body.usoCfdi).toBeUndefined();
  });

  it("timbrar complemento de pago: solo aparece con hospedaje PPD ya timbrado y pago capturado; POST .../cfdi/pago con paymentId/relacionadoCfdiId reales", async () => {
    const folioConPago: FolioSummary = { ...FOLIO_SIN_CFDI, pagos: [{ id: "pay-1", monto: 2320, metodo: "transferencia", estado: "capturado", referenciaExterna: "REF-001", creadoEn: "2026-09-18T12:00:00.000Z" }] };
    stubFetch({ folio: folioConPago, cfdis: [CFDI_HOSPEDAJE_PPD] });
    rendered = renderPage();
    await esperarCarga();

    const text = rendered.container.textContent!;
    expect(text).toContain("Complementos de pago");
    expect(text).toContain("transferencia");
    expect(text).toContain("REF-001");

    const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Timbrar complemento de pago")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/folios/folio-1/cfdi/pago" && init?.method === "POST");
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(init.body as string)).toEqual({ paymentId: "pay-1", relacionadoCfdiId: "cfdi-1" });
  });

  it("complemento de pago NO aparece cuando el hospedaje es PUE (nada que diferir)", async () => {
    const folioConPago: FolioSummary = { ...FOLIO_SIN_CFDI, pagos: [{ id: "pay-1", monto: 2320, metodo: "efectivo", estado: "capturado", referenciaExterna: null, creadoEn: "2026-09-18T12:00:00.000Z" }] };
    stubFetch({ folio: folioConPago, cfdis: [{ ...CFDI_HOSPEDAJE_PPD, metodoPago: "PUE" }] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Complementos de pago");
  });

  it("cancelar CFDI de hospedaje timbrado: POST .../cfdi/cfdi-1/cancelar con motivo real", async () => {
    let cfdisActuales: readonly CfdiEmisionSummary[] = [CFDI_HOSPEDAJE_PPD];
    stubFetch({ cfdis: () => cfdisActuales });
    rendered = renderPage();
    await esperarCarga();

    const cancelBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar CFDI")!;
    await act(async () => {
      cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    cfdisActuales = [{ ...CFDI_HOSPEDAJE_PPD, estado: "cancelado" }];
    const confirmForm = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Confirmar cancelación"))!;
    await submitForm(confirmForm);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/cfdi/cfdi-1/cancelar" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ motivo: "02" });
    // Tras cancelar, el hospedaje ya no cuenta como "vigente": el formulario de
    // timbrado reaparece para poder reemitir (misma regla que el servidor).
    expect(rendered.container.textContent).toContain("Timbrar CFDI de hospedaje");
  });

  it("CFDI en proceso de cancelación: botón 'Consultar estado real ante el PAC' llama POST .../consultar-estado", async () => {
    stubFetch({ cfdis: [{ ...CFDI_HOSPEDAJE_PPD, estado: "en_proceso_cancelacion" }] });
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Cancelación en proceso");
    const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Consultar estado real ante el PAC")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/cfdi/cfdi-1/consultar-estado" && init?.method === "POST");
    expect(call).toBeDefined();
  });
});

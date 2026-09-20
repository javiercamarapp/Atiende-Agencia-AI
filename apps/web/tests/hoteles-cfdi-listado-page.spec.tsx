// @vitest-environment jsdom
//
// Smoke tests reales de <CfdiListadoPage /> (listado de CFDI de hospedaje a nivel
// property, dinero/cumplimiento fiscal real) — mismo patrón que
// hoteles-folio-page.spec.tsx: `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/cfdi.ts (`serializeCfdi`), estados de
// carga/vacío/error, datos reales (subtotal/iva/total/estado), y las dos
// interacciones principales: saltar a un folio (navegación) y cancelar un CFDI
// timbrado (POST .../cfdi/:cfdiId/cancelar con motivo/folioSustitucion reales).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { CfdiListadoPage } from "../src/verticals/hoteles/pages/CfdiListado.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { CfdiEmisionSummary } from "../src/verticals/hoteles/lib/cfdi-client.ts";
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

const CFDI_TIMBRADO: CfdiEmisionSummary = {
  id: "cfdi-1",
  folioId: "folio-1",
  tipo: "hospedaje",
  uuidFiscal: "AAAA1111-BBBB-2222-CCCC-333344445555",
  estado: "timbrado",
  pac: "finkok",
  subtotal: 2000,
  iva: 320,
  impuestosLocales: { ishTasa: 0.03, ishMonto: 60, dsaMonto: 0 },
  total: 2380,
  rfcReceptor: "XAXX010101000",
  usoCfdi: "S01",
  metodoPago: "PUE",
  esExtranjero: false,
  esGlobal: false,
  esNoShow: false,
  relacionadoCfdiId: null,
  creadoEn: "2026-09-18T10:00:00.000Z",
  canceladoEn: null,
};

interface Handlers {
  cfdis?: readonly CfdiEmisionSummary[] | (() => readonly CfdiEmisionSummary[]);
  listOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/hoteles/prop-1/cfdi") {
      const cfdis = typeof handlers.cfdis === "function" ? handlers.cfdis() : (handlers.cfdis ?? [CFDI_TIMBRADO]);
      return jsonResponse(cfdis, handlers.listOk ?? true);
    }
    if (method === "POST" && /\/cfdi\/cfdi-1\/cancelar$/.test(url)) {
      return jsonResponse({ id: "cfdi-1", estado: "cancelado" });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function DestinoFolioCfdi() {
  const loc = useLocation();
  return <div>Página de CFDI del folio {loc.pathname}</div>;
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={["/hoteles/demo/cfdi"]}>
      <Routes>
        <Route path="/hoteles/:orgSlug/cfdi" element={<CfdiListadoPage {...CTX} />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId/cfdi" element={<DestinoFolioCfdi />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CfdiListadoPage (hoteles)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando CFDI");
  });

  it("estado vacío honesto cuando el hotel no tiene ningún CFDI", async () => {
    stubFetch({ cfdis: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando CFDI");
    expect(rendered.container.textContent).toContain("Este hotel todavía no tiene ningún CFDI timbrado.");
  });

  it("estado de error real cuando falla el listado — nunca se queda atorado en 'Cargando' ni inventa datos", async () => {
    stubFetch({ listOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando CFDI");
    expect(rendered.container.textContent).toContain("Ocurrió un problema");
    expect(rendered.container.textContent).not.toContain("Subtotal");
  });

  it("reintentar tras un error vuelve a pedir el listado", async () => {
    let ok = false;
    fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.test/hoteles/prop-1/cfdi") return jsonResponse([CFDI_TIMBRADO], ok);
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Ocurrió un problema");

    ok = true;
    const retryBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar") || b.textContent?.includes("reintentar"));
    expect(retryBtn).toBeDefined();
    await act(async () => {
      retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(rendered.container.textContent).toContain("$2,380.00");
  });

  it("renderiza el CFDI real: tipo, RFC receptor, subtotal/IVA/ISH/total y estado", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Hospedaje");
    expect(text).toContain("AAAA1111-BBBB-2222-CCCC-333344445555");
    expect(text).toContain("RFC XAXX010101000");
    expect(text).toContain("Subtotal $2,000.00");
    expect(text).toContain("IVA $320.00");
    expect(text).toContain("ISH $60.00");
    expect(text).toContain("$2,380.00");
    expect(text).toContain("Timbrado");
  });

  it("saltar a un folio navega a la página de CFDI de ese folio", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const input = rendered.container.querySelector('input[placeholder="ID del folio"]') as HTMLInputElement;
    changeValue(input, "folio-99");
    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Ir al folio"))!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });

    expect(rendered.container.textContent).toContain("/hoteles/demo/folios/folio-99/cfdi");
  });

  it("cancelar CFDI timbrado: motivo '02' llama POST .../cancelar con ese motivo real y recarga el listado", async () => {
    let current = [CFDI_TIMBRADO];
    stubFetch({ cfdis: () => current });
    rendered = renderPage();
    await esperarCarga();

    const cancelBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar CFDI")!;
    await act(async () => {
      cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(rendered.container.textContent).toContain("Confirmar cancelación");

    current = [{ ...CFDI_TIMBRADO, estado: "cancelado", canceladoEn: "2026-09-19T00:00:00.000Z" }];
    const confirmForm = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Confirmar cancelación"))!;
    await submitForm(confirmForm);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/cfdi/cfdi-1/cancelar" && init?.method === "POST");
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(init.body as string)).toEqual({ motivo: "02" });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(rendered.container.textContent).toContain("Cancelado");
  });

  it("cancelar con motivo '01' (sustitución) manda folioSustitucion cuando se captura", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const cancelBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar CFDI")!;
    await act(async () => {
      cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const select = rendered.container.querySelector("select") as HTMLSelectElement;
    changeValue(select, "01");
    const sustInput = rendered.container.querySelector('input[placeholder*="sustituye"]') as HTMLInputElement;
    expect(sustInput).toBeTruthy();
    changeValue(sustInput, "UUID-SUSTITUTO-0001");

    const confirmForm = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Confirmar cancelación"))!;
    await submitForm(confirmForm);

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/cfdi/cfdi-1/cancelar" && init?.method === "POST");
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(init.body as string)).toEqual({ motivo: "01", folioSustitucion: "UUID-SUSTITUTO-0001" });
  });
});

// @vitest-environment jsdom
//
// D-27: boton "Verificar en el SAT" de la ficha del CFDI. `fetch` global mockeado por ruta real (cfdi.ts + revisiones.ts +
// cfdi-estatus-sat.ts): carga, exito (vigente / cancelado), el SAT que no responde (el estado NO cambia), error del servidor y roles.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const notifyMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@atiende/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@atiende/ui")>()), notify: notifyMock }));

import { CfdiDetallePage } from "../src/verticals/despachos/pages/CfdiDetalle.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contadora", staffEmail: "c@example.com" };
const INVOICE = {
  id: "inv1", folioFiscal: "AAAA1111-BBBB-2222-CCCC-DDDDEEEEFFFF", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB020202BBB", emisorNombre: "Proveedor SA", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
  categoria: "gasto_operativo", valido: true, issues: [], warnings: [], requiereRevisionHumana: false, diot: { proveedoresReportables: [], reportable: false }, creadoEn: "2026-03-01T00:00:00Z", estadoSat: "pendiente", estadoSatVerificadoEn: null,
};

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function stubFetch(verificar: () => Response) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/despachos/prop-1/cfdi/inv1") return json(INVOICE);
    if (method === "GET" && url === "https://api.test/despachos/prop-1/revisiones") return json([]);
    if (method === "POST" && url === "https://api.test/despachos/prop-1/cfdi/inv1/verificar-estatus-sat") return verificar();
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function montar(ctx: DespachosShellContext = CTX) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/cfdi/inv1"]}>
      <Routes>
        <Route path="/cfdi/:invoiceId" element={<CfdiDetallePage {...ctx} />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const boton = () => [...rendered!.container.querySelectorAll("button")].find((b) => /Verificar en el SAT|Consultando al SAT/.test(b.textContent ?? ""));
async function verificar() {
  click(boton()!);
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("CfdiDetallePage -- Verificar en el SAT", () => {
  it("el contador ve el boton; el estado inicial es 'Sin verificar' y el texto no afirma que el sistema no consulta al SAT", async () => {
    stubFetch(() => json({}));
    await montar();
    expect(boton()).toBeDefined();
    expect(rendered!.container.textContent).toContain("Todavía no se ha verificado ante el SAT");
  });

  it("vigente: llama al endpoint real, pinta el estado y la fecha de verificacion y avisa con un toast de exito", async () => {
    const mock = stubFetch(() => json({ consultado: true, estadoSat: "vigente", estadoSatVerificadoEn: "2026-10-02T12:00:00Z", esCancelable: "Cancelable sin aceptación", estatusCancelacion: null }));
    await montar();
    await verificar();
    expect(mock.mock.calls.some(([u, i]) => u === "https://api.test/despachos/prop-1/cfdi/inv1/verificar-estatus-sat" && (i as RequestInit).method === "POST")).toBe(true);
    expect(rendered!.container.textContent).toContain("Estado ante el SATVigente");
    expect(rendered!.container.textContent).toContain("Última verificación");
    expect(notifyMock.success).toHaveBeenCalledWith("El SAT confirma que el CFDI está vigente.");
  });

  it("cancelado: avisa con advertencia y deshabilita el boton (un cancelado ya no cambia)", async () => {
    stubFetch(() => json({ consultado: true, estadoSat: "cancelado", estadoSatVerificadoEn: "2026-10-02T12:00:00Z", esCancelable: "No cancelable", estatusCancelacion: "Cancelado sin aceptación" }));
    await montar();
    await verificar();
    expect(rendered!.container.textContent).toContain("Estado ante el SATCancelado");
    expect(notifyMock.warning).toHaveBeenCalledWith("El SAT reporta este CFDI como cancelado.", { description: "Cancelado sin aceptación" });
    expect(boton()!.disabled).toBe(true);
  });

  it("el SAT no responde: el estado NO cambia (sigue sin verificar) y se avisa con una advertencia, sin error", async () => {
    stubFetch(() => json({ consultado: false, motivo: "timeout", estadoSat: "pendiente", estadoSatVerificadoEn: null, esCancelable: null, estatusCancelacion: null }));
    await montar();
    await verificar();
    expect(rendered!.container.textContent).toContain("Estado ante el SATSin verificar");
    expect(notifyMock.warning).toHaveBeenCalledWith("El SAT no respondió. El estado no cambió; inténtalo de nuevo en unos minutos.");
    expect(notifyMock.success).not.toHaveBeenCalled();
    expect(boton()!.disabled).toBe(false);
  });

  it("error del servidor (429/500): muestra el mensaje real en la tarjeta y un toast de error", async () => {
    stubFetch(() => json({ message: "Demasiadas verificaciones en el SAT. Intenta de nuevo en unos minutos." }, 429));
    await montar();
    await verificar();
    expect(rendered!.container.textContent).toContain("Demasiadas verificaciones en el SAT");
    expect(notifyMock.error).toHaveBeenCalled();
  });

  it("un auditor (solo lectura) no ve el boton", async () => {
    stubFetch(() => json({}));
    await montar({ ...CTX, role: "auditor" });
    expect(boton()).toBeUndefined();
  });
});

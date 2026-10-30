// @vitest-environment jsdom
//
// paridad3 D-P3-19 -- lo que el SAT responde sobre la cancelacion (estatus «En proceso», ¿es cancelable?, validacion EFOS) se ve en el detalle del CFDI y en la
// columna «Cancelación» de la lista; «En proceso» avisa que el receptor tiene 72 horas.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import { CfdiDetallePage } from "../src/verticals/despachos/pages/CfdiDetalle.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contadora", staffEmail: "c@example.com" };
const BASE = {
  id: "inv1", folioFiscal: "AAAA1111-BBBB-2222-CCCC-DDDDEEEEFFFF", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB020202BBB", emisorNombre: "Proveedor SA", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
  categoria: "gasto_operativo", valido: true, issues: [], warnings: [], requiereRevisionHumana: false, diot: { proveedoresReportables: [], reportable: false }, creadoEn: "2026-03-01T00:00:00Z",
  estadoSat: "vigente", estadoSatVerificadoEn: "2026-10-02T12:00:00Z", esCancelable: null, estatusCancelacion: null, codigoEstatus: null, validacionEfos: null,
};
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function stub(invoice: unknown, verificar?: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "https://api.test/despachos/prop-1/cfdi/inv1") return json(invoice);
      if (method === "GET" && url === "https://api.test/despachos/prop-1/revisiones") return json([]);
      if (method === "POST" && url.endsWith("/verificar-estatus-sat") && verificar) return verificar();
      throw new Error(`fetch inesperado: ${method} ${url}`);
    }),
  );
}
async function montar() {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/cfdi/inv1"]}>
      <Routes>
        <Route path="/cfdi/:invoiceId" element={<CfdiDetallePage {...CTX} />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    for (let i = 0; i < 4; i++) await flushMicrotasks();
  });
}
const texto = () => rendered!.container.textContent ?? "";

describe("CfdiDetalle -- detalle de cancelacion del SAT", () => {
  it("cancelacion en proceso: estatus, si es cancelable, validacion EFOS y el aviso de las 72 horas", async () => {
    stub({ ...BASE, esCancelable: "Cancelable con aceptación", estatusCancelacion: "En proceso", validacionEfos: "200" });
    await montar();
    expect(texto()).toContain("Cancelación en proceso");
    expect(texto()).toContain("72 horas");
    expect(texto()).toContain("Cancelable con aceptación");
    expect(texto()).toContain("El emisor no figura en la lista 69-B");
  });

  it("sin dato de cancelacion (nunca consultado o base sin la 027) no pinta el bloque", async () => {
    stub(BASE);
    await montar();
    expect(rendered!.container.querySelector('dl[aria-label="Detalle de cancelación ante el SAT"]')).toBeNull();
  });

  it("la verificacion manual actualiza el detalle en pantalla con lo que respondio el SAT", async () => {
    stub({ ...BASE, estadoSat: "pendiente", estadoSatVerificadoEn: null }, () => json({ consultado: true, estadoSat: "vigente", estadoSatVerificadoEn: "2026-10-07T10:00:00Z", esCancelable: "Cancelable sin aceptación", estatusCancelacion: "En proceso", codigoEstatus: "S - ok", validacionEfos: "100" }));
    await montar();
    expect(texto()).not.toContain("Cancelación en proceso");
    const boton = [...rendered!.container.querySelectorAll("button")].find((b) => /Verificar en el SAT/.test(b.textContent ?? ""))!;
    await act(async () => {
      click(boton);
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("Cancelación en proceso");
    expect(texto()).toContain("Cancelable sin aceptación");
    expect(texto()).toContain("El emisor figura en la lista 69-B");
  });
});

describe("CfdiPage -- columna «Cancelación»", () => {
  const FILA = (id: string, estatus: string | null) => ({ ...BASE, id, folioFiscal: `AAAA-${id}`, estatusCancelacion: estatus });
  async function cargar(filas: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/efos/alertas")) return json({ lista: { estado: "disponible", periodo: "2026-09", filas: 1, ingestadoEn: null }, estado: "disponible", alertas: [] });
        if (url.endsWith("/revisiones")) return json([]);
        if (url.includes("/cfdi")) return json(filas);
        throw new Error(`fetch inesperado: ${url}`);
      }),
    );
    rendered = renderComponent(
      <MemoryRouter>
        <CfdiPage {...CTX} />
      </MemoryRouter>,
    );
    await act(async () => {
      for (let i = 0; i < 4; i++) await flushMicrotasks();
    });
  }

  it("muestra el estatus de cancelacion de cada CFDI y un guion si el SAT no reporta cancelacion", async () => {
    await cargar([FILA("a", "En proceso"), FILA("b", null), FILA("c", "Plazo vencido")]);
    const tabla = rendered!.container.querySelector("table")!;
    expect(tabla.textContent).toContain("Cancelación");
    expect(tabla.textContent).toContain("Cancelación en proceso");
    expect(tabla.textContent).toContain("Plazo vencido");
  });
});

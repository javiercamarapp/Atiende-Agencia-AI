// @vitest-environment jsdom
//
// Smoke tests reales de <ImportarEstadoCuentaPage /> (D-03): vista previa de importación de
// estado de cuenta con errores por renglón, `fetch` global mockeado por ruta real contra
// estado-cuenta-client.ts. Mismo patrón que despachos-cobranza-page.spec.tsx.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportarEstadoCuentaPage } from "../src/verticals/despachos/pages/ImportarEstadoCuenta.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { VistaPreviaImportacion } from "../src/verticals/despachos/lib/estado-cuenta-client.ts";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "Contador Demo", staffEmail: "c@example.com" };

const VISTA: VistaPreviaImportacion = {
  parseo: {
    formato: "csv",
    banco: "bbva",
    bancoDetectado: true,
    cuenta: "012180000123456782",
    moneda: "MXN",
    movimientos: [
      { fecha: "2026-01-05", descripcion: "SPEI RECIBIDO ACME", referencia: "R1", cargo: null, abono: 1160, saldo: 51160, monto: 1160, banco: "bbva", formato: "csv", renglon: 3, hash: "h1", ocurrencia: 1 },
      { fecha: "2026-01-08", descripcion: "PAGO DE NÓMINA", referencia: null, cargo: 3000, abono: null, saldo: 48160, monto: -3000, banco: "bbva", formato: "csv", renglon: 4, hash: "h2", ocurrencia: 1 },
    ],
    errores: [{ renglon: 5, campo: "fecha", codigo: "fecha_invalida", mensaje: 'fecha inexistente en el calendario: "31/02/2026"' }],
    advertencias: [{ renglon: 7, codigo: "posible_duplicado", mensaje: "El renglón 7 repite fecha, importe y concepto del renglón 6." }],
    renglonesLeidos: 3,
    periodo: { desde: "2026-01-05", hasta: "2026-01-08" },
    totalCargos: 3000,
    totalAbonos: 1160,
    saldoFinal: null,
  },
  yaImportados: [],
  nuevos: 2,
  conciliacion: { matched: [], unmatchedBank: [], unmatchedBooks: [], confidence: 100, totalMovements: 2, totalRecords: 1, totalMatched: 1, matchRate: 50, montoMatched: 1160, montoUnmatchedBank: 3000, montoUnmatchedBooks: 0, processingTimeMs: 1 },
  conciliacionOmitida: null,
  coincidencias: [{ hash: "h1", renglon: 3, nivel: "exacto", score: 100, detalle: "ok", registroIds: ["inv-1"], folioFiscal: ["uuid-1"], cobranzaPendienteIds: ["cxc-1"] }],
  cobranzaDisponible: true,
  libroDisponible: true,
};

const VISTA_SIN_ERRORES: VistaPreviaImportacion = { ...VISTA, parseo: { ...VISTA.parseo, errores: [] } };

function renderPage(ctx: DespachosShellContext = CTX): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <ImportarEstadoCuentaPage {...ctx} />
    </MemoryRouter>,
  );
}

async function subirArchivo(contenido: string, nombre: string): Promise<void> {
  const input = rendered!.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const archivo = new File([contenido], nombre, { type: "text/csv" });
  Object.defineProperty(archivo, "arrayBuffer", { value: async () => new TextEncoder().encode(contenido).buffer });
  Object.defineProperty(input, "files", { value: [archivo], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

describe("ImportarEstadoCuentaPage (despachos)", () => {
  it("estado vacío inicial: pide un archivo, no inventa datos", () => {
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Sin archivo todavía");
    expect(rendered.container.textContent).toContain("solo se guarda cuando tú lo confirmas");
  });

  it("sube un CSV, manda banco/cuenta/formato y pinta resumen, errores por renglón, avisos y movimientos con su conciliación", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => VISTA }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    changeValue(rendered.container.querySelector<HTMLSelectElement>("#estado-banco")!, "bbva");
    changeValue(rendered.container.querySelector<HTMLInputElement>("#estado-cuenta")!, "012180000123456782");

    await subirArchivo("Fecha;Concepto\n", "estado-enero.csv");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/despachos/prop-1/conciliacion/importar-estado-de-cuenta");
    expect(JSON.parse(init.body as string)).toEqual({ contenido: "Fecha;Concepto\n", formato: "csv", banco: "bbva", cuenta: "012180000123456782" });

    const texto = rendered.container.textContent!;
    expect(texto).toContain("BBVA México (detectado)");
    expect(texto).toContain("2026-01-05 a 2026-01-08");
    expect(texto).toContain("$3,000.00"); // cargos formateados en pesos, nunca el entero crudo
    expect(texto).toContain("Errores por renglón (1)");
    expect(texto).toContain("31/02/2026");
    expect(texto).toContain("El renglón 7 repite fecha");
    expect(texto).toContain("PAGO DE NÓMINA");
    expect(texto).toContain("CFDI Exacto");
    expect(texto).toContain("Cuenta por cobrar pendiente");
    expect(texto).toContain("Sin conciliar");
    expect(texto).toContain("Conciliados con CFDI: 1 de 2");
  });

  function botonGuardar(): HTMLButtonElement | undefined {
    return [...rendered!.container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Guardar"));
  }

  it("con renglones con error el botón Guardar está deshabilitado (todo o nada)", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => VISTA }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await subirArchivo("Fecha;Concepto\n", "estado.csv");
    expect(botonGuardar()?.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("se guarda todo o nada");
  });

  it("Guardar reenvía el MISMO archivo a /guardar y muestra lo insertado y lo ya existente", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/guardar")) return { ok: true, status: 201, json: async () => ({ loteId: "l1", insertados: 2, yaExistentes: 1, totalMovimientos: 3 }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => VISTA_SIN_ERRORES } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await subirArchivo("Fecha;Concepto\n", "estado.csv");
    const boton = botonGuardar()!;
    expect(boton.disabled).toBe(false);
    expect(boton.textContent).toContain("Guardar 2 movimiento(s) nuevos");
    await act(async () => {
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let i = 0; i < 6; i++) await flushMicrotasks();
    });
    const [urlGuardar, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(urlGuardar).toBe("https://api.test/despachos/prop-1/conciliacion/importar-estado-de-cuenta/guardar");
    expect(JSON.parse(init.body as string)).toEqual({ contenido: "Fecha;Concepto\n", formato: "csv" });
    const texto = rendered.container.textContent!;
    expect(texto).toContain("2 movimiento(s) guardados");
    expect(texto).toContain("1 ya estaban guardados y no se duplicaron");
    expect(botonGuardar()).toBeUndefined();
  });

  it("base sin la migración 013 (libroDisponible=false): avisa y no ofrece Guardar", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...VISTA_SIN_ERRORES, libroDisponible: false }) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await subirArchivo("Fecha;Concepto\n", "estado.csv");
    expect(rendered.container.textContent).toContain("migración 013");
    expect(botonGuardar()).toBeUndefined();
  });

  it("un archivo mayor al tope no se sube (aviso inmediato)", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const grande = new File(["x"], "enorme.csv");
    Object.defineProperty(grande, "size", { value: 2_000_000 });
    Object.defineProperty(input, "files", { value: [grande], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("más de 1.5 MB");
  });

  it("error del servidor: se muestra, nunca se queda en 'Leyendo…'", async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await subirArchivo("a,b\n", "x.csv");
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(rendered.container.textContent).not.toContain("Leyendo…");
  });

  it("roles auditor/readonly no ven la herramienta", () => {
    rendered = renderPage({ ...CTX, role: "readonly" });
    expect(rendered.container.querySelector('input[type="file"]')).toBeNull();
    expect(rendered.container.textContent).toContain("requiere rol admin o contador");
  });
});

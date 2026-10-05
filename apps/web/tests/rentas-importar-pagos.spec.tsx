// @vitest-environment jsdom
//
// Rn-P3-06/07 -- <ImportarPagosSection />: indicador de reservas sin movimiento, cola, movimientos en revision y el dialogo de importacion
// (vista previa -> confirmar). Cancelar o cerrar NUNCA escribe; solo "Confirmar importacion" tras la confirmacion hace POST aplicar:true.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportarPagosSection } from "../src/verticals/rentas/components/ImportarPagos.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const json = (body: unknown, ok = true, status = 200): Response => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const SIN_MOV = { periodo: "2026-10", total: 2, items: [{ ocupacionId: "ocu-1", unidadId: "u-1", inicio: "2026-10-03", fin: "2026-10-05", canalCodigo: "airbnb" }, { ocupacionId: "ocu-2", unidadId: "u-1", inicio: "2026-10-07", fin: "2026-10-09", canalCodigo: null }] };
const COLA = { disponible: true, items: [{ id: "l-1", canalCodigo: "airbnb", codigoConfirmacion: "HMZZ99YY88", tipoLinea: "reserva", moneda: "MXN", montoNetoCentavos: 450000, resultado: "pendiente", nota: "No hay una reserva con ese codigo en esta propiedad", creadaEn: "2026-10-01T00:00:00Z" }] };
const REVISION = { disponible: true, items: [{ ocupacionId: "ocu-9", motivo: "reserva_cancelada", moneda: "MXN", netoCentavos: 90000, origen: "directa_automatica" }] };
const PREVIA = {
  aplicado: false,
  importacionId: null,
  resumen: { totalLineas: 2, creadas: 1, conciliadas: 0, discrepancias: 0, pendientes: 1, yaImportadas: 0, ignoradas: 1, errores: 0 },
  lineas: [
    { fila: 2, tipoLinea: "reserva", codigoConfirmacion: "HMAB12CD34", moneda: "MXN", montoNetoCentavos: 873000, resultado: "creada", nota: null, ocupacionId: "ocu-1" },
    { fila: 3, tipoLinea: "reserva", codigoConfirmacion: "HMZZ99YY88", moneda: "MXN", montoNetoCentavos: 450000, resultado: "pendiente", nota: "No hay una reserva con ese codigo en esta propiedad", ocupacionId: null },
  ],
  errores: [],
};

interface Opciones {
  sinMov?: unknown;
  cola?: unknown;
  revision?: unknown;
  previa?: unknown;
  previaStatus?: number;
}

function red(o: Opciones = {}) {
  const llamadas: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    llamadas.push({ url, method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url.includes("/finanzas/sin-movimiento")) return json(o.sinMov ?? SIN_MOV);
    if (url.endsWith("/finanzas/cola-importacion")) return json(o.cola ?? COLA);
    if (url.endsWith("/finanzas/movimientos-en-revision")) return json(o.revision ?? REVISION);
    if (url.endsWith("/payouts/importar-csv")) {
      const aplicar = JSON.parse(String(init!.body)).aplicar === true;
      if (o.previaStatus && o.previaStatus >= 400) return json({ code: "formato_reporte_no_soportado", message: "El reporte de pagos del canal todavia no esta soportado" }, false, o.previaStatus);
      return json(aplicar ? { ...(o.previa ?? PREVIA), aplicado: true, importacionId: "imp-1" } : (o.previa ?? PREVIA));
    }
    if (url.endsWith("/movimiento/revisado")) return json({ ocupacionId: "ocu-9", requiereRevision: false });
    throw new Error(`url inesperada: ${method} ${url}`);
  });
  return { fn, llamadas, escrituras: () => llamadas.filter((l) => l.method !== "GET") };
}

const montar = (puedeEscribir: boolean) => renderComponent(<ImportarPagosSection apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" puedeEscribir={puedeEscribir} />);
const botones = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const boton = (texto: string) => botones().find((b) => b.textContent?.trim() === texto || b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const dialogoConfirmacion = () => document.body.querySelector('[role="alertdialog"]');
const botonConfirmacion = (texto: string) => [...dialogoConfirmacion()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;

async function elegirArchivo(texto = "Type,Confirmation Code,Currency,Paid out\nReservation,HMAB12CD34,MXN,8730.00\n", tamano?: number) {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
  const archivo = { name: "reporte.csv", size: tamano ?? texto.length, text: async () => texto } as unknown as File;
  await act(async () => {
    Object.defineProperty(input, "files", { value: [archivo], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushMicrotasks();
  });
}

async function abrirYPrevisualizar() {
  click(boton("Importar reporte de pagos (CSV)")!);
  await esperar();
  const pct = [...document.body.querySelectorAll('input[type="number"]')][0] as HTMLInputElement;
  changeValue(pct, "10");
  await elegirArchivo();
  await act(async () => {
    click(boton("Vista previa")!);
    await flushMicrotasks();
  });
  await esperar();
}

describe("ImportarPagosSection", () => {
  it("lee tres listados reales y muestra el indicador de reservas sin movimiento del mes", async () => {
    const { fn, llamadas } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    expect(llamadas.map((l) => l.url.replace("http://api.local/rentas/prop-1", "")).sort()).toEqual([expect.stringMatching(/^\/finanzas\/sin-movimiento\?periodo=\d{4}-\d{2}$/), "/finanzas/cola-importacion", "/finanzas/movimientos-en-revision"].sort());
    expect(document.body.querySelector('[data-testid="indicador-sin-movimiento"]')!.textContent).toContain("2 reservas sin movimiento este mes");
    click(boton("Ver lista")!);
    await esperar();
    expect(document.body.textContent).toContain("2026-10-03");
    expect(document.body.textContent).toContain("HMZZ99YY88");
    expect(document.body.textContent).toContain("La reserva se canceló");
  });

  it("un rol de solo lectura ve todo pero no tiene botones de importar ni de marcar revisado", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar(false);
    await esperar();
    expect(boton("Importar reporte de pagos (CSV)")).toBeUndefined();
    expect(boton("Marcar revisado")).toBeUndefined();
    expect(document.body.textContent).toContain("HMZZ99YY88");
  });

  it("estados vacios honestos y 'no disponible aun' cuando la base no tiene la migracion", async () => {
    const { fn } = red({ sinMov: { periodo: "2026-10", total: 0, items: [] }, cola: { disponible: true, items: [] }, revision: { disponible: false, motivo: "x", items: [] } });
    vi.stubGlobal("fetch", fn);
    rendered = montar(true);
    await esperar();
    expect(document.body.textContent).toContain("0 reservas sin movimiento este mes");
    expect(document.body.textContent).toContain("Cola vacía");
    expect(document.body.textContent).toContain("No disponible aún en este ambiente");
    expect(boton("Ver lista")).toBeUndefined();
  });

  it("error de carga visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "boom" }, false, 500)));
    rendered = montar(true);
    await esperar();
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("vista previa (POST aplicar:false), sin escribir; Confirmar pide confirmacion y CANCELAR no hace ningun POST de aplicar", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    await abrirYPrevisualizar();
    expect(r.escrituras()).toHaveLength(1);
    expect(r.escrituras()[0]).toMatchObject({ method: "POST", url: "http://api.local/rentas/prop-1/payouts/importar-csv", body: { canalCodigo: "airbnb", aplicar: false, comisionGestorBasisPoints: 1000, comisionGestorBase: "neto_de_canal" } });
    expect(document.body.textContent).toContain("1 por crear");
    expect(document.body.textContent).toContain("8730.00 MXN");

    await act(async () => {
      click(boton("Confirmar importación")!);
      await flushMicrotasks();
    });
    expect(dialogoConfirmacion()).not.toBeNull();
    await act(async () => {
      click(botonConfirmacion("Cancelar"));
      await flushMicrotasks();
    });
    await esperar();
    expect(r.escrituras()).toHaveLength(1); // nada de aplicar:true
  });

  it("confirmar importa de verdad (POST aplicar:true) y refresca los listados", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    await abrirYPrevisualizar();
    const getsAntes = r.llamadas.filter((l) => l.method === "GET").length;
    await act(async () => {
      click(boton("Confirmar importación")!);
      await flushMicrotasks();
    });
    await act(async () => {
      click(botonConfirmacion("Importar"));
      await flushMicrotasks();
    });
    await esperar();
    const aplicar = r.escrituras().filter((l) => l.body?.aplicar === true);
    expect(aplicar).toHaveLength(1);
    expect(document.body.textContent).toContain("Importación registrada");
    expect(r.llamadas.filter((l) => l.method === "GET").length).toBeGreaterThan(getsAntes);
  });

  it("con filas con error el archivo no se puede confirmar y los errores se ven", async () => {
    const r = red({ previa: { ...PREVIA, errores: [{ fila: 4, motivo: "Moneda invalida: se esperaba un codigo de 3 letras mayusculas." }] } });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    await abrirYPrevisualizar();
    expect(document.body.textContent).toContain("Fila 4: Moneda invalida");
    expect(boton("Confirmar importación")!.disabled).toBe(true);
  });

  it("canal no soportado: Booking.com y Vrbo aparecen deshabilitados con el motivo; un 422 del servidor se muestra tal cual", async () => {
    const r = red({ previaStatus: 422 });
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    click(boton("Importar reporte de pagos (CSV)")!);
    await esperar();
    const opciones = [...document.body.querySelectorAll("select option")] as HTMLOptionElement[];
    expect(opciones.filter((o) => o.disabled).map((o) => o.textContent)).toEqual(["Booking.com — formato no soportado todavía", "Vrbo — formato no soportado todavía"]);
    changeValue([...document.body.querySelectorAll('input[type="number"]')][0] as HTMLInputElement, "10");
    await elegirArchivo();
    await act(async () => {
      click(boton("Vista previa")!);
      await flushMicrotasks();
    });
    await esperar();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("todavia no esta soportado");
    expect(boton("Confirmar importación")!.disabled).toBe(true);
  });

  it("validaciones locales: sin archivo o sin comision no llama al servidor; un archivo de mas de 2 MB se rechaza al elegirlo", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    click(boton("Importar reporte de pagos (CSV)")!);
    await esperar();
    expect(boton("Vista previa")!.disabled).toBe(true);
    await elegirArchivo("a,b\n", 3 * 1024 * 1024);
    expect(document.body.textContent).toContain("excede 2 MB");
    expect(r.escrituras()).toHaveLength(0);
    await elegirArchivo();
    await act(async () => {
      click(boton("Vista previa")!);
      await flushMicrotasks();
    });
    expect(document.body.textContent).toContain("Comisión de gestor: 0 a 100 %");
    expect(r.escrituras()).toHaveLength(0);
  });

  it("cerrar el dialogo con Cancelar no escribe nada", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    click(boton("Importar reporte de pagos (CSV)")!);
    await esperar();
    click(boton("Cancelar")!);
    await esperar();
    expect(r.escrituras()).toHaveLength(0);
  });

  it("marcar un movimiento como revisado pide confirmacion: cancelar no escribe; aceptar hace POST", async () => {
    const r = red();
    vi.stubGlobal("fetch", r.fn);
    rendered = montar(true);
    await esperar();
    await act(async () => {
      click(boton("Marcar revisado")!);
      await flushMicrotasks();
    });
    await act(async () => {
      click(botonConfirmacion("Cancelar"));
      await flushMicrotasks();
    });
    expect(r.escrituras()).toHaveLength(0);
    await act(async () => {
      click(boton("Marcar revisado")!);
      await flushMicrotasks();
    });
    await act(async () => {
      click(botonConfirmacion("Marcar como revisado"));
      await flushMicrotasks();
    });
    await esperar();
    expect(r.escrituras()).toEqual([expect.objectContaining({ url: "http://api.local/rentas/prop-1/reservas/ocu-9/movimiento/revisado", method: "POST" })]);
  });
});

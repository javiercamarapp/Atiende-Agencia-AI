// @vitest-environment jsdom
//
// H-28 -- <CambiarFechasDialog />: `fetch` global mockeado por ruta real contra apps/api/.../hoteles/reservas-fechas.ts. Cubre la
// previsualizacion real al cambiar fechas, el desglose actual vs nuevo, bloqueos, la confirmacion con totalEsperado + Idempotency-Key,
// el rechazo por cambio de precio (recalcula), que Cancelar nunca ejecuta y que con el huesped en casa la llegada no se edita.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CambiarFechasDialog } from "../src/verticals/hoteles/components/CambiarFechasDialog.tsx";
import type { ReservaParaFechas } from "../src/verticals/hoteles/components/CambiarFechasDialog.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RESERVA: ReservaParaFechas = { id: "res-1", entrada: "2026-12-03", salida: "2026-12-05", estado: "confirmada", huesped: "Ana Torres" };
const desglose = (entrada: string, salida: string, noches: number, neto: number) => ({ entrada, salida, noches, neto, iva: neto * 0.16, ish: neto * 0.03, total: neto * 1.19 });
const PREVIEW = {
  reservaId: "res-1",
  estado: "confirmada",
  moneda: "MXN",
  puedeCambiar: true,
  bloqueos: [],
  actual: desglose("2026-12-03", "2026-12-05", 2, 2000),
  nueva: desglose("2026-12-03", "2026-12-06", 3, 3000),
  diferenciaTotal: 1190,
  nochesAgregadas: ["2026-12-05"],
  nochesQuitadas: [],
  nochesSinCupo: [],
  penalidad: { monto: 0, porcentaje: 0, horasParaLaNoche: null },
};

function stub(over: { preview?: Record<string, unknown>; patch?: { status: number; body: unknown } } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as unknown as Response;
    if (init?.method === "POST" && url.endsWith("/fechas/previsualizar")) return json({ ...PREVIEW, ...over.preview });
    if (init?.method === "PATCH" && url.endsWith("/fechas")) {
      const p = over.patch ?? { status: 200, body: { reserva: { id: "res-1", checkInDate: "2026-12-03", checkOutDate: "2026-12-06", estado: "confirmada", montoTotal: 3000 }, cambio: { entradaAnterior: "2026-12-03", salidaAnterior: "2026-12-05", nochesLiberadas: 0, nochesReservadas: 1 }, totalAnterior: 2380, totalNuevo: 3570, penalidad: { monto: 0, porcentaje: 0 }, ofertasListaEspera: 0 } };
      return json(p.body, p.status);
    }
    throw new Error(`fetch inesperado: ${init?.method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const body = () => document.body;
const campo = (id: string) => body().querySelector(`#${id}`) as HTMLInputElement;
const boton = (texto: string) => [...body().querySelectorAll("button")].find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
async function esperar(ms = 0) {
  await act(async () => {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}
function montar(reserva: ReservaParaFechas | null = RESERVA) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  rendered = renderComponent(<CambiarFechasDialog apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" reserva={reserva} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}
const patchCall = () => fetchMock.mock.calls.find((c) => c[1]?.method === "PATCH");

describe("CambiarFechasDialog", () => {
  it("abre con las fechas actuales, sin previsualizar ni permitir confirmar hasta que cambien", async () => {
    stub();
    montar();
    await esperar(300);
    expect(campo("cf-entrada").value).toBe("2026-12-03");
    expect(campo("cf-salida").value).toBe("2026-12-05");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(boton("Confirmar cambio")!.disabled).toBe(true);
    expect(body().textContent).toContain("Ana Torres");
  });

  it("al cambiar la salida previsualiza contra el servidor y muestra actual vs nueva, diferencia y noches agregadas", async () => {
    stub();
    montar();
    changeValue(campo("cf-salida"), "2026-12-06");
    await esperar(400);
    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/reservas/res-1/fechas/previsualizar"));
    expect(JSON.parse(post![1].body as string)).toEqual({ checkInDate: "2026-12-03", checkOutDate: "2026-12-06" });
    const texto = body().textContent ?? "";
    expect(texto).toContain("$2,380.00");
    expect(texto).toContain("$3,570.00");
    expect(texto).toContain("Diferencia a cobrar: $1,190.00");
    expect(texto).toContain("Noches agregadas");
    expect(boton("Confirmar cambio")!.disabled).toBe(false);
  });

  it("confirmar envia PATCH con totalEsperado (el de la previsualizacion), el motivo y una Idempotency-Key; avisa y cierra", async () => {
    stub();
    const { onDone, onClose } = montar();
    changeValue(campo("cf-salida"), "2026-12-06");
    changeValue(campo("cf-motivo"), "Extiende una noche");
    await esperar(400);
    await act(async () => {
      click(boton("Confirmar cambio")!);
      for (let i = 0; i < 5; i++) await flushMicrotasks();
    });
    const c = patchCall()!;
    expect(String(c[0])).toBe("https://api.test/hoteles/prop-1/reservas/res-1/fechas");
    expect(JSON.parse(c[1].body as string)).toEqual({ checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: PREVIEW.nueva.total, motivo: "Extiende una noche" });
    expect((c[1].headers as Record<string, string>)["idempotency-key"]).toMatch(/\S{8,}/);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0]![0]).toContain("$3,570.00");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("con bloqueos (sin cupo) los muestra y NO deja confirmar", async () => {
    stub({ preview: { puedeCambiar: false, nueva: null, diferenciaTotal: null, nochesSinCupo: ["2026-12-05"], bloqueos: [{ codigo: "sin_disponibilidad", mensaje: "No hay habitaciones libres en: 2026-12-05." }] } });
    montar();
    changeValue(campo("cf-salida"), "2026-12-06");
    await esperar(400);
    expect(body().textContent).toContain("No hay habitaciones libres en: 2026-12-05.");
    expect(boton("Confirmar cambio")!.disabled).toBe(true);
  });

  it("muestra la penalidad por acortar como informativa (la politica de cancelacion)", async () => {
    stub({ preview: { penalidad: { monto: 1000, porcentaje: 0.5, horasParaLaNoche: 12 }, nochesQuitadas: ["2026-12-05"], nochesAgregadas: [] } });
    montar();
    changeValue(campo("cf-salida"), "2026-12-04");
    await esperar(400);
    expect(body().textContent).toContain("Penalidad por la política de cancelación (50% de las noches liberadas): $1,000.00");
  });

  it("si el servidor rechaza por cambio de precio (409) muestra el mensaje real y vuelve a previsualizar con una llave nueva", async () => {
    stub({ patch: { status: 409, body: { code: "precio_cambio", message: "El total cambio: ahora es 3800.00 y esperabas 3570.00. Vuelve a previsualizar." } } });
    montar();
    changeValue(campo("cf-salida"), "2026-12-06");
    await esperar(400);
    await act(async () => {
      click(boton("Confirmar cambio")!);
      for (let i = 0; i < 5; i++) await flushMicrotasks();
    });
    await esperar(400);
    expect(body().textContent).toContain("El total cambio: ahora es 3800.00");
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/previsualizar")).length).toBe(2);
  });

  it("Cancelar solo cierra: jamas ejecuta el cambio", async () => {
    stub();
    const { onClose } = montar();
    changeValue(campo("cf-salida"), "2026-12-06");
    await esperar(400);
    act(() => click(boton("Cancelar")!));
    expect(onClose).toHaveBeenCalledOnce();
    expect(patchCall()).toBeUndefined();
  });

  it("huesped en casa: la llegada no se edita y se avisa que las noches cargadas no se tocan", async () => {
    stub();
    montar({ ...RESERVA, estado: "en_estancia" });
    await esperar();
    expect(campo("cf-entrada").disabled).toBe(true);
    expect(campo("cf-salida").disabled).toBe(false);
    expect(body().textContent).toContain("Las noches ya cargadas al folio no se tocan");
  });

  it("cerrado (reserva null) no renderiza nada", async () => {
    stub();
    montar(null);
    await esperar();
    expect(body().querySelector('[role="dialog"]')).toBeNull();
  });
});

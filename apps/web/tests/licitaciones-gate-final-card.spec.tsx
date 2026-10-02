// @vitest-environment jsdom
//
// L-25 -- tarjeta "Gate final" de la sala de guerra. `fetch` global mockeado por ruta real: se verifica lo que
// se ve (veredicto, cuenta regresiva, semaforo por condicion, motivo 'el ZIP no coincide con el manifiesto',
// holgura < 24 h, enlace a lo que falta), el estado de error con reintento y que nada de aqui escriba.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { GateFinalCard } from "../src/verticals/licitaciones/components/GateFinalCard.tsx";
import { formatCuentaRegresiva } from "../src/verticals/licitaciones/lib/sala-guerra-client.ts";
import type { GateSalaGuerraResponse } from "../src/verticals/licitaciones/lib/sala-guerra-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

// Reloj fijo: la tarjeta descuenta el tiempo transcurrido desde que llego la respuesta; sin esto el minuto restante podria bailar.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const H = 3_600_000;
function gate(over: Partial<GateSalaGuerraResponse["gate"]> = {}, root: Partial<GateSalaGuerraResponse> = {}): GateSalaGuerraResponse {
  return {
    now: "2026-10-05T12:00:00.000Z",
    tender: { id: "t1", title: "Compra", submissionDeadline: "2026-10-09T18:00:00.000Z" },
    proposalId: "p1",
    presentado: false,
    alerta: "no_aplica",
    gate: {
      listo: true,
      veredicto: "listo",
      condiciones: [
        { id: "aprobaciones", label: "Doble aprobación", color: "verde", motivo: "Aprobado 2/2: técnico-legal y económica, por personas distintas.", enlace: null },
        { id: "checklist", label: "Checklist de integridad", color: "verde", motivo: "Checklist de integridad en verde.", enlace: null },
        { id: "paquete", label: "Paquete de envío", color: "verde", motivo: "Paquete listo y vigente.", enlace: null },
        { id: "zip_manifiesto", label: "ZIP contra manifiesto", color: "verde", motivo: "El ZIP coincide con el manifiesto (3 documento(s) verificados por sha256).", enlace: null },
        { id: "holgura", label: "Holgura al cierre", color: "verde", motivo: "Quedan 3 d 6 h 0 min al cierre.", enlace: null },
      ],
      motivos: [],
      cuentaRegresiva: { estado: "abierto", msRestantes: 78 * H, dias: 3, horas: 6, minutos: 0, fechaCierreLocal: "2026-10-09", horaCierreLocal: "12:00", zonaHoraria: "America/Mexico_City" },
      holguraHoras: 78,
      alerta24h: false,
      ...over,
    },
    ...root,
  };
}

function stub(responder: () => { ok?: boolean; status?: number; body: unknown }) {
  fetchMock = vi.fn(async () => {
    const r = responder();
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
function mount(refreshKey = "k1") {
  rendered = renderComponent(
    <MemoryRouter>
      <GateFinalCard apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" tenderId="t1" orgSlug="demo" refreshKey={refreshKey} />
    </MemoryRouter>,
  );
}
const text = () => rendered!.container.textContent ?? "";
const row = (id: string) => rendered!.container.querySelector(`[data-testid="gate-${id}"]`) as HTMLElement;

describe("GateFinalCard (L-25)", () => {
  it("pide GET .../sala-guerra/gate y muestra 'Listo', la cuenta regresiva y las 5 condiciones en verde, sin enlaces", async () => {
    stub(() => ({ body: gate() }));
    mount();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.test/licitaciones/prop-1/tenders/t1/sala-guerra/gate");
    expect(text()).toContain("Listo para presentar");
    expect(text()).toContain("Cierra en 3 d 6 h 0 min");
    expect(text()).toContain("2026-10-09 12:00 (America/Mexico_City)");
    expect(rendered!.container.querySelectorAll("li[data-testid^='gate-']")).toHaveLength(5);
    expect(rendered!.container.querySelectorAll("a")).toHaveLength(0);
    expect(text()).not.toContain("Menos de 24 h de holgura");
  });

  it("ZIP alterado: rojo, 'No listo', el motivo exacto y enlace al cierre para volver a ensamblar", async () => {
    const g = gate({
      listo: false,
      veredicto: "no_listo",
      condiciones: gate().gate.condiciones.map((c) => (c.id === "zip_manifiesto" ? { ...c, color: "rojo" as const, motivo: "El ZIP no coincide con el manifiesto (1 documento(s) alterado(s) o ausente(s)). Vuelve a ensamblar el paquete.", enlace: "paquete" as const } : c)),
    });
    stub(() => ({ body: g }));
    mount();
    await settle();
    expect(text()).toContain("No listo");
    expect(row("zip_manifiesto").textContent).toContain("El ZIP no coincide con el manifiesto");
    expect(row("zip_manifiesto").textContent).toContain("Rojo");
    const link = row("zip_manifiesto").querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/licitaciones/demo/convocatorias/t1/cierre");
    expect(link.textContent).toBe("Ensamblar el paquete");
  });

  it("holgura < 24 h: insignia visible; con alerta24h muestra el aviso en rojo", async () => {
    const g = gate({
      listo: false,
      alerta24h: true,
      cuentaRegresiva: { estado: "abierto", msRestantes: 5 * H, dias: 0, horas: 5, minutos: 0, fechaCierreLocal: "2026-10-05", horaCierreLocal: "17:00", zonaHoraria: "America/Mexico_City" },
      condiciones: gate().gate.condiciones.map((c) => (c.id === "paquete" ? { ...c, color: "rojo" as const, motivo: "Todavía no hay un paquete de envío ensamblado.", enlace: "paquete" as const } : c)),
    });
    stub(() => ({ body: g }));
    mount();
    await settle();
    expect(text()).toContain("Menos de 24 h de holgura");
    expect(text()).toContain("Cierra en 5 h");
    expect(rendered!.container.querySelector('[role="alert"]')?.textContent).toContain("A menos de 24 horas del cierre");
  });

  it("plazo vencido y sin fecha se dicen tal cual (nunca una cuenta inventada)", async () => {
    stub(() => ({ body: gate({ listo: false, cuentaRegresiva: { estado: "vencido", msRestantes: -2 * H, dias: 0, horas: 2, minutos: 0, fechaCierreLocal: "2026-10-05", horaCierreLocal: "10:00", zonaHoraria: "America/Mexico_City" } }) }));
    mount();
    await settle();
    expect(text()).toContain("Plazo vencido hace 2 h 0 min");
    rendered!.unmount();
    stub(() => ({ body: gate({ cuentaRegresiva: { estado: "sin_fecha", msRestantes: null, dias: 0, horas: 0, minutos: 0, fechaCierreLocal: null, horaCierreLocal: null, zonaHoraria: "America/Mexico_City" } }) }));
    mount();
    await settle();
    expect(text()).toContain("no declara fecha de cierre");
  });

  it("presentacion ya declarada se muestra", async () => {
    stub(() => ({ body: gate({}, { presentado: true }) }));
    mount();
    await settle();
    expect(text()).toContain("Presentación ya declarada");
  });

  it("error de lectura: mensaje honesto y 'Reintentar' vuelve a pedir; 'Recalcular gate' tambien", async () => {
    let n = 0;
    stub(() => (n++ === 0 ? { ok: false, status: 500, body: { message: "Falla del servidor." } } : { body: gate() }));
    mount();
    await settle();
    expect(text()).toContain("Falla del servidor.");
    const retry = [...rendered!.container.querySelectorAll("button")].find((b) => /reintentar/i.test(b.textContent ?? ""))!;
    await act(async () => click(retry));
    await settle();
    expect(text()).toContain("Listo para presentar");
    const recalc = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Recalcular gate")!;
    await act(async () => click(recalc));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) expect((call[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("formatCuentaRegresiva usa valor absoluto y omite las unidades vacias", () => {
    expect(formatCuentaRegresiva(90_061_000)).toBe("1 d 1 h 1 min");
    expect(formatCuentaRegresiva(-(2 * H + 5 * 60_000))).toBe("2 h 5 min");
    expect(formatCuentaRegresiva(7 * 60_000)).toBe("7 min");
  });
});

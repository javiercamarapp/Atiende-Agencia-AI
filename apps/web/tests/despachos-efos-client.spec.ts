import { describe, expect, it, vi } from "vitest";
import { fetchEfosAlertas, resumenEfos } from "../src/verticals/despachos/lib/efos-client.ts";
import type { EfosAlertasRespuesta } from "../src/verticals/despachos/lib/efos-client.ts";

const LISTA = { estado: "disponible", periodo: "2026-07", filas: 4, ingestadoEn: "2026-07-31" } as const;
const alerta = (situacion: "presunto" | "definitivo") => ({ invoiceId: "i", folioFiscal: "f", rfcEmisor: "AAA010101AA1", emisorNombre: null, fecha: "2026-07-01", total: 1, situacion, periodoLista: "2026-07" });

describe("fetchEfosAlertas", () => {
  it("pide GET .../efos/alertas y devuelve el cuerpo tal cual", async () => {
    const body: EfosAlertasRespuesta = { lista: LISTA, estado: "disponible", alertas: [alerta("definitivo")] };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/efos/alertas");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchEfosAlertas(fetchImpl, "http://api.local", "tok", "prop-1")).toEqual(body);
  });
});

describe("resumenEfos", () => {
  it("no_disponible NUNCA se presenta como sin riesgo", () => {
    const r = resumenEfos({ lista: { estado: "no_disponible", periodo: null, filas: null, ingestadoEn: null }, estado: "no_disponible", alertas: [] });
    expect(r.tono).toBe("neutro");
    expect(r.mensaje).toMatch(/no se puede descartar riesgo/);
  });
  it("lista vigente sin coincidencias -> ok con el periodo", () => {
    const r = resumenEfos({ lista: LISTA, estado: "disponible", alertas: [] });
    expect(r.tono).toBe("ok");
    expect(r.mensaje).toContain("2026-07");
  });
  it("con alertas cuenta definitivos con plural correcto", () => {
    expect(resumenEfos({ lista: LISTA, estado: "disponible", alertas: [alerta("definitivo")] }).mensaje).toContain("(1 DEFINITIVO)");
    expect(resumenEfos({ lista: LISTA, estado: "disponible", alertas: [alerta("definitivo"), alerta("definitivo"), alerta("presunto")] }).mensaje).toContain("(2 DEFINITIVOS)");
    expect(resumenEfos({ lista: LISTA, estado: "disponible", alertas: [alerta("presunto")] }).mensaje).not.toContain("DEFINITIV");
  });
});

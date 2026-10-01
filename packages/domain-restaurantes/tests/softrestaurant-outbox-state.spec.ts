import { describe, expect, it } from "vitest";
import {
  ESTADOS_COMANDA,
  POLITICA_REINTENTO_DEFAULT,
  backoffMs,
  decidirTransicion,
  estaReclamable,
  puedeTransicionar,
  respuestaAgenteComanda,
  type EstadoComanda,
} from "../src/softrestaurant/outbox-state.ts";

const AHORA = new Date("2026-09-30T18:00:00.000Z");

describe("backoffMs", () => {
  it("duplica por intento y respeta el tope", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(POLITICA_REINTENTO_DEFAULT.maxMs);
  });
  it("es determinista y trata intentos < 1 como 1", () => {
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(2)).toBe(backoffMs(2));
  });
});

describe("decidirTransicion", () => {
  it("creada => confirmada con el folio del POS", () => {
    expect(decidirTransicion({ status: "creada", folio: "T1-000001", duplicada: false, impresaEnCocina: true }, 1, AHORA)).toMatchObject({
      estado: "confirmada",
      folio: "T1-000001",
      alertarCapturaManual: false,
    });
  });
  it("rechazada => captura manual inmediata (reintentar no sirve) y alerta", () => {
    const d = decidirTransicion({ status: "rechazada", motivo: "producto_inexistente", detalle: "x" }, 1, AHORA);
    expect(d).toMatchObject({ estado: "captura_manual", folio: null, alertarCapturaManual: true, proximoIntentoEn: null });
    expect(d.ultimoError).toBe("rechazada:producto_inexistente");
  });
  it("no_disponible con intentos restantes => fallida con proximo intento por backoff, sin alerta", () => {
    const d = decidirTransicion({ status: "no_disponible", causa: "timeout" }, 2, AHORA);
    expect(d.estado).toBe("fallida");
    expect(d.proximoIntentoEn?.toISOString()).toBe(new Date(AHORA.getTime() + 60_000).toISOString());
    expect(d.alertarCapturaManual).toBe(false);
    expect(d.folio).toBeNull();
  });
  it("no_disponible al agotar intentos => captura manual con alerta", () => {
    const d = decidirTransicion({ status: "no_disponible", causa: "http_5xx" }, POLITICA_REINTENTO_DEFAULT.maxIntentos, AHORA);
    expect(d).toMatchObject({ estado: "captura_manual", alertarCapturaManual: true });
    expect(d.ultimoError).toContain("intentos_agotados");
  });
  it("NINGUNA decision distinta de confirmada trae folio", () => {
    for (const r of [
      { status: "rechazada", motivo: "otro", detalle: "" },
      { status: "no_disponible", causa: "timeout" },
      { status: "no_disponible", causa: "no_configurado" },
    ] as const) {
      expect(decidirTransicion(r, 1, AHORA).folio).toBeNull();
      expect(decidirTransicion(r, 99, AHORA).folio).toBeNull();
    }
  });
});

describe("puedeTransicionar / estaReclamable", () => {
  it("solo permite la maquina de estados documentada", () => {
    expect(puedeTransicionar("pendiente", "enviada")).toBe(true);
    expect(puedeTransicionar("enviada", "confirmada")).toBe(true);
    expect(puedeTransicionar("enviada", "fallida")).toBe(true);
    expect(puedeTransicionar("fallida", "enviada")).toBe(true);
    expect(puedeTransicionar("captura_manual", "capturada_manual")).toBe(true);
    expect(puedeTransicionar("fallida", "capturada_manual")).toBe(true);
    expect(puedeTransicionar("pendiente", "confirmada")).toBe(false);
    expect(puedeTransicionar("confirmada", "enviada")).toBe(false);
    expect(puedeTransicionar("capturada_manual", "enviada")).toBe(false);
    expect(puedeTransicionar("captura_manual", "enviada")).toBe(false);
  });
  it("reclamable: pendiente/fallida vencidas y enviada con lease vencido; nunca terminales ni captura manual", () => {
    const pasado = new Date(AHORA.getTime() - 1000);
    const futuro = new Date(AHORA.getTime() + 1000);
    expect(estaReclamable({ estado: "pendiente", proximoIntentoEn: pasado, reclamadaEn: null }, AHORA)).toBe(true);
    expect(estaReclamable({ estado: "fallida", proximoIntentoEn: futuro, reclamadaEn: null }, AHORA)).toBe(false);
    expect(estaReclamable({ estado: "enviada", proximoIntentoEn: pasado, reclamadaEn: new Date(AHORA.getTime() - 10_000) }, AHORA)).toBe(false);
    expect(estaReclamable({ estado: "enviada", proximoIntentoEn: pasado, reclamadaEn: new Date(AHORA.getTime() - 200_000) }, AHORA)).toBe(true);
    for (const e of ["confirmada", "captura_manual", "capturada_manual"] as EstadoComanda[]) {
      expect(estaReclamable({ estado: e, proximoIntentoEn: pasado, reclamadaEn: null }, AHORA)).toBe(false);
    }
  });
});

describe("respuestaAgenteComanda: el agente NUNCA inventa un folio", () => {
  it("confirmada con folio => folio real", () => {
    expect(respuestaAgenteComanda({ estado: "confirmada", folio: "T2-000010" })).toMatchObject({ estado: "confirmada", folio: "T2-000010" });
  });
  it("cualquier otro estado, o confirmada sin folio, o sin fila => pendiente de confirmar, folio null", () => {
    for (const estado of ESTADOS_COMANDA.filter((e) => e !== "confirmada")) {
      const r = respuestaAgenteComanda({ estado, folio: "T9-FALSO" });
      expect(r).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
      expect(r.mensaje).not.toContain("T9-FALSO");
    }
    expect(respuestaAgenteComanda({ estado: "confirmada", folio: null }).folio).toBeNull();
    expect(respuestaAgenteComanda({ estado: "confirmada", folio: "  " }).folio).toBeNull();
    expect(respuestaAgenteComanda(null)).toMatchObject({ estado: "pendiente_de_confirmar", folio: null });
  });
});

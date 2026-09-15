import { describe, expect, it, vi } from "vitest";
import { clasificarDepositoConciliacion, correrMatchingConciliacion, fetchAlertasConciliacion, verificarSpeiConciliacion } from "../src/verticals/despachos/lib/conciliacion-client.ts";
import type { AlertaConciliacion, MovimientoBancario, MovimientoBancarioInput, ResultadoClasificacionDeposito, ResultadoConciliacion, ResultadoVerificacionSpei } from "../src/verticals/despachos/lib/conciliacion-client.ts";

const MOV_INPUT: MovimientoBancarioInput = { fecha: "2026-03-05", descripcion: "PAGO PROVEEDOR", referencia: "REF123", abono: null, cargo: 1000 };

const MOV_RESUELTO: MovimientoBancario = {
  fecha: "2026-03-05",
  descripcion: "PAGO PROVEEDOR",
  referencia: "REF123",
  cargo: 1000,
  abono: null,
  saldo: null,
  monto: -1000,
  banco: "generic",
  formato: "csv",
};

describe("correrMatchingConciliacion", () => {
  it("manda POST .../conciliacion/matching con movimientos + opciones y devuelve el resultado tal cual", async () => {
    const resultado: ResultadoConciliacion = {
      matched: [
        {
          movementIdx: 0,
          registroIdx: 0,
          registroIndices: null,
          level: "exacto",
          score: 100,
          detail: "monto y fecha exactos",
          montoBanco: -1000,
          montoRegistro: 1000,
          fechaBanco: "2026-03-05",
          fechaRegistro: "2026-03-05",
        },
      ],
      unmatchedBank: [],
      unmatchedBooks: [],
      confidence: 1,
      totalMovements: 1,
      totalRecords: 1,
      totalMatched: 1,
      matchRate: 1,
      montoMatched: 1000,
      montoUnmatchedBank: 0,
      montoUnmatchedBooks: 0,
      processingTimeMs: 3,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/conciliacion/matching");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ movimientos: [MOV_INPUT], dateToleranceDays: 5 });
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await correrMatchingConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", [MOV_INPUT], { dateToleranceDays: 5 });
    expect(result).toEqual(resultado);
    expect(result.unmatchedBank).toEqual([]);
  });

  it("sin opciones manda solo {movimientos}", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ movimientos: [MOV_INPUT] });
      return new Response(JSON.stringify({ matched: [], unmatchedBank: [MOV_RESUELTO], unmatchedBooks: [], confidence: 0, totalMovements: 1, totalRecords: 0, totalMatched: 0, matchRate: 0, montoMatched: 0, montoUnmatchedBank: 1000, montoUnmatchedBooks: 0, processingTimeMs: 1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const result = await correrMatchingConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", [MOV_INPUT]);
    expect(result.unmatchedBank).toEqual([MOV_RESUELTO]);
  });

  it("400 (validación) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "movimientos[0].fecha: se esperaba un string no vacío." }), { status: 400 })) as unknown as typeof fetch;
    await expect(correrMatchingConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", [MOV_INPUT])).rejects.toThrow("se esperaba un string no vacío");
  });
});

describe("fetchAlertasConciliacion", () => {
  it("sin declaredIncome manda solo {movimientos}", async () => {
    const alertas: readonly AlertaConciliacion[] = [
      { itemType: "bank", fecha: "2026-03-05", monto: -1000, descripcion: "PAGO PROVEEDOR", daysUnreconciled: 2, severity: "warning", message: "Retiro de $1000.00 sin CFDI relacionado (2d)", rule: "withdrawal_no_cfdi" },
    ];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/conciliacion/alertas");
      expect(JSON.parse(init?.body as string)).toEqual({ movimientos: [MOV_INPUT] });
      return new Response(JSON.stringify({ alertas }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchAlertasConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", [MOV_INPUT]);
    expect(result.alertas).toEqual(alertas);
  });

  it("con declaredIncome lo incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ movimientos: [MOV_INPUT], declaredIncome: 5000 });
      return new Response(JSON.stringify({ alertas: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAlertasConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", [MOV_INPUT], 5000);
  });
});

describe("clasificarDepositoConciliacion", () => {
  it("sin referencia manda solo {descripcion}", async () => {
    const resultado: ResultadoClasificacionDeposito = { clasificacion: "ingreso", confidence: 0.95, articuloCff: "CFF Art. 14, LIVA Art. 1", requiresHumanReview: false };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/conciliacion/clasificar-deposito");
      expect(JSON.parse(init?.body as string)).toEqual({ descripcion: "PAGO FACTURA A123" });
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await clasificarDepositoConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", "PAGO FACTURA A123");
    expect(result).toEqual(resultado);
  });

  it("con referencia la incluye en el body", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ descripcion: "APORTACION SOCIO", referencia: "REF9" });
      return new Response(JSON.stringify({ clasificacion: "aportacion_socio", confidence: 0.9, articuloCff: "CFF Art. 59 fr. III", requiresHumanReview: false }), { status: 200 });
    }) as unknown as typeof fetch;
    await clasificarDepositoConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", "APORTACION SOCIO", "REF9");
  });
});

describe("verificarSpeiConciliacion", () => {
  it("manda POST .../conciliacion/verificar-spei con el input tal cual y devuelve el resultado", async () => {
    const resultado: ResultadoVerificacionSpei = { verified: true, bestScore: 90, movementIdx: 0 };
    const input = { movimientos: [MOV_INPUT], claveRastreo: "REF123", monto: 1000, fecha: "2026-03-05" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/conciliacion/verificar-spei");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual(input);
      return new Response(JSON.stringify(resultado), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await verificarSpeiConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", input);
    expect(result).toEqual(resultado);
  });

  it("400 (sin claveRastreo ni rfc) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Se requiere claveRastreo o rfc." }), { status: 400 })) as unknown as typeof fetch;
    await expect(verificarSpeiConciliacion(fetchImpl, "http://api.local", "tok", "prop-1", { movimientos: [], monto: 1, fecha: "2026-03-05" })).rejects.toThrow("Se requiere claveRastreo o rfc.");
  });
});

import { describe, expect, it, vi } from "vitest";
import { fetchFraudAlerts, resolveFraudAlert, runFraudScan } from "../src/verticals/hoteles/lib/fraude-client.ts";

const ALERT_ROW = {
  id: "alert-1",
  patron: "descuento_fuera_de_politica",
  folioId: "folio-1",
  cargoId: "charge-1",
  pagoId: null,
  razon: "Descuento de $800 sin autorización admin (umbral: $500).",
  evidencia: { montoDescuento: 800, umbral: 500 },
  rolesDestinatario: ["owner", "gm"],
  estado: "pendiente",
  notaDecision: null,
  resueltoPor: null,
  resueltoEn: null,
  creadoEn: "2026-01-01T00:00:00.000Z",
};

describe("fetchFraudAlerts", () => {
  it("con filtro agrega ?estado=pendiente", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/fraude/alertas?estado=pendiente");
      return new Response(JSON.stringify([ALERT_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchFraudAlerts(fetchImpl, "http://api.local", "tok", "prop-1", "pendiente");
    expect(result).toHaveLength(1);
  });
});

describe("runFraudScan", () => {
  it("hace POST real a .../escaneos", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/fraude/escaneos");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ alertas: [{ ...ALERT_ROW, esNueva: true }], generadas: 1, yaExistentes: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await runFraudScan(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result.generadas).toBe(1);
  });
});

describe("resolveFraudAlert", () => {
  it("hace POST real a .../confirmar con la nota", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/fraude/alertas/alert-1/confirmar");
      expect(JSON.parse(init!.body as string)).toEqual({ nota: "Confirmado con gerencia." });
      return new Response(JSON.stringify({ ...ALERT_ROW, estado: "confirmado", notaDecision: "Confirmado con gerencia." }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await resolveFraudAlert(fetchImpl, "http://api.local", "tok", "prop-1", "alert-1", "confirmar", "Confirmado con gerencia.");
    expect(result.estado).toBe("confirmado");
  });

  it("una alerta ya resuelta -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Esta alerta ya fue resuelta." }), { status: 409 })) as unknown as typeof fetch;
    await expect(resolveFraudAlert(fetchImpl, "http://api.local", "tok", "prop-1", "alert-1", "descartar")).rejects.toThrow(/ya fue resuelta/);
  });
});

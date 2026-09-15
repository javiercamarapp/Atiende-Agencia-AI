import { describe, expect, it, vi } from "vitest";
import { acknowledgeRenewalAlert, fetchRenewalAlerts, scanRenewalAlerts } from "../src/verticals/licitaciones/lib/renewal-radar-client.ts";
import type { RenewalAlertRecord } from "../src/verticals/licitaciones/lib/renewal-radar-client.ts";

const ALERT: RenewalAlertRecord = {
  id: "alert-1",
  organizationId: "org-1",
  contractId: "contract-1",
  tenderId: "tender-1",
  predictedDate: "2026-12-01",
  leadDays: 90,
  confidence: 0.83,
  status: "pendiente",
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: "2026-09-01T00:00:00Z",
};

describe("scanRenewalAlerts", () => {
  it("hace POST .../renewals/scan sin body cuando no se pasan umbrales -- nunca declara leadDaysThresholds", async () => {
    const result = { evaluatedContracts: 3, alertsCreated: 1, alerts: [ALERT] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/renewals/scan");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({});
      return new Response(JSON.stringify(result), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await scanRenewalAlerts(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(out).toEqual(result);
  });

  it("con umbrales explícitos, los manda tal cual en el body", async () => {
    const result = { evaluatedContracts: 1, alertsCreated: 0, alerts: [] };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ leadDaysThresholds: [45, 15] });
      return new Response(JSON.stringify(result), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await scanRenewalAlerts(fetchImpl, "http://api.local", "tok", "prop-1", [45, 15]);
    expect(out).toEqual(result);
  });

  it("400 (umbrales inválidos server-side) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "leadDaysThresholds: se esperaba un arreglo de hasta 10 enteros positivos." }), { status: 400 })) as unknown as typeof fetch;
    await expect(scanRenewalAlerts(fetchImpl, "http://api.local", "tok", "prop-1", [-1])).rejects.toThrow("leadDaysThresholds");
  });
});

describe("fetchRenewalAlerts", () => {
  it("hace GET .../renewals/alerts y devuelve el arreglo", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/renewals/alerts");
      return new Response(JSON.stringify({ alerts: [ALERT] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchRenewalAlerts(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(out).toEqual([ALERT]);
  });
});

describe("acknowledgeRenewalAlert", () => {
  it("hace POST .../renewals/alerts/:alertId/acknowledge y devuelve la alerta actualizada", async () => {
    const acknowledged: RenewalAlertRecord = { ...ALERT, status: "reconocida", acknowledgedAt: "2026-09-10T12:00:00Z", acknowledgedBy: "user-1" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/renewals/alerts/alert-1/acknowledge");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(acknowledged), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await acknowledgeRenewalAlert(fetchImpl, "http://api.local", "tok", "prop-1", "alert-1");
    expect(out).toEqual(acknowledged);
  });

  it("404 (alerta inexistente) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Alerta de renovación no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(acknowledgeRenewalAlert(fetchImpl, "http://api.local", "tok", "prop-1", "missing")).rejects.toThrow("Alerta de renovación no encontrada.");
  });
});

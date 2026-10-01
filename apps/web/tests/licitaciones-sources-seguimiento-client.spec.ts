import { describe, expect, it, vi } from "vitest";
import { fetchSourceConnectors, fetchSourceFreshness, fetchSourceRuns, formatAge } from "../src/verticals/licitaciones/lib/sources-client.ts";
import { acknowledgeDeadlineReminder, acknowledgeTenderChangeNotification, fetchDeadlineReminders, fetchTenderChangeNotifications } from "../src/verticals/licitaciones/lib/seguimiento-client.ts";

function mockFetch(expectUrl: string, expectMethod: string, body: unknown): typeof fetch {
  return vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(expectUrl);
    expect(init?.method ?? "GET").toBe(expectMethod);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("sources-client", () => {
  it("lee el registro, la frescura y las corridas de las rutas reales", async () => {
    const connectors = [{ id: "manual", kind: "manual", label: "Alta manual", termsNote: "", cadence: { minIntervalMinutes: 0, note: "" }, liveVerification: { verified: false, note: "" } }];
    expect(await fetchSourceConnectors(mockFetch("http://api/licitaciones/p1/sources", "GET", { connectors }), "http://api", "t", "p1")).toEqual(connectors);
    const freshness = [{ source: "manual", lastRunState: null, lastSuccessAt: null, staleForMs: null, staleThresholdMs: 1, stale: true }];
    expect(await fetchSourceFreshness(mockFetch("http://api/licitaciones/p1/sources/freshness", "GET", { freshness }), "http://api", "t", "p1")).toEqual(freshness);
    expect(await fetchSourceRuns(mockFetch("http://api/licitaciones/p1/sources/runs?source=nl_ocds&limit=5", "GET", { runs: [] }), "http://api", "t", "p1", { source: "nl_ocds", limit: 5 })).toEqual([]);
  });

  it("formatAge nunca presenta 'nunca hubo corrida' como cero de antigüedad", () => {
    expect(formatAge(null)).toBe("Nunca");
    expect(formatAge(30_000)).toBe("Hace menos de 1 min");
    expect(formatAge(5 * 60_000)).toBe("Hace 5 min");
    expect(formatAge(3 * 3_600_000)).toBe("Hace 3 h");
    expect(formatAge(72 * 3_600_000)).toBe("Hace 3 d");
  });
});

describe("seguimiento-client", () => {
  it("lee y reconoce recordatorios de plazo con las rutas reales", async () => {
    const reminder = { id: "r1", tenderId: "t1", submissionDeadline: "2026-10-01T00:00:00Z", daysRemaining: 2, message: "m", createdAt: "x", acknowledgedAt: null };
    expect(await fetchDeadlineReminders(mockFetch("http://api/licitaciones/p1/sources/deadline-reminders", "GET", { reminders: [reminder] }), "http://api", "t", "p1")).toEqual([reminder]);
    const acked = { ...reminder, acknowledgedAt: "y" };
    expect(await acknowledgeDeadlineReminder(mockFetch("http://api/licitaciones/p1/sources/deadline-reminders/r1/ack", "POST", { reminder: acked }), "http://api", "t", "p1", "r1")).toEqual(acked);
  });

  it("lee y reconoce cambios de convocatoria", async () => {
    const n = { id: "n1", tenderId: "t1", tenderVersion: 2, reason: "r", changedFieldNames: [], affectedSectionKeys: [], createdAt: "x", acknowledgedAt: null };
    expect(await fetchTenderChangeNotifications(mockFetch("http://api/licitaciones/p1/tender-change-notifications", "GET", { notifications: [n] }), "http://api", "t", "p1")).toEqual([n]);
    expect(await acknowledgeTenderChangeNotification(mockFetch("http://api/licitaciones/p1/tender-change-notifications/n1/acknowledge", "POST", n), "http://api", "t", "p1", "n1")).toEqual(n);
  });
});

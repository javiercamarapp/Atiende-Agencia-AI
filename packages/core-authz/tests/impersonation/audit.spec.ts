import { describe, expect, it, vi } from "vitest";
import {
  InMemoryImpersonationAuditStore,
  dayKey,
  recordImpersonation,
  type ImpersonationAuditStore,
  type ImpersonationReservation,
} from "../../src/impersonation/index.ts";
import type { SuperadminActor } from "../../src/impersonation/index.ts";

const ACTOR: SuperadminActor = { userId: "superadmin-1", email: "javier@atiende.dev" };
// Miércoles 11-sep-2026, mediodía UTC.
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const NEXT_DAY = NOW + 24 * 60 * 60 * 1000;

describe("dayKey", () => {
  it("da formato AAAA-MM-DD", () => {
    expect(dayKey(NOW, "UTC")).toBe("2026-09-11");
  });

  it("el mismo instante puede caer en días distintos según la zona horaria (por diseño: el reloj es el de quien opera, no UTC)", () => {
    // 2026-09-11T23:30:00Z: en UTC ya es 11; en CDMX (UTC-6 en esa fecha) sigue siendo 11 por la tarde-noche.
    // Se prueba con una franja clara donde SÍ cambia el día: 03:30 UTC del 11 es 21:30 del 10 en CDMX.
    const madrugadaUtc = Date.UTC(2026, 8, 11, 3, 30, 0);
    expect(dayKey(madrugadaUtc, "UTC")).toBe("2026-09-11");
    expect(dayKey(madrugadaUtc, "America/Mexico_City")).toBe("2026-09-10");
  });
});

describe("InMemoryImpersonationAuditStore + recordImpersonation", () => {
  it("la primera impersonación del día se registra", async () => {
    const store = new InMemoryImpersonationAuditStore();
    const outcome = await recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" });
    expect(outcome).toBe("recorded");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      actorId: "superadmin-1",
      actorEmail: "javier@atiende.dev",
      organizationId: "org-1",
      day: "2026-09-11",
      source: "cookie",
    });
  });

  it("DEDUPE: una segunda impersonación del MISMO (actor, organización, día) no vuelve a escribir la bitácora", async () => {
    const store = new InMemoryImpersonationAuditStore();
    const first = await recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" });
    const second = await recordImpersonation(store, ACTOR, "org-1", {
      source: "explicit",
      nowMs: NOW + 60_000,
      timeZone: "UTC",
    });
    expect(first).toBe("recorded");
    expect(second).toBe("already_recorded_today");
    expect(store.entries).toHaveLength(1);
  });

  it("un día distinto SÍ vuelve a firmar — el dedup es por día, no para siempre", async () => {
    const store = new InMemoryImpersonationAuditStore();
    await recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" });
    const outcome = await recordImpersonation(store, ACTOR, "org-1", {
      source: "cookie",
      nowMs: NEXT_DAY,
      timeZone: "UTC",
    });
    expect(outcome).toBe("recorded");
    expect(store.entries).toHaveLength(2);
  });

  it("una organización distinta el mismo día también se registra aparte (dedup es por terna completa, no solo por actor+día)", async () => {
    const store = new InMemoryImpersonationAuditStore();
    await recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" });
    const outcome = await recordImpersonation(store, ACTOR, "org-2", { source: "cookie", nowMs: NOW, timeZone: "UTC" });
    expect(outcome).toBe("recorded");
    expect(store.entries).toHaveLength(2);
  });

  it("dos reservas 'concurrentes' de la misma terna: la base decide quién gana, no un select previo con carrera — solo una queda como 'first'", async () => {
    const store = new InMemoryImpersonationAuditStore();
    const [a, b] = await Promise.all([
      recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" }),
      recordImpersonation(store, ACTOR, "org-1", { source: "cookie", nowMs: NOW, timeZone: "UTC" }),
    ]);
    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(["already_recorded_today", "recorded"]);
    expect(store.entries).toHaveLength(1);
  });

  it("BEST-EFFORT: si el store falla al reservar, recordImpersonation NUNCA lanza — devuelve 'failed' y reporta vía onFailure", async () => {
    const failingStore: ImpersonationAuditStore = {
      reserveToday: vi.fn<() => Promise<ImpersonationReservation>>().mockRejectedValue(new Error("la base no respondió")),
      record: vi.fn().mockResolvedValue(undefined),
    };
    const onFailure = vi.fn();
    const outcome = await recordImpersonation(failingStore, ACTOR, "org-1", {
      source: "cookie",
      nowMs: NOW,
      timeZone: "UTC",
      onFailure,
    });
    expect(outcome).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(failingStore.record).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT: si el store falla al escribir la fila (ya ganó la reserva), también devuelve 'failed' sin lanzar", async () => {
    const failingStore: ImpersonationAuditStore = {
      reserveToday: vi.fn<() => Promise<ImpersonationReservation>>().mockResolvedValue("first"),
      record: vi.fn().mockRejectedValue(new Error("insert falló")),
    };
    const onFailure = vi.fn();
    const outcome = await recordImpersonation(failingStore, ACTOR, "org-1", {
      source: "cookie",
      nowMs: NOW,
      timeZone: "UTC",
      onFailure,
    });
    expect(outcome).toBe("failed");
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

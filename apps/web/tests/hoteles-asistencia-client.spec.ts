import { describe, expect, it, vi } from "vitest";
import { checkIn, fetchAttendance, fetchCrossCheck, fetchStpsExportCsv, upsertStaffSchedule } from "../src/verticals/hoteles/lib/asistencia-client.ts";

const EVENT_ROW = {
  id: "evt-1",
  staffUserId: "staff-1",
  eventType: "entrada",
  recordedAt: "2026-01-01T09:00:00.000Z",
  source: "app",
  nota: null,
};

describe("checkIn", () => {
  it("hace POST a .../asistencia/checar con el eventType", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/asistencia/checar");
      expect(JSON.parse(init!.body as string)).toEqual({ eventType: "entrada" });
      return new Response(JSON.stringify(EVENT_ROW), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await checkIn(fetchImpl, "http://api.local", "tok", "prop-1", "entrada");
    expect(result.staffUserId).toBe("staff-1");
  });

  it("incluye la nota cuando se pasa", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ eventType: "salida", note: "Turno cubierto" });
      return new Response(JSON.stringify({ ...EVENT_ROW, eventType: "salida" }), { status: 201 });
    }) as unknown as typeof fetch;
    await checkIn(fetchImpl, "http://api.local", "tok", "prop-1", "salida", "Turno cubierto");
  });
});

describe("fetchAttendance", () => {
  it("sin opciones pide el historial propio sin query string", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/asistencia");
      return new Response(JSON.stringify([EVENT_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchAttendance(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
  });

  it("con staffUserId y rango arma la query completa", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/hoteles/prop-1/asistencia");
      expect(parsed.searchParams.get("staffUserId")).toBe("staff-2");
      expect(parsed.searchParams.get("desde")).toBe("2026-01-01");
      expect(parsed.searchParams.get("hasta")).toBe("2026-01-07");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchAttendance(fetchImpl, "http://api.local", "tok", "prop-1", { staffUserId: "staff-2", fromDate: "2026-01-01", toDate: "2026-01-07" });
  });
});

describe("upsertStaffSchedule", () => {
  it("hace POST a .../asistencia/horarios con el input completo", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/asistencia/horarios");
      expect(JSON.parse(init!.body as string)).toEqual({
        staffUserId: "staff-1",
        workDate: "2026-01-01",
        scheduledStart: "2026-01-01T09:00:00.000Z",
        scheduledEnd: "2026-01-01T18:00:00.000Z",
        authorizedOvertimeMinutes: 30,
      });
      return new Response(
        JSON.stringify({ id: "sched-1", staffUserId: "staff-1", workDate: "2026-01-01", scheduledStart: "2026-01-01T09:00:00.000Z", scheduledEnd: "2026-01-01T18:00:00.000Z", authorizedOvertimeMinutes: 30 }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const result = await upsertStaffSchedule(fetchImpl, "http://api.local", "tok", "prop-1", {
      staffUserId: "staff-1",
      workDate: "2026-01-01",
      scheduledStart: "2026-01-01T09:00:00.000Z",
      scheduledEnd: "2026-01-01T18:00:00.000Z",
      authorizedOvertimeMinutes: 30,
    });
    expect(result.id).toBe("sched-1");
  });
});

describe("fetchCrossCheck", () => {
  it("arma la query staffUserId/desde/hasta", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/hoteles/prop-1/asistencia/cruce");
      expect(parsed.searchParams.get("staffUserId")).toBe("staff-1");
      expect(parsed.searchParams.get("desde")).toBe("2026-01-01");
      expect(parsed.searchParams.get("hasta")).toBe("2026-01-07");
      return new Response(
        JSON.stringify([{ fecha: "2026-01-01", estado: "ok", horarioInicio: null, horarioFin: null, horasProgramadas: null, horasTrabajadas: 8, horasExtra: 0, horasExtraAutorizadas: 0, horasExtraNoAutorizadas: 0, alerta: false, anomalias: [] }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchCrossCheck(fetchImpl, "http://api.local", "tok", "prop-1", "staff-1", "2026-01-01", "2026-01-07");
    expect(result).toHaveLength(1);
    expect(result[0]!.horasTrabajadas).toBe(8);
  });
});

describe("fetchStpsExportCsv", () => {
  it("pide el CSV y devuelve el texto crudo (no JSON)", async () => {
    const csv = "rfc,fecha,horas\nSIN_RFC,2026-01-01,8\n";
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/hoteles/prop-1/asistencia/exportar-stps");
      expect(parsed.searchParams.get("staffUserId")).toBe("staff-1");
      return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const result = await fetchStpsExportCsv(fetchImpl, "http://api.local", "tok", "prop-1", "staff-1", "2026-01-01", "2026-01-07");
    expect(result).toBe(csv);
  });

  it("propaga el mensaje de error del servidor cuando la respuesta no es ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No autorizado." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchStpsExportCsv(fetchImpl, "http://api.local", "tok", "prop-1", "staff-1", "2026-01-01", "2026-01-07")).rejects.toThrow("No autorizado.");
  });
});

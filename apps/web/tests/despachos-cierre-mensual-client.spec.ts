import { describe, expect, it, vi } from "vitest";
import { cerrarPeriodoCierre, completarTareaCierre, crearPeriodo, fetchPeriodoDetalle, fetchPeriodos, fetchReporteCierre } from "../src/verticals/despachos/lib/cierre-mensual-client.ts";

describe("fetchPeriodos", () => {
  it("pide GET .../cierre-mensual/periodos y devuelve la lista", async () => {
    const periodos = [{ id: "p1", organizationId: "o1", propertyId: "prop-1", year: 2026, month: 3, status: "open", openedAt: "2026-03-01T00:00:00Z", closedAt: null, closedBy: null }];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos");
      return new Response(JSON.stringify({ periodos }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPeriodos(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual(periodos);
  });
});

describe("fetchPeriodoDetalle", () => {
  it("pide GET .../periodos/:id y devuelve periodo+tareas+estado tal cual", async () => {
    const body = {
      periodo: { id: "p1", organizationId: "o1", propertyId: "prop-1", year: 2026, month: 3, status: "open", openedAt: "2026-03-01T00:00:00Z", closedAt: null, closedBy: null },
      tareas: [],
      estado: { totalTasks: 0, done: 0, skipped: 0, pending: 0, inProgress: 0, progressPercent: 0, blocked: [], overdue: [] },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos/p1");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPeriodoDetalle(fetchImpl, "http://api.local", "tok", "prop-1", "p1");
    expect(result).toEqual(body);
  });
});

describe("crearPeriodo", () => {
  it("manda POST .../periodos con anio/mes", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ anio: 2026, mes: 3 }));
      return new Response(JSON.stringify({ periodo: {}, tareas: [] }), { status: 201 });
    }) as unknown as typeof fetch;
    await crearPeriodo(fetchImpl, "http://api.local", "tok", "prop-1", { anio: 2026, mes: 3 });
  });

  it("respuesta 409 (período duplicado) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Ya existe un período abierto para 2026-03." }), { status: 409 })) as unknown as typeof fetch;
    await expect(crearPeriodo(fetchImpl, "http://api.local", "tok", "prop-1", { anio: 2026, mes: 3 })).rejects.toThrow("Ya existe un período abierto");
  });
});

describe("completarTareaCierre", () => {
  it("manda POST .../tareas/:id/completar con userId y devuelve las tareas actualizadas", async () => {
    const tareas = [{ id: "t1", status: "done" }];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos/p1/tareas/t1/completar");
      expect(init?.body).toBe(JSON.stringify({ userId: "u1" }));
      return new Response(JSON.stringify({ tareas }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await completarTareaCierre(fetchImpl, "http://api.local", "tok", "prop-1", "p1", "t1", "u1");
    expect(result).toEqual(tareas);
  });
});

describe("cerrarPeriodoCierre", () => {
  it("manda POST .../cerrar y devuelve el período cerrado", async () => {
    const periodo = { id: "p1", status: "closed" };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos/p1/cerrar");
      return new Response(JSON.stringify(periodo), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await cerrarPeriodoCierre(fetchImpl, "http://api.local", "tok", "prop-1", "p1", "u1");
    expect(result).toEqual(periodo);
  });

  it("409 (tareas requeridas sin completar) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No se puede cerrar: 3 tarea(s) requerida(s) sin completar." }), { status: 409 })) as unknown as typeof fetch;
    await expect(cerrarPeriodoCierre(fetchImpl, "http://api.local", "tok", "prop-1", "p1", "u1")).rejects.toThrow("No se puede cerrar");
  });
});

describe("fetchReporteCierre", () => {
  it("pide GET .../reporte y devuelve el reporte tal cual", async () => {
    const reporte = { totalTasks: 15, done: 10, skipped: 0, pending: 5, progressPercent: 66.7, doneByCategory: { cfdi: 2 }, issues: [], estimatedHours: 3.2, closed: false };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/cierre-mensual/periodos/p1/reporte");
      return new Response(JSON.stringify(reporte), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchReporteCierre(fetchImpl, "http://api.local", "tok", "prop-1", "p1");
    expect(result).toEqual(reporte);
  });
});

// H-03 -- cliente y helpers de presentacion de agentes/aprobaciones (puros, con fetch inyectado).
import { describe, expect, it, vi } from "vitest";
import {
  accionesDisponibles,
  actualizarAgente,
  decidirAprobacion,
  describirAlcance,
  ejecutarAprobacion,
  fetchAprobaciones,
  fetchAgentes,
  formatearCentavos,
  formatearVigencia,
  guardarPolitica,
  minutosParaExpirar,
  nuevaLlave,
  proponerAprobacion,
} from "../src/verticals/hoteles/lib/agentes-client.ts";

function stub(body: unknown = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("rutas y cuerpos", () => {
  it("catalogo, aprobaciones con filtros y detalle apuntan a las rutas reales", async () => {
    const s = stub({ disponible: true });
    await fetchAgentes(s.fetchImpl, "http://api", "tok", "p1");
    await fetchAprobaciones(s.fetchImpl, "http://api", "tok", "p1", { abiertas: true });
    await fetchAprobaciones(s.fetchImpl, "http://api", "tok", "p1", { estado: "pendiente" });
    await fetchAprobaciones(s.fetchImpl, "http://api", "tok", "p1");
    expect(s.calls.map((c) => c.url)).toEqual([
      "http://api/hoteles/p1/agentes",
      "http://api/hoteles/p1/aprobaciones?abiertas=1",
      "http://api/hoteles/p1/aprobaciones?estado=pendiente",
      "http://api/hoteles/p1/aprobaciones",
    ]);
  });

  it("pausar manda activo:false con motivo; presupuesto null quita el tope", async () => {
    const s = stub({ agente: {} });
    await actualizarAgente(s.fetchImpl, "http://api", "tok", "p1", "revenue", { activo: false, motivo: "Revision de costos" });
    await actualizarAgente(s.fetchImpl, "http://api", "tok", "p1", "recepcion_whatsapp", { presupuestoUsd: null });
    expect(s.calls[0]).toMatchObject({ url: "http://api/hoteles/p1/agentes/revenue", init: { method: "PUT" } });
    expect(JSON.parse(String(s.calls[0]!.init?.body))).toEqual({ activo: false, motivo: "Revision de costos" });
    expect(JSON.parse(String(s.calls[1]!.init?.body))).toEqual({ presupuestoUsd: null });
  });

  it("decidir, ejecutar, proponer y politica usan POST/PUT con el cuerpo esperado", async () => {
    const s = stub({});
    await decidirAprobacion(s.fetchImpl, "http://api", "tok", "p1", "a1", "rechazar", "Rompe la paridad");
    await ejecutarAprobacion(s.fetchImpl, "http://api", "tok", "p1", "a1", "tarifa-123");
    await ejecutarAprobacion(s.fetchImpl, "http://api", "tok", "p1", "a2");
    await proponerAprobacion(s.fetchImpl, "http://api", "tok", "p1", { accion: "reembolso", resumen: "x", montoCentavos: 25000, llaveIdempotencia: "manual-1" });
    await guardarPolitica(s.fetchImpl, "http://api", "tok", "p1", "descuento_tarifa", { modo: "auto_bajo_umbral", umbralPorcentaje: 10 });
    expect(s.calls.map((c) => [c.init?.method, c.url])).toEqual([
      ["POST", "http://api/hoteles/p1/aprobaciones/a1/rechazar"],
      ["POST", "http://api/hoteles/p1/aprobaciones/a1/ejecutar"],
      ["POST", "http://api/hoteles/p1/aprobaciones/a2/ejecutar"],
      ["POST", "http://api/hoteles/p1/aprobaciones"],
      ["PUT", "http://api/hoteles/p1/agentes/politicas/descuento_tarifa"],
    ]);
    expect(JSON.parse(String(s.calls[0]!.init?.body))).toEqual({ motivo: "Rompe la paridad" });
    expect(JSON.parse(String(s.calls[1]!.init?.body))).toEqual({ referencia: "tarifa-123" });
    expect(JSON.parse(String(s.calls[2]!.init?.body))).toEqual({});
  });

  it("un error del servidor sale con su propio mensaje (409/403) y no se enmascara", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "La solicitud ya esta aprobada" }), { status: 409 })) as unknown as typeof fetch;
    await expect(decidirAprobacion(fetchImpl, "http://api", "tok", "p1", "a1", "aprobar", "motivo valido")).rejects.toThrow(/ya esta aprobada/);
  });
});

describe("helpers de presentacion", () => {
  it("formatea centavos MXN y vigencias en el borde", () => {
    expect(formatearCentavos(25050)).toMatch(/250\.50/);
    expect(formatearCentavos(null)).toBe("—");
    expect(formatearVigencia(null)).toBe("Vencida");
    expect(formatearVigencia(59)).toBe("59 min");
    expect(formatearVigencia(60)).toBe("1 h");
    expect(formatearVigencia(135)).toBe("2 h 15 min");
    expect(formatearVigencia(47 * 60)).toBe("47 h");
    expect(formatearVigencia(48 * 60)).toBe("2 d");
  });

  it("minutos para expirar: positivo mientras vigente, null en el instante exacto y despues", () => {
    expect(minutosParaExpirar("2026-06-01T12:30:00Z", "2026-06-01T12:00:00Z")).toBe(30);
    expect(minutosParaExpirar("2026-06-01T12:00:00Z", "2026-06-01T12:00:00Z")).toBeNull();
    expect(minutosParaExpirar("2026-06-01T11:59:00Z", "2026-06-01T12:00:00Z")).toBeNull();
  });

  it("describe el alcance segun la accion", () => {
    expect(describirAlcance({ accion: "descuento_tarifa", porcentaje: 12.5, montoCentavos: null, destinatarios: null })).toBe("12.5 % de descuento");
    expect(describirAlcance({ accion: "mensaje_masivo", porcentaje: null, montoCentavos: null, destinatarios: 120 })).toBe("120 destinatarios");
    expect(describirAlcance({ accion: "reembolso", porcentaje: null, montoCentavos: 10000, destinatarios: null })).toMatch(/100\.00/);
    expect(describirAlcance({ accion: "respuesta_resena", porcentaje: null, montoCentavos: null, destinatarios: null })).toBe("—");
  });

  it("acciones por estado y rol: no aprueba lo propio; ejecutar solo owner/gm y solo aprobadas; cancelar abiertas", () => {
    const pend = { estado: "pendiente" as const, propuestaPor: "u1" };
    expect(accionesDisponibles(pend, "gm", "u2")).toEqual(["aprobar", "rechazar", "cancelar"]);
    expect(accionesDisponibles(pend, "frontdesk", "u2")).toEqual(["aprobar", "rechazar"]);
    expect(accionesDisponibles(pend, "gm", "u1")).toEqual(["cancelar"]);
    expect(accionesDisponibles(pend, "frontdesk", "u1")).toEqual(["cancelar"]);
    expect(accionesDisponibles(pend, "housekeeping", "u2")).toEqual([]);
    expect(accionesDisponibles({ estado: "aprobada", propuestaPor: null }, "owner", null)).toEqual(["cancelar", "ejecutar"]);
    expect(accionesDisponibles({ estado: "aprobada", propuestaPor: null }, "frontdesk", null)).toEqual([]);
    for (const e of ["rechazada", "expirada", "ejecutada", "cancelada", "bloqueada"] as const) expect(accionesDisponibles({ estado: e, propuestaPor: null }, "owner", "u")).toEqual([]);
  });

  it("la llave de idempotencia es unica por intento y respeta el largo maximo", () => {
    const a = nuevaLlave();
    const b = nuevaLlave();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(120);
  });
});

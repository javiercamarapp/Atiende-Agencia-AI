import { describe, expect, it, vi } from "vitest";
import {
  cancelarBloqueo,
  cancelarReserva,
  crearBloqueo,
  createReserva,
  fetchOcupaciones,
  fetchUnidades,
  modificarFechasReserva,
} from "../src/verticals/rentas/lib/calendario-client.ts";

const OCUPACION_ROW = {
  id: "ocu-1",
  unidadId: "unidad-1",
  capa: "reserva",
  rango: { inicio: "2026-12-01", fin: "2026-12-03" },
  razon: "RESERVA_CANAL",
  estado: "confirmado",
  canalCodigo: "manual",
  huespedNombre: "Ana Pérez",
  huespedContacto: "+52 55 1234 5678",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("fetchUnidades", () => {
  it("pide GET /rentas/:propertyId/unidades y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades");
      return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchUnidades(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }]);
  });

  // Hallazgo de auditoría "en rentas, una empresa gestora con varias propiedades
  // solo puede operar la primera" (cierre en RentasShell.tsx/Dashboard.tsx, Fase
  // 18): Calendario.tsx recibe `propertyId` de RentasShellContext y lo pasa
  // directo aquí -- este test confirma que el selector de property, al cambiar
  // `propertyId`, efectivamente cambia QUÉ property pide Calendario.tsx (URLs
  // distintas, nunca la misma unidad "cacheada" de la property anterior).
  it("cambiar la property activa del selector pide la URL de la NUEVA property, no la anterior", async () => {
    const urlsPedidas: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urlsPedidas.push(url);
      return new Response(JSON.stringify({ unidades: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchUnidades(fetchImpl, "http://api.local", "tok", "prop-1");
    await fetchUnidades(fetchImpl, "http://api.local", "tok", "prop-2");

    expect(urlsPedidas).toEqual(["http://api.local/rentas/prop-1/unidades", "http://api.local/rentas/prop-2/unidades"]);
  });
});

describe("fetchOcupaciones", () => {
  it("pide GET /rentas/:propertyId/unidades/:unidadId/ocupaciones y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/ocupaciones");
      return new Response(JSON.stringify({ ocupaciones: [OCUPACION_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchOcupaciones(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.huespedNombre).toBe("Ana Pérez");
  });

  it("sin permiso de calendario -> error real (403 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes el rol requerido para esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchOcupaciones(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1")).rejects.toThrow(/rol requerido/);
  });

  // Mismo hallazgo que el test análogo de fetchUnidades arriba: el selector de
  // property de RentasShell.tsx cambia `propertyId`, y Calendario.tsx vuelve a
  // pedir las ocupaciones de la unidad seleccionada bajo la NUEVA property.
  it("cambiar la property activa del selector pide las ocupaciones de la NUEVA property", async () => {
    const urlsPedidas: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urlsPedidas.push(url);
      return new Response(JSON.stringify({ ocupaciones: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchOcupaciones(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1");
    await fetchOcupaciones(fetchImpl, "http://api.local", "tok", "prop-2", "unidad-1");

    expect(urlsPedidas).toEqual([
      "http://api.local/rentas/prop-1/unidades/unidad-1/ocupaciones",
      "http://api.local/rentas/prop-2/unidades/unidad-1/ocupaciones",
    ]);
  });
});

describe("createReserva", () => {
  it("hace POST real a .../reservas", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/reservas");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ rango: { inicio: "2026-12-01", fin: "2026-12-03" }, huespedNombre: "Ana Pérez" });
      return new Response(JSON.stringify({ id: "ocu-1", conflictosCapaCruzada: 0 }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createReserva(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", {
      rango: { inicio: "2026-12-01", fin: "2026-12-03" },
      huespedNombre: "Ana Pérez",
    });
    expect(result.id).toBe("ocu-1");
    expect(result.conflictosCapaCruzada).toBe(0);
  });

  it("unidad ya ocupada en esas fechas -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "La unidad no está disponible en ese rango." }), { status: 409 })) as unknown as typeof fetch;
    await expect(createReserva(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { rango: { inicio: "2026-12-01", fin: "2026-12-03" } })).rejects.toThrow(/no está disponible/);
  });
});

describe("modificarFechasReserva", () => {
  it("hace PATCH real a .../reservas/:id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/reservas/ocu-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ rango: { inicio: "2026-12-02", fin: "2026-12-04" } });
      return new Response(JSON.stringify({ id: "ocu-1", rango: { inicio: "2026-12-02", fin: "2026-12-04" }, conflictosCapaCruzada: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await modificarFechasReserva(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "ocu-1", { inicio: "2026-12-02", fin: "2026-12-04" });
    expect(result.rango).toEqual({ inicio: "2026-12-02", fin: "2026-12-04" });
  });
});

describe("cancelarReserva", () => {
  it("hace POST real a .../reservas/:id/cancelar", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/reservas/ocu-1/cancelar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ id: "ocu-1", estado: "cancelado", estadoAnterior: "confirmado" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await cancelarReserva(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "ocu-1");
    expect(result.estado).toBe("cancelado");
  });
});

describe("crearBloqueo", () => {
  it("hace POST real a .../bloqueos", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/bloqueos");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ rango: { inicio: "2026-12-05", fin: "2026-12-06" }, razon: "MANTENIMIENTO" });
      return new Response(JSON.stringify({ id: "blq-1", conflictosCapaCruzada: 0 }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearBloqueo(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { rango: { inicio: "2026-12-05", fin: "2026-12-06" }, razon: "MANTENIMIENTO" });
    expect(result.id).toBe("blq-1");
  });
});

describe("cancelarBloqueo", () => {
  it("hace POST real a .../bloqueos/:id/cancelar", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/bloqueos/blq-1/cancelar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ id: "blq-1", estado: "cancelado", estadoAnterior: "confirmado" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await cancelarBloqueo(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", "blq-1");
    expect(result.estado).toBe("cancelado");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  aprobarBorrador,
  fetchBandejaAprobacion,
  fetchBorradores,
  fetchConversaciones,
  rechazarBorrador,
} from "../src/verticals/rentas/lib/mensajeria-client.ts";

const CONVERSACION = {
  id: "conv-1",
  organizationId: "org-1",
  propertyId: "prop-1",
  unidadId: "unidad-1",
  canal: "airbnb",
  ocupacionId: "ocu-1",
  huespedMinimoId: null,
  propiedadNombre: "Depa Centro",
  huespedNombre: "Ana Pérez",
  fechaCheckIn: "2026-12-01",
  fechaCheckOut: "2026-12-03",
  reservaConfirmada: true,
  creadoEn: "2026-01-01T00:00:00.000Z",
};

const BORRADOR_PENDIENTE = {
  id: "bor-1",
  conversacionId: "conv-1",
  mensajeEntranteId: "msg-1",
  canal: "airbnb",
  texto: "Hola Ana, tu check-in es el 1 de diciembre.",
  estado: "pendiente_aprobacion",
  generadoPor: "motor_borrador",
  redactado: false,
  aprobadoPor: null,
  aprobadoEn: null,
  rechazadoPor: null,
  rechazadoEn: null,
  motivoRechazo: null,
  mensajeEnviadoId: null,
  creadoEn: "2026-01-02T00:00:00.000Z",
  actualizadoEn: "2026-01-02T00:00:00.000Z",
};

describe("fetchConversaciones", () => {
  it("pide GET /rentas/:propertyId/unidades/:unidadId/conversaciones y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/conversaciones");
      return new Response(JSON.stringify({ conversaciones: [CONVERSACION] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchConversaciones(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1");
    expect(result).toEqual([CONVERSACION]);
  });
});

describe("fetchBorradores", () => {
  it("pide GET /rentas/:propertyId/conversaciones/:conversacionId/borradores y regresa la lista", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/conversaciones/conv-1/borradores");
      return new Response(JSON.stringify({ borradores: [BORRADOR_PENDIENTE] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchBorradores(fetchImpl, "http://api.local", "tok", "prop-1", "conv-1");
    expect(result).toEqual([BORRADOR_PENDIENTE]);
  });
});

describe("aprobarBorrador", () => {
  it("hace POST real a .../borradores/:id/aprobar sin body relevante", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/borradores/bor-1/aprobar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ...BORRADOR_PENDIENTE, estado: "enviado", aprobadoPor: "user-1", aprobadoEn: "2026-01-02T00:05:00.000Z", mensajeEnviadoId: "msg-2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await aprobarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1");
    expect(result.estado).toBe("enviado");
    expect(result.aprobadoPor).toBe("user-1");
  });

  it("aprobación requerida ya cumplida por otro actor -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El borrador ya no está pendiente de aprobación." }), { status: 409 })) as unknown as typeof fetch;
    await expect(aprobarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1")).rejects.toThrow(/ya no está pendiente/);
  });
});

describe("rechazarBorrador", () => {
  it("hace POST real a .../borradores/:id/rechazar con el motivo", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/borradores/bor-1/rechazar");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ motivo: "Tono incorrecto" });
      return new Response(JSON.stringify({ ...BORRADOR_PENDIENTE, estado: "rechazado", rechazadoPor: "user-1", motivoRechazo: "Tono incorrecto" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await rechazarBorrador(fetchImpl, "http://api.local", "tok", "prop-1", "bor-1", "Tono incorrecto");
    expect(result.estado).toBe("rechazado");
    expect(result.motivoRechazo).toBe("Tono incorrecto");
  });
});

describe("fetchBandejaAprobacion", () => {
  it("recorre unidades -> conversaciones -> borradores y arma la bandeja con pendientes primero", async () => {
    const otraConversacion = { ...CONVERSACION, id: "conv-2", unidadId: "unidad-1", huespedNombre: "Luis Ruiz", creadoEn: "2026-01-03T00:00:00.000Z" };
    const borradorEnviado = { ...BORRADOR_PENDIENTE, id: "bor-0", conversacionId: "conv-2", estado: "enviado" };

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/rentas/prop-1/unidades")) {
        return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones")) {
        return new Response(JSON.stringify({ conversaciones: [CONVERSACION, otraConversacion] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-1/borradores")) {
        return new Response(JSON.stringify({ borradores: [BORRADOR_PENDIENTE] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/conversaciones/conv-2/borradores")) {
        return new Response(JSON.stringify({ borradores: [borradorEnviado] }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchBandejaAprobacion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(2);
    // conv-1 tiene un pendiente -> va primero aunque conv-2 se haya creado después.
    expect(result[0]!.conversacion.id).toBe("conv-1");
    expect(result[0]!.pendientes).toHaveLength(1);
    expect(result[0]!.historial).toHaveLength(0);
    expect(result[1]!.conversacion.id).toBe("conv-2");
    expect(result[1]!.pendientes).toHaveLength(0);
    expect(result[1]!.historial).toHaveLength(1);
  });

  it("una unidad sin ninguna conversación no aparece en la bandeja", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/rentas/prop-1/unidades")) {
        return new Response(JSON.stringify({ unidades: [{ id: "unidad-1", nombre: "Depa Centro", duracionMinimaNoches: 1 }] }), { status: 200 });
      }
      if (url.endsWith("/rentas/prop-1/unidades/unidad-1/conversaciones")) {
        return new Response(JSON.stringify({ conversaciones: [] }), { status: 200 });
      }
      throw new Error(`URL inesperada: ${url}`);
    }) as unknown as typeof fetch;

    const result = await fetchBandejaAprobacion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([]);
  });
});

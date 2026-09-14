import { describe, expect, it, vi } from "vitest";
import { closeTicket, createTicket, fetchTickets } from "../src/verticals/hoteles/lib/housekeeping-client.ts";

const TICKET_ROW = {
  id: "ticket-1",
  roomId: "101",
  titulo: "Aire acondicionado no enfría",
  descripcion: "Cliente reporta que el AC no enfría desde ayer.",
  origen: "staff",
  severidad: "alta",
  estado: "abierto",
  asignadoA: null,
  costoEstimado: 0,
  costoReal: null,
  notaResolucion: null,
  creadoPor: "user-1",
  cerradoEn: null,
  creadoEn: "2026-01-01T00:00:00.000Z",
  actualizadoEn: "2026-01-01T00:00:00.000Z",
};

describe("fetchTickets", () => {
  it("sin filtro pide la lista completa", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/mantenimiento/tickets");
      return new Response(JSON.stringify([TICKET_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchTickets(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
  });

  it("con filtro agrega ?estado=", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/mantenimiento/tickets?estado=abierto");
      return new Response(JSON.stringify([TICKET_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchTickets(fetchImpl, "http://api.local", "tok", "prop-1", "abierto");
  });
});

describe("createTicket", () => {
  it("hace POST real con origen 'staff' fijo", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/mantenimiento/tickets");
      expect(JSON.parse(init!.body as string)).toEqual({ titulo: "Fuga de agua", descripcion: "Baño 203", severidad: "alta", origen: "staff" });
      return new Response(JSON.stringify(TICKET_ROW), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createTicket(fetchImpl, "http://api.local", "tok", "prop-1", { titulo: "Fuga de agua", descripcion: "Baño 203", severidad: "alta" });
    expect(result.id).toBe("ticket-1");
  });
});

describe("closeTicket", () => {
  it("hace POST real a .../cerrar con costo real y nota", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/mantenimiento/tickets/ticket-1/cerrar");
      expect(JSON.parse(init!.body as string)).toEqual({ actualCost: 450, notaResolucion: "Se reemplazó el compresor." });
      return new Response(JSON.stringify({ ...TICKET_ROW, estado: "cerrado", costoReal: 450 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await closeTicket(fetchImpl, "http://api.local", "tok", "prop-1", "ticket-1", 450, "Se reemplazó el compresor.");
    expect(result.estado).toBe("cerrado");
  });
});

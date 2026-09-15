import { describe, expect, it, vi } from "vitest";
import { HotelesAdminError } from "../src/verticals/hoteles/lib/admin-client.ts";
import { asegurarSeguridadFnb, confirmarCocinaFnb, crearPedidoFnb, fetchPedidoFnb, fetchPedidosFnb } from "../src/verticals/hoteles/lib/pedidos-fnb-client.ts";

const PEDIDO_SIN_ALERGIA = {
  id: "pedido-1",
  roomId: "101",
  items: [{ nombre: "Club sandwich" }],
  notas: null,
  alergiaDeclarada: false,
  alergiaDetectadaVia: null,
  cocineroConfirmoEn: null,
  cocineroConfirmoPor: null,
  puedeAsegurarSeguridad: true,
  mensajeSeguridad: "Pedido recibido.",
  seguridadAseguradaEn: null,
  creadoEn: "2026-01-01T00:00:00.000Z",
};

const PEDIDO_CON_ALERGIA_PENDIENTE = {
  ...PEDIDO_SIN_ALERGIA,
  id: "pedido-2",
  alergiaDeclarada: true,
  alergiaDetectadaVia: "estructurado" as const,
  puedeAsegurarSeguridad: false,
  mensajeSeguridad: "Registramos tu alergia/restricción alimentaria. Un cocinero debe confirmar el platillo antes de poder darte una respuesta sobre su seguridad.",
};

describe("fetchPedidosFnb", () => {
  it("hace GET real a /pedidos-fnb", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pedidos-fnb");
      return new Response(JSON.stringify([PEDIDO_SIN_ALERGIA]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPedidosFnb(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("pedido-1");
  });
});

describe("fetchPedidoFnb", () => {
  it("hace GET real a /pedidos-fnb/:orderId", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pedidos-fnb/pedido-2");
      return new Response(JSON.stringify(PEDIDO_CON_ALERGIA_PENDIENTE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchPedidoFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2");
    expect(result.alergiaDeclarada).toBe(true);
    expect(result.puedeAsegurarSeguridad).toBe(false);
  });
});

describe("crearPedidoFnb", () => {
  it("hace POST real con items y flag de alergia", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pedidos-fnb");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({
        roomId: "205",
        items: [{ nombre: "Ensalada César", notas: "sin nueces" }],
        notas: "Entregar rápido",
        alergiaDeclarada: true,
      });
      return new Response(JSON.stringify(PEDIDO_CON_ALERGIA_PENDIENTE), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearPedidoFnb(fetchImpl, "http://api.local", "tok", "prop-1", {
      roomId: "205",
      items: [{ nombre: "Ensalada César", notas: "sin nueces" }],
      notas: "Entregar rápido",
      alergiaDeclarada: true,
    });
    expect(result.id).toBe("pedido-2");
  });

  it("propaga el mensaje de error real del servidor en un 400", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "items: se esperaba un arreglo de 1 a 50 elementos." }), { status: 400 })) as unknown as typeof fetch;
    await expect(crearPedidoFnb(fetchImpl, "http://api.local", "tok", "prop-1", { items: [] })).rejects.toThrow(/items: se esperaba un arreglo/);
  });
});

describe("confirmarCocinaFnb", () => {
  it("hace POST real a .../confirmar-cocina con nota opcional", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pedidos-fnb/pedido-2/confirmar-cocina");
      expect(JSON.parse(init!.body as string)).toEqual({ nota: "Revisado sin nueces." });
      return new Response(JSON.stringify({ ...PEDIDO_CON_ALERGIA_PENDIENTE, cocineroConfirmoPor: "user-9", puedeAsegurarSeguridad: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await confirmarCocinaFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2", "Revisado sin nueces.");
    expect(result.cocineroConfirmoPor).toBe("user-9");
    expect(result.puedeAsegurarSeguridad).toBe(true);
  });

  it("sin nota manda body vacío", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({});
      return new Response(JSON.stringify(PEDIDO_CON_ALERGIA_PENDIENTE), { status: 200 });
    }) as unknown as typeof fetch;
    await confirmarCocinaFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2");
  });
});

describe("asegurarSeguridadFnb", () => {
  it("hace POST real a .../asegurar-seguridad", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/pedidos-fnb/pedido-2/asegurar-seguridad");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ...PEDIDO_CON_ALERGIA_PENDIENTE, seguridadAseguradaEn: "2026-01-02T00:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await asegurarSeguridadFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2");
    expect(result.seguridadAseguradaEn).toBe("2026-01-02T00:00:00.000Z");
  });

  it("propaga el 409 real de la guarda de alergias sin fingir éxito", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message:
              "No se puede asegurar al huésped que el platillo es seguro: el pedido tiene una alergia/restricción alimentaria declarada y todavía no tiene confirmación humana del cocinero (REQ-AB-004).",
          }),
          { status: 409 },
        ),
    ) as unknown as typeof fetch;
    await expect(asegurarSeguridadFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2")).rejects.toThrow(HotelesAdminError);
    await expect(asegurarSeguridadFnb(fetchImpl, "http://api.local", "tok", "prop-1", "pedido-2")).rejects.toThrow(/confirmación humana del cocinero/);
  });
});

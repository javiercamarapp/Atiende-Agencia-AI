// Comandas al POS: cliente HTTP + funciones puras (texto para capturar en SoftRestaurant, mascara de telefono, antiguedad, insignias).
import { describe, expect, it, vi } from "vitest";
import {
  antiguedadTexto,
  etiquetaInsigniaPedido,
  fetchComandas,
  fetchEstadosComandaPorPedido,
  fijarModoPos,
  fijarUmbralCapturaManual,
  marcarComandaCapturada,
  referenciaPedido,
  telefonoEnmascarado,
  textoParaPos,
} from "../src/verticals/restaurantes/lib/pos-comandas-client.ts";
import type { ComandaWire } from "../src/verticals/restaurantes/lib/pos-comandas-client.ts";

const COMANDA: ComandaWire = {
  id: "c1",
  propertyId: "p1",
  orderId: "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c01",
  estado: "captura_manual",
  intentos: 5,
  maxIntentos: 5,
  folio: null,
  ultimoError: "rechazada:producto_sin_codigo_pos",
  notaCaptura: null,
  capturadoEn: null,
  creadoEn: "2026-10-04T16:00:00.000Z",
  totalPedido: 345.5,
  comanda: {
    sucursal: "T2",
    tipo: "domicilio",
    cliente: { nombre: "Ana Torres", telefono: "9991112222" },
    direccion: { texto: "Calle 60 #100, Centro", colonia: "Centro", referencias: "Portón negro" },
    formaPago: "tarjeta",
    propina: 20,
    items: [
      { codigo: "TAQ-001", cantidad: 2, nombre: "Tacos de bistec", modificadores: [{ codigo: "MOD-SIN-CEBOLLA", nombre: "Sin cebolla" }], nota: "bien dorados" },
      { codigo: "BEB-003", cantidad: 1, modificadores: [] },
    ],
    notas: "Tocar el timbre",
  },
};

function respuesta(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("textoParaPos", () => {
  it("sigue el orden de captura: sucursal y tipo, cliente con telefono completo, direccion, renglones con codigo POS y modificadores, pago, propina y notas", () => {
    const t = textoParaPos(COMANDA).split("\n");
    expect(t[0]).toBe("COMANDA 6129984C - SUCURSAL T2 - DOMICILIO");
    expect(t).toContain("Cliente: Ana Torres");
    expect(t).toContain("Telefono: 9991112222");
    expect(t).toContain("Direccion: Calle 60 #100, Centro");
    expect(t).toContain("Colonia: Centro");
    expect(t).toContain("Referencias: Portón negro");
    expect(t).toContain("1. 2 x TAQ-001 (Tacos de bistec)");
    expect(t).toContain("   + MOD-SIN-CEBOLLA (Sin cebolla)");
    expect(t).toContain("   Nota: bien dorados");
    expect(t).toContain("2. 1 x BEB-003");
    expect(t).toContain("Forma de pago: Tarjeta");
    expect(t).toContain("Propina: $20.00 (solo con tarjeta)");
    expect(t).toContain("Notas: Tocar el timbre");
    // La comanda nunca cobra: no hay total ni "pagado".
    expect(t.join("\n")).not.toMatch(/total|pagado|345/i);
    expect(t.indexOf("Telefono: 9991112222")).toBeLessThan(t.indexOf("1. 2 x TAQ-001 (Tacos de bistec)"));
  });

  it("para recoger no imprime direccion y sin propina no la menciona", () => {
    const t = textoParaPos({ ...COMANDA, comanda: { ...COMANDA.comanda, tipo: "recoger", direccion: undefined, propina: undefined, formaPago: "efectivo" } });
    expect(t).toContain("PARA RECOGER");
    expect(t).not.toContain("Direccion");
    expect(t).not.toContain("Propina");
    expect(t).toContain("Forma de pago: Efectivo");
  });
});

describe("funciones puras", () => {
  it("telefonoEnmascarado deja solo los ultimos 4 digitos", () => {
    expect(telefonoEnmascarado("9991112222")).toBe("******2222");
    expect(telefonoEnmascarado("+52 999 111 2222")).toBe("********2222");
    expect(telefonoEnmascarado("12")).toBe("****");
  });

  it("referenciaPedido: 8 caracteres del id en mayusculas", () => {
    expect(referenciaPedido("6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c01")).toBe("6129984C");
  });

  it("antiguedadTexto: minutos, horas y dias", () => {
    const ahora = Date.parse("2026-10-04T16:00:00.000Z");
    expect(antiguedadTexto("2026-10-04T15:59:40.000Z", ahora)).toBe("hace menos de 1 min");
    expect(antiguedadTexto("2026-10-04T15:48:00.000Z", ahora)).toBe("hace 12 min");
    expect(antiguedadTexto("2026-10-04T13:30:00.000Z", ahora)).toBe("hace 2 h 30 min");
    expect(antiguedadTexto("2026-10-01T16:00:00.000Z", ahora)).toBe("hace 3 d");
  });

  it("la insignia de Pedidos: En POS / Capturar a mano / Falló / Enviando", () => {
    expect(etiquetaInsigniaPedido("confirmada")).toBe("En POS");
    expect(etiquetaInsigniaPedido("capturada_manual")).toBe("En POS");
    expect(etiquetaInsigniaPedido("captura_manual")).toBe("Capturar a mano");
    expect(etiquetaInsigniaPedido("fallida")).toBe("Falló");
    expect(etiquetaInsigniaPedido("pendiente")).toBe("Enviando al POS");
    expect(etiquetaInsigniaPedido("enviada")).toBe("Enviando al POS");
  });
});

describe("cliente HTTP", () => {
  it("fetchComandas arma la consulta con estados, sucursal y limite", async () => {
    const f = vi.fn(async () => respuesta({ disponible: true, comandas: [], resumen: {}, requierenAtencion: 0 }));
    await fetchComandas(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", { estados: ["captura_manual", "fallida"], branchId: "b1", limit: 50 });
    expect(f.mock.calls[0]![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/softrestaurant/comandas?estado=captura_manual%2Cfallida&branchId=b1&limit=50");
  });

  it("marcarComandaCapturada manda POST con la nota solo si hay", async () => {
    const f = vi.fn(async () => respuesta({ comanda: COMANDA }));
    await marcarComandaCapturada(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "c1", "T2-000123");
    await marcarComandaCapturada(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "c1", null);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/restaurantes/prop-1/admin/softrestaurant/comandas/c1/capturada");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ nota: "T2-000123" });
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({});
  });

  it("fijarModoPos y fijarUmbralCapturaManual usan PUT con su cuerpo", async () => {
    const f = vi.fn(async () => respuesta({ ok: true }));
    await fijarModoPos(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "apagado");
    await fijarUmbralCapturaManual(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", "b1", 8);
    const [u1, i1] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [u2, i2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect([u1.endsWith("/softrestaurant/config"), i1.method, JSON.parse(String(i1.body))]).toEqual([true, "PUT", { modo: "apagado" }]);
    expect([u2.endsWith("/softrestaurant/umbral-captura-manual"), i2.method, JSON.parse(String(i2.body))]).toEqual([true, "PUT", { branchId: "b1", minutos: 8 }]);
  });

  it("fetchEstadosComandaPorPedido: sin ids no llama; con ids manda hasta 100", async () => {
    const f = vi.fn(async () => respuesta({ disponible: true, estados: { o1: "captura_manual" } }));
    expect(await fetchEstadosComandaPorPedido(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", [])).toEqual({ disponible: true, estados: {} });
    expect(f).not.toHaveBeenCalled();
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    await fetchEstadosComandaPorPedido(f as unknown as typeof fetch, "https://api.test", "tok", "prop-1", ids);
    const url = String((f.mock.calls[0] as unknown as [string])[0]);
    expect(url.split("orderIds=")[1]!.split(",")).toHaveLength(100);
  });
});

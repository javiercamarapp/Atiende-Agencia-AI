import { describe, expect, it, vi } from "vitest";
import {
  accionGusto,
  actualizarPerfilCliente,
  borrarDomicilio,
  borrarMemoriaCliente,
  exportarDatosCliente,
  fetchCustomerDetail,
  fetchCustomers,
  fetchFichaCliente,
  fetchPoliticaReincidencia,
  guardarDomicilio,
  guardarPoliticaReincidencia,
  marcarPedidoFalso,
} from "../src/verticals/restaurantes/lib/customers-client.ts";

describe("fetchCustomers", () => {
  it("aplica search/limit/cursor como query params", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/restaurantes/prop-1/admin/customers");
      expect(parsed.searchParams.get("search")).toBe("ana");
      return new Response(JSON.stringify({ customers: [{ id: "c1", name: "Ana", phone: "9990000000", orderCount: 2 }], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchCustomers(fetchImpl, "http://api.local", "tok", "prop-1", { search: "ana" });
    expect(result.customers).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe("fetchCustomerDetail", () => {
  it("mapea la ficha real (isNew:false) tal cual, sin inventar campos", async () => {
    const detail = { isNew: false, name: "Ana", orderCount: 2, addresses: [], lastOrderItems: null, frequentItems: [], tier: "GOLD", agentNotes: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ customer: detail }), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "c1");
    expect(result).toEqual(detail);
  });

  it("404 -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Cliente no encontrado." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchCustomerDetail(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Cliente no encontrado.");
  });
});

describe("Cliente 360: cliente de la ficha completa", () => {
  it("cada operacion llama a su ruta real con el metodo y el cuerpo correctos", async () => {
    const llamadas: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ficha: {}, policy: { umbralNoRecogidos: 2, ventanaDias: 90 }, datos: {}, resultado: { domiciliosBorrados: 1, gustosBorrados: 2 }, id: "x", ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const args = [fetchImpl, "http://api.local", "tok", "prop-1"] as const;
    await fetchFichaCliente(...args, "c1");
    await actualizarPerfilCliente(...args, "c1", { name: "Ana", fechaNacimientoDia: 3, fechaNacimientoMes: 4 });
    await guardarDomicilio(...args, "c1", null, { address: "Calle 1" });
    await guardarDomicilio(...args, "c1", "a1", { is_default: true });
    await borrarDomicilio(...args, "c1", "a1");
    await accionGusto(...args, "c1", { accion: "descartar", prefId: "g1" });
    await marcarPedidoFalso(...args, "c1", "o1", true);
    await fetchPoliticaReincidencia(...args);
    await guardarPoliticaReincidencia(...args, { umbralNoRecogidos: 3, ventanaDias: 60 });
    await exportarDatosCliente(...args, "c1");
    expect(await borrarMemoriaCliente(...args, "c1")).toEqual({ domiciliosBorrados: 1, gustosBorrados: 2 });
    const base = "http://api.local/v1/restaurantes/prop-1/admin/customers";
    expect(llamadas.map((l) => `${l.method} ${l.url.replace(base, "")}`)).toEqual([
      "GET /c1/ficha",
      "PATCH /c1",
      "POST /c1/addresses",
      "PATCH /c1/addresses/a1",
      "DELETE /c1/addresses/a1",
      "POST /c1/preferences",
      "POST /c1/orders/o1/falso",
      "GET /policy",
      "PUT /policy",
      "GET /c1/arco-export",
      "POST /c1/borrar-memoria",
    ]);
    expect(llamadas[6]!.body).toEqual({ falso: true });
    expect(llamadas[8]!.body).toEqual({ umbralNoRecogidos: 3, ventanaDias: 60 });
  });

  it("un 503 'no disponible aun' llega como error legible (la pantalla lo traduce a estado honesto)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No disponible aún: requiere la migración 049." }), { status: 503 })) as unknown as typeof fetch;
    await expect(fetchFichaCliente(fetchImpl, "http://api.local", "tok", "prop-1", "c1")).rejects.toThrow("No disponible aún");
  });
});

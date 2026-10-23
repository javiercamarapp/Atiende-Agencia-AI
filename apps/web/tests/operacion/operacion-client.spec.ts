import { describe, expect, it, vi } from "vitest";
import { aceptarPedido, despacharPedidos, ErrorOperacion, fetchCola, marcarListo, MENSAJE_RESPUESTA_INESPERADA, nuevaLlave } from "../../src/verticals/restaurantes/lib/operacion-client.ts";

const API = "https://api.test";
const respuesta = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

describe("operacion-client", () => {
  it("fetchCola pide la ruta del contrato con la sucursal y el token", async () => {
    const f = vi.fn(async () => respuesta(200, { pedidos: [], conteos: {}, actualizadoEn: "2026-10-21T20:00:00.000Z" }));
    const r = await fetchCola(f as unknown as typeof fetch, API, "tok", "prop-1");
    expect(r.pedidos).toEqual([]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/v1/restaurantes/prop-1/admin/operacion/cola?propertyId=prop-1`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("las escrituras mandan Idempotency-Key y el cuerpo esperado", async () => {
    const f = vi.fn(async () => respuesta(200, { yaAplicado: false }));
    await aceptarPedido(f as unknown as typeof fetch, API, "tok", "prop-1", "ord 1", "llave-1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/v1/restaurantes/prop-1/admin/orders/ord%201/status`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "preparando" });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("llave-1");

    await marcarListo(f as unknown as typeof fetch, API, "tok", "prop-1", "ord-1", "llave-2");
    const [url2, init2] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url2).toBe(`${API}/v1/restaurantes/prop-1/admin/orders/ord-1/listo`);
    expect(init2.method).toBe("POST");
  });

  it("conserva status y code del error: 409 estado_cambio y 501 no_implementado", async () => {
    const f409 = vi.fn(async () => respuesta(409, { code: "estado_cambio", message: "El pedido ya cambió." }));
    const e1 = await aceptarPedido(f409 as unknown as typeof fetch, API, "t", "p", "o", "k").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ErrorOperacion);
    expect((e1 as ErrorOperacion).esEstadoCambio).toBe(true);

    const f501 = vi.fn(async () => respuesta(501, { code: "no_implementado", message: "No disponible aún." }));
    const e2 = await fetchCola(f501 as unknown as typeof fetch, API, "t", "p").catch((e: unknown) => e);
    expect((e2 as ErrorOperacion).esNoDisponible).toBe(true);
    expect((e2 as ErrorOperacion).message).toBe("No disponible aún.");
  });

  it("nuevaLlave genera llaves distintas", () => {
    expect(nuevaLlave()).not.toBe(nuevaLlave());
  });

  it("despacho: una respuesta 200 sin resultados validos es «respuesta inesperada», no exito ni falta de conexion", async () => {
    const entrada = { pedidos: ["00000000-0000-4000-8000-000000000146"], repartidorId: "00000000-0000-4000-8000-000000000900", etaMin: 35 };
    const malas: unknown[] = [{}, { resultados: null }, { resultados: "x" }, { resultados: [{ pedidoId: "a" }] }, { resultados: [{ pedidoId: "a", resultado: "raro", aviso: "encolado" }] }, null];
    for (const cuerpo of malas) {
      const f = vi.fn(async () => respuesta(200, cuerpo));
      const e = await despacharPedidos(f as unknown as typeof fetch, API, "t", "p", entrada, "k").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ErrorOperacion);
      expect((e as ErrorOperacion).code).toBe("respuesta_inesperada");
      expect((e as ErrorOperacion).message).toBe(MENSAJE_RESPUESTA_INESPERADA);
    }
    const bien = vi.fn(async () => respuesta(200, { resultados: [{ pedidoId: "a", resultado: "despachado", estado: "en_camino", salioAt: null, repartidorId: "r", aviso: "encolado" }] }));
    expect((await despacharPedidos(bien as unknown as typeof fetch, API, "t", "p", entrada, "k")).resultados).toHaveLength(1);
  });
});

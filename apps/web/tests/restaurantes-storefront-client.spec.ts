// R-09: cliente del storefront publico (URLs, cuerpo enviado, errores del servidor sin inventar mensajes).
import { describe, expect, it, vi } from "vitest";
import { crearClienteStorefront, StorefrontError } from "../src/verticals/restaurantes/storefront/storefront-client.ts";

function res(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const DATOS = { sessionId: "sesion-web-0001-abcdef", items: [{ product_id: "p1", requested_quantity: 2 }], canal: "recoger" as const, metodoPago: "efectivo" as const };

describe("crearClienteStorefront", () => {
  it("construye las URLs publicas, codificando el slug y el token", async () => {
    const f = vi.fn().mockResolvedValue(res({}));
    const c = crearClienteStorefront("https://api.test/", "los taquitos", f as unknown as typeof fetch);
    await c.sucursales();
    await c.menu("fco montejo");
    await c.rastreo("t1.a.b");
    expect(f.mock.calls.map((x) => x[0])).toEqual([
      "https://api.test/v1/restaurantes/los%20taquitos/storefront",
      "https://api.test/v1/restaurantes/los%20taquitos/storefront/fco%20montejo/menu",
      "https://api.test/v1/restaurantes/los%20taquitos/storefront/track/t1.a.b",
    ]);
  });

  it("cotizar manda solo lo necesario: la promo solo viaja al recoger y nunca un precio", async () => {
    const f = vi.fn().mockResolvedValue(res({ quote: {}, quote_hash: null, promo: null }));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    await c.cotizar("centro", { ...DATOS, codigoPromo: " LUNES ", mayorDeEdad: true });
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ session_id: DATOS.sessionId, canal: "recoger", promo_code: "LUNES", adult_confirmed: true, payment_method: "efectivo" });
    expect(Object.keys(body)).not.toContain("price");
    expect(Object.keys(body)).not.toContain("total");
    await c.cotizar("centro", { ...DATOS, canal: "domicilio", codigoPromo: "LUNES" });
    expect(JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string).promo_code).toBeUndefined();
  });

  it("crearPedido: direccion solo a domicilio, propina solo si es mayor a 0, correo vacio no se manda", async () => {
    const f = vi.fn().mockResolvedValue(res({ rastreo_token: "t1.x.y" }));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    await c.crearPedido("centro", DATOS, { nombre: "Ana", telefono: "9991234567", correo: " ", direccion: "Calle 1", propina: 0, aceptaAviso: true }, "a".repeat(32));
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.customer_address).toBeUndefined();
    expect(body.propina).toBeUndefined();
    expect(body.customer_email).toBeUndefined();
    expect(body.quote_hash).toBe("a".repeat(32));
    // La casilla del aviso de privacidad viaja al servidor (que la exige y guarda la evidencia).
    expect(body.acepta_aviso_privacidad).toBe(true);
    await c.crearPedido("centro", { ...DATOS, canal: "domicilio" }, { nombre: "Ana", telefono: "9991234567", direccion: "Calle 1", propina: 20, aceptaAviso: true }, null);
    const b2 = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string);
    expect(b2).toMatchObject({ customer_address: "Calle 1", propina: 20 });
  });

  it("crearPedido sin la casilla marcada manda false (el servidor responde 400 y no crea el pedido)", async () => {
    const f = vi.fn().mockResolvedValue(res({ rastreo_token: "t" }));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    await c.crearPedido("centro", DATOS, { nombre: "Ana", telefono: "9991234567", aceptaAviso: false }, null);
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).acepta_aviso_privacidad).toBe(false);
  });

  it("crearPedido: la casilla opcional de promociones solo viaja cuando esta marcada (por omision NO se manda nada)", async () => {
    const f = vi.fn().mockResolvedValue(res({ rastreo_token: "t" }));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    const cuerpoDe = (i: number) => JSON.parse((f.mock.calls[i]![1] as RequestInit).body as string);
    await c.crearPedido("centro", DATOS, { nombre: "Ana", telefono: "9991234567", aceptaAviso: true }, null);
    await c.crearPedido("centro", DATOS, { nombre: "Ana", telefono: "9991234567", aceptaAviso: true, aceptaPromociones: false }, null);
    await c.crearPedido("centro", DATOS, { nombre: "Ana", telefono: "9991234567", aceptaAviso: true, aceptaPromociones: true }, null);
    expect(cuerpoDe(0).acepta_promociones).toBeUndefined();
    expect(cuerpoDe(1).acepta_promociones).toBeUndefined();
    expect(cuerpoDe(2).acepta_promociones).toBe(true);
  });

  it("propaga el mensaje real del servidor y el motivo de la maquina de estados", async () => {
    const f = vi.fn().mockResolvedValue(res({ code: "validation_error", message: "La cotización ya venció.", motivo: "cotizacion_vencida" }, 400));
    const c = crearClienteStorefront("https://api.test", "demo", f as unknown as typeof fetch);
    await expect(c.crearPedido("centro", DATOS, { nombre: "A", telefono: "1", aceptaAviso: true }, null)).rejects.toMatchObject({ message: "La cotización ya venció.", status: 400, motivo: "cotizacion_vencida" });
  });

  it("429 muestra un mensaje de espera; cuerpo no JSON usa el mensaje generico", async () => {
    const c429 = crearClienteStorefront("https://api.test", "demo", vi.fn().mockResolvedValue(res({}, 429)) as unknown as typeof fetch);
    await expect(c429.menu("x")).rejects.toThrow(/Espera un minuto/);
    const malo = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("no json"); } } as unknown as Response);
    const c = crearClienteStorefront("https://api.test", "demo", malo as unknown as typeof fetch);
    const err = await c.menu("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorefrontError);
    expect((err as StorefrontError).message).toBe("No pudimos cargar el menú.");
  });
});

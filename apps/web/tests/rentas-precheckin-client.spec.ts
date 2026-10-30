// Rn-P3-08 -- cliente publico del pre-check-in: rutas, cuerpos, mapeo y errores con el mensaje real del servidor.
import { describe, expect, it, vi } from "vitest";
import { PrecheckinError, capturarPrecheckin, fetchInfoPrecheckin, verificarReserva } from "../src/verticals/rentas/lib/precheckin-client.ts";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("precheckin-client", () => {
  it("info, verificar y capturar usan las rutas publicas sin Authorization y mapean snake_case", async () => {
    const llamadas: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/verificar")) return ok({ estado: "ok", token: "T".repeat(43), propiedad: "Casa", unidad: "Depa", check_in: "2027-03-10", check_out: "2027-03-12", ya_capturado: false });
      if (url.endsWith("/capturar")) return ok({ estado: "ok", mensaje: "Listo" });
      return ok({ propiedad: "Casa", organizacion: "Gestora", reglamento: null, aviso: { version: "v1", titulo: "Aviso", parrafos: ["x"] } });
    }) as unknown as typeof fetch;
    expect((await fetchInfoPrecheckin(fetchImpl, "http://api.local", "p-1")).organizacion).toBe("Gestora");
    expect(await verificarReserva(fetchImpl, "http://api.local", "p-1", "HMAB12CD34", "0123")).toEqual({ estado: "ok", token: "T".repeat(43), propiedad: "Casa", unidad: "Depa", checkIn: "2027-03-10", checkOut: "2027-03-12", yaCapturado: false });
    await capturarPrecheckin(fetchImpl, "http://api.local", "p-1", { token: "T".repeat(43), correo: "a@b.co", whatsapp: "  ", aceptaPrivacidad: true, aceptaReglamento: false });
    expect(llamadas.map((l) => `${l.method} ${l.url}`)).toEqual([
      "GET http://api.local/rentas/precheckin/p-1",
      "POST http://api.local/rentas/precheckin/p-1/verificar",
      "POST http://api.local/rentas/precheckin/p-1/capturar",
    ]);
    for (const l of llamadas) expect(Object.keys(l.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(llamadas[1]!.body).toEqual({ codigo: "HMAB12CD34", ultimos4: "0123" });
    expect(llamadas[2]!.body).toMatchObject({ whatsapp: null, aceptaPrivacidad: true });
  });

  it("un dato que no coincide es un resultado (estado invalido), no una excepcion; los errores HTTP traen el mensaje real y el status", async () => {
    const invalido = vi.fn(async () => ok({ estado: "invalido", mensaje: "No pudimos validar tus datos." })) as unknown as typeof fetch;
    expect(await verificarReserva(invalido, "http://api.local", "p", "X", "0000")).toEqual({ estado: "invalido", mensaje: "No pudimos validar tus datos." });
    const bloqueado = vi.fn(async () => ok({ message: "Demasiados intentos con ese código." }, 429)) as unknown as typeof fetch;
    await expect(verificarReserva(bloqueado, "http://api.local", "p", "X", "0000")).rejects.toMatchObject({ message: "Demasiados intentos con ese código.", status: 429 });
    const sinMensaje = vi.fn(async () => ok({}, 500)) as unknown as typeof fetch;
    await expect(fetchInfoPrecheckin(sinMensaje, "http://api.local", "p")).rejects.toBeInstanceOf(PrecheckinError);
  });
});

// Cliente del login del repartidor por celular (docs/LOGIN-CHOFER-WHATSAPP.md): normalizacion y llamadas de red con fetch inyectado.
import { describe, expect, it, vi } from "vitest";
import { consultarDisponibilidadLoginCelular, formatearCelular, normalizarCelular, normalizarCodigo, solicitarCodigoCelular, verificarCodigoCelular } from "../src/verticals/restaurantes/lib/login-telefono-client.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizarCelular / normalizarCodigo", () => {
  it("acepta las formas reales y devuelve 10 digitos", () => {
    for (const f of ["9991230001", "+52 999 123 0001", "52-999-123-0001", "521 999 123 0001", "(999) 123-0001"]) expect(normalizarCelular(f), f).toBe("9991230001");
  });
  it("rechaza longitudes, prefijos y letras", () => {
    for (const m of ["", "123", "99912300011", "+15551234567", "0991230001", "999abc0001"]) expect(normalizarCelular(m), m).toBeNull();
  });
  it("formatea y normaliza el codigo", () => {
    expect(formatearCelular("9991230001")).toBe("999 123 0001");
    expect(normalizarCodigo("123 456")).toBe("123456");
    for (const m of ["12345", "1234567", "abcdef", ""]) expect(normalizarCodigo(m)).toBeNull();
  });
});

describe("consultarDisponibilidadLoginCelular", () => {
  it("true solo si el servidor lo dice; error de red o 5xx -> false (nunca asume disponible)", async () => {
    expect(await consultarDisponibilidadLoginCelular(vi.fn(async () => json({ disponible: true })) as never, "https://api.test/")).toBe(true);
    expect(await consultarDisponibilidadLoginCelular(vi.fn(async () => json({ disponible: false })) as never, "https://api.test")).toBe(false);
    expect(await consultarDisponibilidadLoginCelular(vi.fn(async () => json({}, 500)) as never, "https://api.test")).toBe(false);
    expect(await consultarDisponibilidadLoginCelular(vi.fn(async () => { throw new Error("red"); }) as never, "https://api.test")).toBe(false);
  });
});

describe("solicitarCodigoCelular", () => {
  it("200 -> ok con la vigencia; manda solo el numero de 10 digitos", async () => {
    const f = vi.fn(async () => json({ ok: true, expiraEnSegundos: 300 }));
    const r = await solicitarCodigoCelular(f as never, "https://api.test", "9991230001");
    expect(r).toEqual({ ok: true, expiraEnSegundos: 300 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/auth/login-telefono/solicitar");
    expect(JSON.parse(String(init.body))).toEqual({ telefono: "9991230001" });
  });
  it("503 -> no_disponible; 429 -> demasiados con el mensaje del servidor; 400 -> invalido; red -> red", async () => {
    expect(await solicitarCodigoCelular(vi.fn(async () => json({ message: "x" }, 503)) as never, "https://a", "9991230001")).toMatchObject({ ok: false, motivo: "no_disponible" });
    expect(await solicitarCodigoCelular(vi.fn(async () => json({ message: "Espera unos minutos." }, 429)) as never, "https://a", "9991230001")).toEqual({ ok: false, motivo: "demasiados", mensaje: "Espera unos minutos." });
    expect(await solicitarCodigoCelular(vi.fn(async () => json({ message: "Escribe tu celular." }, 400)) as never, "https://a", "1")).toMatchObject({ ok: false, motivo: "invalido" });
    expect(await solicitarCodigoCelular(vi.fn(async () => { throw new Error("offline"); }) as never, "https://a", "9991230001")).toMatchObject({ ok: false, motivo: "red" });
  });
});

describe("verificarCodigoCelular", () => {
  it("200 -> sesion con token, refresh y organizaciones", async () => {
    const f = vi.fn(async () => json({ token: "t", refreshToken: "r", email: "c@x.test", fullName: "Chofer", organizations: [{ id: "o", slug: "s", nombre: "N", vertical: "restaurantes", rol: "repartidor" }] }));
    const r = await verificarCodigoCelular(f as never, "https://api.test", "9991230001", "123456");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session).toMatchObject({ token: "t", refreshToken: "r", email: "c@x.test", fullName: "Chofer" });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ telefono: "9991230001", codigo: "123456" });
  });
  it("401 -> mensaje fijo sin distinguir causa; 429 y 503 y red", async () => {
    expect(await verificarCodigoCelular(vi.fn(async () => json({ message: "lo que sea" }, 401)) as never, "https://a", "9991230001", "000000")).toEqual({ ok: false, motivo: "invalido", mensaje: "Código incorrecto o vencido. Pide uno nuevo." });
    expect(await verificarCodigoCelular(vi.fn(async () => json({}, 429)) as never, "https://a", "9991230001", "000000")).toMatchObject({ ok: false, motivo: "demasiados" });
    expect(await verificarCodigoCelular(vi.fn(async () => json({}, 503)) as never, "https://a", "9991230001", "000000")).toMatchObject({ ok: false, motivo: "no_disponible" });
    expect(await verificarCodigoCelular(vi.fn(async () => { throw new Error("x"); }) as never, "https://a", "9991230001", "000000")).toMatchObject({ ok: false, motivo: "red" });
  });
});

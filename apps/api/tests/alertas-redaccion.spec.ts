// Redaccion de datos sensibles de alertas salientes (PL-04). Puro, sin red.
import { describe, expect, it } from "vitest";
import { MAX_LARGO_CADENA, redactarTexto, redactarValor } from "../src/alertas/redaccion.ts";

describe("redactarTexto", () => {
  it("redacta correos, bearer, JWT, llaves con prefijo y URIs con credenciales", () => {
    const sucio = [
      "falla para juan.perez@gmail.com",
      "Authorization: Bearer abcdef1234567890abcdef",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.firma_abcdefgh",
      "key sk_live_ABCDEFGHIJKLMNOP1234",
      "db postgres://admin:sup3rS3cret@db.example.com:5432/app",
    ].join(" | ");
    const limpio = redactarTexto(sucio);
    expect(limpio).not.toContain("juan.perez");
    expect(limpio).not.toContain("abcdef1234567890abcdef");
    expect(limpio).not.toContain("eyJhbGci");
    expect(limpio).not.toContain("sk_live_");
    expect(limpio).not.toContain("sup3rS3cret");
    expect(limpio).not.toContain("admin:");
    expect(limpio).toContain("db.example.com");
  });

  it("redacta clave=valor sensible dentro de texto libre", () => {
    const limpio = redactarTexto("fallo con password=hunter2 y api_key: ZZZ999 en el job");
    expect(limpio).not.toContain("hunter2");
    expect(limpio).not.toContain("ZZZ999");
    expect(limpio).toContain("en el job");
  });

  it("redacta telefonos y tarjetas pero conserva fechas ISO y rutas de cron", () => {
    const limpio = redactarTexto("cliente +52 55 1234 5678 tarjeta 4242 4242 4242 4242 fecha 2026-09-30 cron /internal/hoteles/identidad-purga");
    expect(limpio).not.toContain("1234 5678");
    expect(limpio).not.toContain("4242");
    expect(limpio).toContain("2026-09-30");
    expect(limpio).toContain("/internal/hoteles/identidad-purga");
  });

  it("redacta tokens largos hex/base64 pero no palabras largas sin digitos", () => {
    const hex = "a".repeat(8) + "1".repeat(8) + "b".repeat(8) + "2".repeat(12);
    expect(redactarTexto(`token ${hex} fin`)).not.toContain(hex);
    const largaSinDigitos = "internal-superadmin-resumen-diario-persistencia";
    expect(redactarTexto(largaSinDigitos)).toBe(largaSinDigitos);
  });

  it("trunca cadenas largas", () => {
    expect(redactarTexto("x ".repeat(2000)).length).toBeLessThanOrEqual(MAX_LARGO_CADENA);
  });

  it("deja intacto un mensaje operativo normal", () => {
    const msg = "Cron /internal/hoteles/night-audit con 3 fallos consecutivos (property 3 de 5)";
    expect(redactarTexto(msg)).toBe(msg);
  });
});

describe("redactarValor", () => {
  it("redacta por NOMBRE de clave sin mirar el valor, y recursivamente", () => {
    const salida = redactarValor({ cron: "x", authorization: "lo-que-sea", anidado: { clientSecret: "s", nota: "mail a a@b.com" }, lista: ["a@b.com", 3] }) as Record<string, unknown>;
    expect(salida.cron).toBe("x");
    expect(salida.authorization).toBe("[redactado]");
    expect((salida.anidado as Record<string, unknown>).clientSecret).toBe("[redactado]");
    expect((salida.anidado as Record<string, unknown>).nota).toBe("mail a [correo]");
    expect(salida.lista).toEqual(["[correo]", 3]);
  });

  it("no se cuelga con ciclos (tope de profundidad) ni lanza con Error o tipos raros", () => {
    const ciclo: Record<string, unknown> = {};
    ciclo.self = ciclo;
    expect(() => redactarValor(ciclo)).not.toThrow();
    expect(redactarValor(new Error("falla de a@b.com"))).toBe("falla de [correo]");
    expect(redactarValor(() => 1)).toBe("[no_serializable]");
    expect(redactarValor(undefined)).toBeNull();
  });
});

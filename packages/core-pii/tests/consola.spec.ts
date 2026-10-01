// instalarScrubEnConsola: ninguna salida de console.* sale sin scrub (PL-10).
import { describe, expect, it } from "vitest";
import { instalarScrubEnConsola, type ConsolaLike } from "../src/index.ts";

function consolaFalsa() {
  const salidas: { metodo: string; args: unknown[] }[] = [];
  const consola = {} as ConsolaLike;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) consola[m] = (...args: unknown[]) => void salidas.push({ metodo: m, args });
  return { consola, salidas };
}

const jwtFalso = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from('{"sub":"1"}').toString("base64url")}.firma_abcdefgh`;

describe("instalarScrubEnConsola", () => {
  it("redacta strings, Errors (con detail de Postgres) y objetos en error/warn/log", () => {
    const { consola, salidas } = consolaFalsa();
    instalarScrubEnConsola(consola);
    const pgErr = Object.assign(new Error("duplicate key"), { code: "23505", detail: "Key (email)=(ana@example.com) already exists." });
    consola.error("cron fallo para +52 55 1234 5678:", pgErr);
    consola.warn({ token: "abc", nota: `jwt ${jwtFalso}` });
    consola.log("tarjeta 4242 4242 4242 4242", 42);
    const texto = JSON.stringify(salidas);
    expect(texto).not.toContain("1234 5678");
    expect(texto).not.toContain("ana@example.com");
    expect(texto).not.toContain(jwtFalso.slice(0, 12));
    expect(texto).not.toContain("4242");
    expect(texto).toContain("23505");
    expect(salidas[2]?.args[1]).toBe(42);
  });

  it("una linea JSON se redacta de forma estructural y sigue siendo JSON valido; los UUID sobreviven", () => {
    const { consola, salidas } = consolaFalsa();
    instalarScrubEnConsola(consola);
    const requestId = "00000000-0000-0000-0000-0000000000a1";
    consola.error(JSON.stringify({ level: "error", requestId, id: 12345678901234, message: "falla ana@example.com" }));
    const linea = salidas[0]?.args[0] as string;
    const parsed = JSON.parse(linea) as Record<string, unknown>;
    expect(parsed.requestId).toBe(requestId);
    expect(parsed.id).toBe(12345678901234);
    expect(parsed.message).toBe("falla [correo]");
  });

  it("es idempotente y la funcion devuelta restaura los metodos originales", () => {
    const { consola, salidas } = consolaFalsa();
    const original = consola.error;
    const restaurar = instalarScrubEnConsola(consola);
    const envuelto = consola.error;
    expect(envuelto).not.toBe(original);
    instalarScrubEnConsola(consola);
    expect(consola.error).toBe(envuelto);
    consola.error("ana@example.com");
    expect(salidas).toHaveLength(1);
    restaurar();
    expect(consola.error).toBe(original);
  });

  it("si el scrub falla, no deja pasar el argumento original", () => {
    const { consola, salidas } = consolaFalsa();
    instalarScrubEnConsola(consola);
    const explosivo = {
      get nota(): string {
        throw new Error("getter hostil con ana@example.com");
      },
    };
    consola.error(explosivo);
    expect(JSON.stringify(salidas)).not.toContain("ana@example.com");
    expect(salidas).toHaveLength(1);
  });
});

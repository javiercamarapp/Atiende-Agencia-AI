// Bandera por organizacion del cerebro v2 (migracion 190): lectura con SAVEPOINT; base sin la columna o sin fila = apagada.
import { describe, expect, it } from "vitest";
import { leerCerebroV2 } from "../src/ajustes-agente/repositorio.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const LEER = /select cerebro_v2 from restaurantes\.agent_runtime_settings/i;
const err = (code: string) => Object.assign(new Error(code), { code });

describe("leerCerebroV2", () => {
  it("encendida solo si la fila dice true", async () => {
    await expect(leerCerebroV2(new AbortAwareFakeSession([{ match: LEER, respond: () => [{ cerebro_v2: true }] }]), ORG)).resolves.toBe(true);
    await expect(leerCerebroV2(new AbortAwareFakeSession([{ match: LEER, respond: () => [{ cerebro_v2: false }] }]), ORG)).resolves.toBe(false);
    await expect(leerCerebroV2(new AbortAwareFakeSession([{ match: LEER, respond: () => [] }]), ORG)).resolves.toBe(false);
  });

  it("base sin la 190 (42703) o sin la 055 (42P01): apagada y la transaccion sigue viva", async () => {
    for (const code of ["42703", "42P01"]) {
      const s = new AbortAwareFakeSession([{ match: LEER, respond: () => err(code) }, { match: /select 1/, respond: () => [{ ok: true }] }]);
      await expect(leerCerebroV2(s, ORG)).resolves.toBe(false);
      await expect(s.query("select 1")).resolves.toEqual({ rows: [{ ok: true }] });
      expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    }
  });

  it("un error de otra clase se propaga", async () => {
    await expect(leerCerebroV2(new AbortAwareFakeSession([{ match: LEER, respond: () => err("57014") }]), ORG)).rejects.toThrow();
  });
});

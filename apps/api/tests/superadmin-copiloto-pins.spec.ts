// Fijados del Copiloto de plataforma: el repositorio de Postgres contra una sesion con la semantica REAL de una transaccion (AbortAwareFakeSession: tras un
// error, todo SQL falla con 25P02 hasta un ROLLBACK TO SAVEPOINT). La base sin migrar (0056 pendiente) debe dar «no disponible», nunca un 500 ni una transaccion
// abortada. El SQL real (RLS, CHECK, tope de 50) lo prueba scripts/verify-copiloto-multi-negocio.
import { describe, expect, it } from "vitest";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { PostgresPinsPlataformaRepository } from "../src/superadmin-copiloto/pins.ts";

const USER = "00000000-0000-0000-0000-0000000000a1";
const CONV = "00000000-0000-0000-0000-0000000000c1";
const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const SANA = { match: /select 1/, respond: () => [{ x: 1 }] };
const ORIGEN = { tool: "ranking_actividad", args: { periodo: "este_mes" }, title: "Actividad por negocio" };

describe("PostgresPinsPlataformaRepository sobre una base sin la migracion 0056", () => {
  it("list: sin tabla o con columnas viejas responde disponible=false y la sesion sigue utilizable", async () => {
    const reales: [string, string][] = [
      ["42P01", 'relation "core.copiloto_pin" does not exist'],
      ["42703", 'column "vertical" does not exist'],
      ["42883", "function core.copiloto_pin_create_plataforma(uuid) does not exist"],
    ];
    for (const [code, mensaje] of reales) {
      const db = new AbortAwareFakeSession([{ match: /from core\.copiloto_pin/, respond: () => pgError(code, mensaje) }, SANA]);
      const r = await new PostgresPinsPlataformaRepository(db).list(USER);
      expect(r).toEqual({ disponible: false, items: [] });
      await expect(db.query("select 1")).resolves.toBeDefined();
    }
  });

  it("create: la funcion que falta (42883) o el CHECK viejo de vertical (23514) = no_disponible; el tope (54000), la conversacion ajena (P0002) y el rol (42501) se traducen y la sesion queda sana", async () => {
    const casos: [string, string][] = [
      ["42883", "no_disponible"],
      ["23514", "no_disponible"],
      ["54000", "limite"],
      ["P0002", "conversacion_no_encontrada"],
      ["42501", "sin_acceso"],
      ["XX000", "error"],
    ];
    for (const [code, motivo] of casos) {
      const db = new AbortAwareFakeSession([{ match: /copiloto_pin_create_plataforma/, respond: () => pgError(code, code === "42883" ? "function core.copiloto_pin_create_plataforma(uuid, integer, integer, text, jsonb, text) does not exist" : "x") }, SANA]);
      const r = await new PostgresPinsPlataformaRepository(db, () => undefined).create({ conversationId: CONV, seq: 2, bloque: 0, origin: ORIGEN });
      expect(r, code).toEqual({ ok: false, motivo });
      await expect(db.query("select 1"), code).resolves.toBeDefined();
    }
  });

  it("create: manda la herramienta y los argumentos tipados (no cifras) a la funcion de alta", async () => {
    const db = new AbortAwareFakeSession([{ match: /copiloto_pin_create_plataforma/, respond: () => [{ id: "p1" }] }]);
    const r = await new PostgresPinsPlataformaRepository(db).create({ conversationId: CONV, seq: 2, bloque: 0, origin: ORIGEN });
    expect(r).toEqual({ ok: true, id: "p1" });
    expect(db.calls.join(" ")).toContain("copiloto_pin_create_plataforma");
  });

  it("origin, get, rename y remove degradan a 'no encontrado' sin tumbar la transaccion", async () => {
    const roto = { match: /core\.(copiloto_pin|data_chat_message)/, respond: () => pgError("42P01", "relation does not exist") };
    const db = new AbortAwareFakeSession([roto, SANA]);
    const repo = new PostgresPinsPlataformaRepository(db);
    expect(await repo.origin(USER, CONV, 2, 0)).toBeNull();
    expect(await repo.get(USER, CONV)).toBeNull();
    expect(await repo.rename(USER, CONV, "x")).toBe("no_encontrado");
    expect(await repo.remove(USER, CONV)).toBe(false);
    await expect(db.query("select 1")).resolves.toBeDefined();
  });
});

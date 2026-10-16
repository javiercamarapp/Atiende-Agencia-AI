// QA R2 features-07 y la base SIN migrar: findCompensationCode llama a una funcion de la migracion 077. Si falta (42883), el pedido sigue como
// antes (sin codigo) y la transaccion compartida de la request NO queda abortada (25P02). AbortAwareFakeSession reproduce el estado abortado.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("PostgresRestaurantesRepository.findCompensationCode", () => {
  it("devuelve el codigo vigente de la base migrada", async () => {
    const session = new AbortAwareFakeSession([{ match: /compensacion_codigo_disponible/, respond: () => [{ codigo: "GRACIAS-AB12CD34" }] }]);
    expect(await new PostgresRestaurantesRepository(session).findCompensationCode(ORG, "9991234567")).toBe("GRACIAS-AB12CD34");
  });

  it("sin codigo devuelve null", async () => {
    const session = new AbortAwareFakeSession([{ match: /compensacion_codigo_disponible/, respond: () => [{ codigo: null }] }]);
    expect(await new PostgresRestaurantesRepository(session).findCompensationCode(ORG, "9991234567")).toBeNull();
  });

  it("base sin la 077 (42883): null, y la siguiente consulta de la request NO falla con 25P02", async () => {
    const err = Object.assign(new Error("function restaurantes.compensacion_codigo_disponible(uuid, text) does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /compensacion_codigo_disponible/, respond: () => err },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    expect(await new PostgresRestaurantesRepository(session).findCompensationCode(ORG, "9991234567")).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as siguiente")).resolves.toBeDefined();
  });
});

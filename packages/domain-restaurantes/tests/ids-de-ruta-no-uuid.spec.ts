// QA R2 features-04: un id de ruta que no es uuid ("no-uuid") debe ser "no encontrado" y NUNCA llegar a una columna uuid de Postgres (22P02 -> 500).
// Se prueba con AbortAwareFakeSession: cualquier consulta con un id invalido fallaria con 22P02 y dejaria la transaccion abortada.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const USER = "00000000-0000-0000-0000-0000000000b1";
const ID_VALIDO = "00000000-0000-0000-0000-0000000000c1";

function pg22P02(): Error & { code: string } {
  return Object.assign(new Error('invalid input syntax for type uuid: "no-uuid"'), { code: "22P02" });
}

/** Sesion que se comporta como Postgres: una consulta con un valor que no es uuid lanza 22P02. */
function sesionEstricta(): AbortAwareFakeSession {
  return new AbortAwareFakeSession([{ match: /from restaurantes\.(orders|customers)/, respond: () => pg22P02() }]);
}

describe("ids de ruta que no son uuid -> null (404), sin consultar la base", () => {
  it.each(["no-uuid", "", "123", "00000000-0000-0000-0000-00000000000g", "'; drop table x;--"])("findOrderById(%j) devuelve null", async (id) => {
    const session = sesionEstricta();
    expect(await new PostgresRestaurantesRepository(session).findOrderById(ORG, id)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it("findAssignedOrderById('no-uuid') devuelve null", async () => {
    const session = sesionEstricta();
    expect(await new PostgresRestaurantesRepository(session).findAssignedOrderById(ORG, USER, "no-uuid")).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it("findCustomerById('no-uuid') devuelve null", async () => {
    const session = sesionEstricta();
    expect(await new PostgresRestaurantesRepository(session).findCustomerById(ORG, "no-uuid")).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it("un uuid valido SI consulta la base (el atajo no esconde pedidos reales)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.orders/, respond: () => [] }]);
    expect(await new PostgresRestaurantesRepository(session).findOrderById(ORG, ID_VALIDO)).toBeNull();
    // Desde #467 findOrderById pasa primero por restaurantes.sistema_pedido_por_id (en SAVEPOINT) y, sin resultado, cae a la consulta directa:
    // lo que importa es que un uuid valido SI llega a la base (funcion y consulta directa), a diferencia de uno que no es uuid (0 llamadas).
    expect(session.calls.length).toBeGreaterThan(0);
    expect(session.calls.some((c) => /sistema_pedido_por_id/.test(c))).toBe(true);
    expect(session.calls.some((c) => /^select id, organization_id, property_id/.test(c))).toBe(true);
  });
});

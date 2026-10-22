// PostgresLoginChoferRepository (migracion 0059, docs/LOGIN-CHOFER-WHATSAPP.md): camino feliz, mapeo de filas y -- con una sesion que reproduce
// la semantica de aborto de Postgres -- la compatibilidad con la base sin migrar (42883/42P01/42703) y el rechazo de negocio (P0001).
import { describe, expect, it } from "vitest";
import { LoginChoferNoDisponibleError, LoginChoferTelefonoError, PostgresLoginChoferRepository } from "../src/login-chofer-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const U = "00000000-0000-0000-0000-0000000000aa";
const O = "00000000-0000-0000-0000-0000000000bb";

describe("PostgresLoginChoferRepository: camino feliz", () => {
  it("mapea resolver, reservarIntento, consumir y puedeSolicitar", async () => {
    const session = new AbortAwareFakeSession([
      { match: /chofer_login_resolver/, respond: () => [{ user_id: U, organization_id: O, full_name: "Chofer", property_ids: null }] },
      { match: /chofer_login_reservar_intento/, respond: () => [{ codigo_id: "c1", user_id: U, organization_id: O, code_hash: "h", code_salt: "s", intentos: "2" }] },
      { match: /chofer_login_consumir/, respond: () => [{ id: U, email: "c@x.test", full_name: "Chofer", password_hash: null, created_via: "invite", email_verified_at: null, sessions_revoked_at: null }] },
      { match: /chofer_login_puede_solicitar/, respond: () => [{ ok: "bloqueado" }] },
    ]);
    const repo = new PostgresLoginChoferRepository(session);
    expect(await repo.resolver("+529990000001")).toEqual({ userId: U, organizationId: O, fullName: "Chofer", propertyIds: null });
    expect(await repo.reservarIntento("+529990000001")).toEqual({ codigoId: "c1", userId: U, organizationId: O, codeHash: "h", codeSalt: "s", intentos: 2 });
    expect((await repo.consumir("c1"))?.email).toBe("c@x.test");
    expect(await repo.puedeSolicitar({ telefonoHash: "a", ipHash: null, maxTelefono: 3, maxIp: 10, ventanaSegundos: 900, bloqueoSegundos: 1800 })).toBe("bloqueado");
  });

  it("sin filas -> null; un valor inesperado de limite se trata como 'limitado' (fail-closed)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /chofer_login_resolver/, respond: () => [] },
      { match: /chofer_login_puede_solicitar/, respond: () => [{ ok: "raro" }] },
    ]);
    const repo = new PostgresLoginChoferRepository(session);
    expect(await repo.resolver("+529990000001")).toBeNull();
    expect(await repo.puedeSolicitar({ telefonoHash: "a", ipHash: null, maxTelefono: 3, maxIp: 10, ventanaSegundos: 900, bloqueoSegundos: 1800 })).toBe("limitado");
  });
});

describe("PostgresLoginChoferRepository: vigencia en la base y purga del outbox", () => {
  it("emitir manda los SEGUNDOS de vigencia (la base calcula expires_at con su reloj), no una fecha de la API", async () => {
    const session = new AbortAwareFakeSession([{ match: /chofer_login_emitir/, respond: () => [{ id: "c1" }] }]);
    const repo = new PostgresLoginChoferRepository(session);
    expect(await repo.emitir({ userId: U, organizationId: O, codeHash: "h", codeSalt: "s", ttlSegundos: 300 })).toBe("c1");
    expect(session.calls.some((c) => /chofer_login_emitir/.test(c))).toBe(true);
  });
  it("purgarCodigosVencidos devuelve el conteo; sin la migracion 093 -> LoginChoferNoDisponibleError", async () => {
    const ok = new PostgresLoginChoferRepository(new AbortAwareFakeSession([{ match: /purgar_codigos_acceso_vencidos/, respond: () => [{ n: "2" }] }]));
    expect(await ok.purgarCodigosVencidos()).toBe(2);
    const roto = new PostgresLoginChoferRepository(new AbortAwareFakeSession([{ match: /purgar_codigos_acceso_vencidos/, respond: () => pgError("42883", "function restaurantes.purgar_codigos_acceso_vencidos() does not exist") }]));
    await expect(roto.purgarCodigosVencidos()).rejects.toBeInstanceOf(LoginChoferNoDisponibleError);
  });
});

describe("PostgresLoginChoferRepository: base sin migrar", () => {
  for (const [codigo, mensaje] of [
    ["42883", "function core.chofer_login_plantilla_disponible() does not exist"],
    ["42P01", 'relation "core.chofer_login_codigo" does not exist'],
    ["42703", 'column "x" does not exist'],
  ] as const) {
    it(`${codigo}: LoginChoferNoDisponibleError y la transaccion queda utilizable (SAVEPOINT)`, async () => {
      const session = new AbortAwareFakeSession([
        { match: /chofer_login_plantilla_disponible/, respond: () => pgError(codigo, mensaje) },
        { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
      ]);
      const repo = new PostgresLoginChoferRepository(session);
      await expect(repo.plantillaDisponible()).rejects.toBeInstanceOf(LoginChoferNoDisponibleError);
      await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
    });
  }

  it("un 42883 que NO es 'funcion inexistente' (bug de tipos) no se enmascara como migracion pendiente", async () => {
    const session = new AbortAwareFakeSession([{ match: /chofer_login_resolver/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    const repo = new PostgresLoginChoferRepository(session);
    await expect(repo.resolver("+529990000001")).rejects.not.toBeInstanceOf(LoginChoferNoDisponibleError);
  });
});

describe("PostgresLoginChoferRepository: rechazos de negocio (P0001)", () => {
  it("guardarTelefono sin autoridad o con objetivo no repartidor -> LoginChoferTelefonoError con el mensaje de la base", async () => {
    const session = new AbortAwareFakeSession([
      { match: /chofer_login_telefono_guardar/, respond: () => pgError("P0001", "el telefono de acceso solo aplica a cuentas de repartidor") },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresLoginChoferRepository(session);
    await expect(repo.guardarTelefono(O, U, "+529990000001")).rejects.toBeInstanceOf(LoginChoferTelefonoError);
    await expect(repo.guardarTelefono(O, U, "+529990000001")).rejects.toThrow("solo aplica a cuentas de repartidor");
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

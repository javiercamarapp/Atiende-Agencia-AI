// Consentimiento del aviso de privacidad del checkout (migracion 042): el adaptador Postgres degrada a 'no_disponible' contra una base
// sin migrar SIN abortar la transaccion compartida (AbortAwareFakeSession reproduce 25P02) y propaga cualquier otro error.
import { describe, expect, it } from "vitest";
import { InMemoryPrivacidadRepository, PostgresPrivacidadRepository } from "../src/privacidad/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const ORDER = "00000000-0000-4000-8000-0000000000bb";

describe("PostgresPrivacidadRepository.recordOrderPrivacyConsent", () => {
  it("registra: devuelve la version que decidio la base", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_record_order_privacy_consent/, respond: () => [{ version: "v3" }] }]);
    await expect(new PostgresPrivacidadRepository(session).recordOrderPrivacyConsent(ORG, ORDER, "web")).resolves.toEqual({ outcome: "registrado", noticeVersion: "v3" });
  });

  it("segundo intento del mismo pedido (la funcion devuelve NULL): ya_registrado", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_record_order_privacy_consent/, respond: () => [{ version: null }] }]);
    await expect(new PostgresPrivacidadRepository(session).recordOrderPrivacyConsent(ORG, ORDER, "web")).resolves.toEqual({ outcome: "ya_registrado" });
  });

  it("base sin migrar (42883): no_disponible y la MISMA sesion sigue viva (SAVEPOINT, nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_record_order_privacy_consent/, respond: () => Object.assign(new Error("function restaurantes.system_record_order_privacy_consent(uuid, uuid, text) does not exist"), { code: "42883" }) },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    await expect(new PostgresPrivacidadRepository(session).recordOrderPrivacyConsent(ORG, ORDER, "web")).resolves.toEqual({ outcome: "no_disponible" });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de compatibilidad (p. ej. pedido de otra organizacion, 42501) se propaga: no se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_record_order_privacy_consent/, respond: () => Object.assign(new Error("el pedido no pertenece a la organizacion"), { code: "42501" }) }]);
    await expect(new PostgresPrivacidadRepository(session).recordOrderPrivacyConsent(ORG, ORDER, "web")).rejects.toThrow(/no pertenece/);
  });
});

describe("InMemoryPrivacidadRepository.recordOrderPrivacyConsent (espejo de la base)", () => {
  it("version vigente de la organizacion, idempotente por pedido, 'v1' sin configuracion y 'no_disponible' sin migrar", async () => {
    const repo = new InMemoryPrivacidadRepository();
    await expect(repo.recordOrderPrivacyConsent(ORG, ORDER, "web")).resolves.toEqual({ outcome: "registrado", noticeVersion: "v1" });
    await expect(repo.recordOrderPrivacyConsent(ORG, ORDER, "web")).resolves.toEqual({ outcome: "ya_registrado" });
    expect(repo.pedidoConsents.size).toBe(1);
    repo.consentimientoPedidosMigrado = false;
    await expect(repo.recordOrderPrivacyConsent(ORG, "00000000-0000-4000-8000-0000000000cc", "web")).resolves.toEqual({ outcome: "no_disponible" });
  });
});

// L-30/L-32: PostgresAvisosSistemaRepository contra una sesion que reproduce el estado ABORTADO real de Postgres
// (AbortAwareFakeSession). Con la base sin la migracion 034 (42883/42P01/42703) el resultado es "no disponible" y la
// sesion queda UTILIZABLE para lo que siga (SAVEPOINT / ROLLBACK TO SAVEPOINT); un error distinto se propaga.
import { describe, expect, it } from "vitest";
import { PostgresAvisosSistemaRepository } from "../src/avisos-sistema-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresAvisosSistemaRepository.retamizarCarteraKyc", () => {
  it("mapea una fila por organizacion a numeros", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /system_retamizar_cartera_kyc/,
        respond: () => [{ out_organization_id: "org-1", out_periodo: "2024-06", out_evaluadas: "4", out_empeoradas: "3", out_proveedores_empeorados: "2" }],
      },
    ]);
    const r = await new PostgresAvisosSistemaRepository(session).retamizarCarteraKyc();
    expect(r).toEqual({ disponible: true, organizaciones: [{ organizationId: "org-1", periodo: "2024-06", evaluadas: 4, empeoradas: 3, proveedoresEmpeorados: 2 }] });
  });

  it("sin filas (edicion ya evaluada o sin lista) es disponible y vacio", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_retamizar_cartera_kyc/, respond: () => [] }]);
    expect(await new PostgresAvisosSistemaRepository(session).retamizarCarteraKyc()).toEqual({ disponible: true, organizaciones: [] });
  });

  it("base sin la migracion 034 (42883): no disponible y la transaccion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_retamizar_cartera_kyc/, respond: () => pgError("42883", "function licitaciones.system_retamizar_cartera_kyc() does not exist") },
      { match: /select 1 as ok/, respond: () => [{ ok: 1 }] },
    ]);
    const r = await new PostgresAvisosSistemaRepository(session).retamizarCarteraKyc();
    expect(r).toEqual({ disponible: false, organizaciones: [] });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada).
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("tabla de la lista 69-B inexistente (42P01): no disponible", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_retamizar_cartera_kyc/, respond: () => pgError("42P01", 'relation "despachos.efos_ingesta" does not exist') }]);
    expect((await new PostgresAvisosSistemaRepository(session).retamizarCarteraKyc()).disponible).toBe(false);
  });

  it("un error de Postgres distinto (p. ej. 42501 sesion con sub) se propaga, no se disfraza de no disponible", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_retamizar_cartera_kyc/, respond: () => pgError("42501", "solo para la sesion de sistema") }]);
    await expect(new PostgresAvisosSistemaRepository(session).retamizarCarteraKyc()).rejects.toMatchObject({ code: "42501" });
  });
});

describe("PostgresAvisosSistemaRepository.contarDocumentosPorVencer", () => {
  it("devuelve el conteo", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_count_company_documents_expiring/, respond: () => [{ n: 3 }] }]);
    expect(await new PostgresAvisosSistemaRepository(session).contarDocumentosPorVencer("org-1", "2026-10-02", 30)).toBe(3);
  });

  it("base sin la migracion 034: null (no disponible) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_count_company_documents_expiring/, respond: () => pgError("42883", "function licitaciones.system_count_company_documents_expiring(uuid, date, integer) does not exist") },
      { match: /select 1 as ok/, respond: () => [{ ok: 1 }] },
    ]);
    expect(await new PostgresAvisosSistemaRepository(session).contarDocumentosPorVencer("org-1", "2026-10-02", 30)).toBeNull();
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("parametros invalidos (22023) se propagan", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_count_company_documents_expiring/, respond: () => pgError("22023", "parametros invalidos") }]);
    await expect(new PostgresAvisosSistemaRepository(session).contarDocumentosPorVencer("org-1", "2026-10-02", 0)).rejects.toMatchObject({ code: "22023" });
  });
});

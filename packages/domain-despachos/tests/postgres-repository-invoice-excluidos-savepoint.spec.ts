// D-P3-23 (migración 026): los agregados excluyen el CFDI cuya revisión se rechazó. La columna `excluido_por_revision` no existe en la base sin migrar:
// `listInvoices` corre en la transacción compartida del request, así que el fallback exige SAVEPOINT (AbortAwareFakeSession reproduce el estado
// abortado de Postgres real: una sesión falsa plana NO sirve).
import { describe, expect, it } from "vitest";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";
const CON_FILTRO = /select \* from despachos\.invoice where property_id = \$1 and not excluido_por_revision/i;
const SIN_FILTRO = /select \* from despachos\.invoice where property_id = \$1 order by/i;

function fila(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, organization_id: "o1", property_id: PROPERTY_ID, folio_fiscal: `f-${id}`, tipo: "I", rfc_emisor: "AAA010101AAA", rfc_receptor: "BBB010101BBB", emisor_nombre: null,
    subtotal: "100", total: "116", iva: "16", descuento: "0", categoria: "sin_clasificar", confianza: null, valido: true, issues: [], warnings: [], requires_human_review: false,
    diot: { proveedoresReportables: [], reportable: false }, fecha: "2026-07-10", created_at: "2026-07-10T00:00:00Z", ...extra,
  };
}

function undefinedColumn(): Error & { code: string } {
  const err = new Error('column "excluido_por_revision" does not exist') as Error & { code: string };
  err.code = "42703";
  return err;
}

describe("PostgresDespachosRepository.listInvoices — CFDI excluidos por revisión rechazada", () => {
  it("con la migración: filtra `not excluido_por_revision` en SQL", async () => {
    const session = new AbortAwareFakeSession([{ match: CON_FILTRO, respond: () => [fila("1", { excluido_por_revision: false })] }]);
    const repo = new PostgresDespachosRepository(session);
    const r = await repo.listInvoices(PROPERTY_ID);
    expect(r.map((i) => i.id)).toEqual(["1"]);
    expect(r[0]!.excluidoPorRevision).toBe(false);
  });

  it("incluirExcluidos: no filtra y devuelve la marca", async () => {
    const session = new AbortAwareFakeSession([{ match: SIN_FILTRO, respond: () => [fila("1", { excluido_por_revision: true })] }]);
    const repo = new PostgresDespachosRepository(session);
    const r = await repo.listInvoices(PROPERTY_ID, { incluirExcluidos: true });
    expect(r[0]!.excluidoPorRevision).toBe(true);
    expect(session.calls.some((c) => c.startsWith("savepoint"))).toBe(false);
  });

  it("REGLA DURA (42703, migración 026 sin aplicar): cae a la consulta de siempre y el SAVEPOINT deja la sesión utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: CON_FILTRO, respond: () => undefinedColumn() },
      { match: SIN_FILTRO, respond: () => [fila("1"), fila("2")] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);
    const r = await repo.listInvoices(PROPERTY_ID, { periodo: undefined });
    expect(r).toHaveLength(2);
    expect(r[0]!.excluidoPorRevision).toBe(false);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("cualquier otro error de Postgres se repropaga tal cual", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: CON_FILTRO,
        respond: () => {
          const err = new Error("connection terminated") as Error & { code: string };
          err.code = "57P01";
          return err;
        },
      },
    ]);
    await expect(new PostgresDespachosRepository(session).listInvoices(PROPERTY_ID)).rejects.toMatchObject({ code: "57P01" });
  });
});

describe("PostgresDespachosRepository.findInvoiceByFolioFiscal — por cliente", () => {
  it("busca por (property, folio fiscal), no por organización", async () => {
    const session = new AbortAwareFakeSession([{ match: /where property_id = \$1 and folio_fiscal = \$2/i, respond: () => [fila("9")] }]);
    expect((await new PostgresDespachosRepository(session).findInvoiceByFolioFiscal(PROPERTY_ID, "f-9"))?.id).toBe("9");
  });
});

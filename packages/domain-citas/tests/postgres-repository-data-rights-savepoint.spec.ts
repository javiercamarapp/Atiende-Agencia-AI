// C-02 -- compatibilidad con la base SIN MIGRAR (regla dura del repo) de las
// solicitudes ARCO. Un `AbortAwareFakeSession` reproduce el estado ABORTADO real de
// Postgres: tras un error (42883/42P01), CUALQUIER consulta posterior falla con
// 25P02 salvo que se haya hecho ROLLBACK TO SAVEPOINT. Una sesión falsa plana NO
// sirve para esto. Cada método debe degradar a "no disponible" Y dejar la
// transacción compartida (webhook/request) utilizable.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";

function pgError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedFn = (name: string) => pgError(`function citas.${name}(uuid, text, text, text, text) does not exist`, "42883");
const undefinedTable = () => pgError('relation "citas.data_rights_requests" does not exist', "42P01");
const NEXT_QUERY = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

async function nextQueryWorks(session: AbortAwareFakeSession): Promise<void> {
  const { rows } = await session.query<{ ok: boolean }>("select 1 as siguiente_query_del_request;");
  expect(rows[0]?.ok).toBe(true);
}

describe("PostgresCitasRepository -- solicitudes ARCO sobre una base sin la migración 024", () => {
  it("registerDataRightsRequestAsSystem: 42883 -> available:false y la sesión queda utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_register_data_rights_request/, respond: () => undefinedFn("system_register_data_rights_request") }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", detail: null })).resolves.toEqual({ available: false });
    expect(session.calls).toContain("savepoint sp_citas_data_rights_register");
    expect(session.calls).toContain("rollback to savepoint sp_citas_data_rights_register");
    await nextQueryWorks(session);
  });

  it("resolveDataRightsConfirmationAsSystem: 42883 -> available:false y la sesión queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_resolve_data_rights_confirmation/, respond: () => undefinedFn("system_resolve_data_rights_confirmation") }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.resolveDataRightsConfirmationAsSystem(ORG, "+5219981234567", true)).resolves.toEqual({ available: false });
    await nextQueryWorks(session);
  });

  it("listDataRightsRequests: 42P01 -> disponible:false (nunca una lista vacía real) y la sesión queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.data_rights_requests/, respond: () => undefinedTable() }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.listDataRightsRequests(ORG, {}, {})).resolves.toEqual({ disponible: false, items: [], total: 0, nextOffset: null });
    await nextQueryWorks(session);
  });

  it("listDataRightsEvents: 42P01 -> null y la sesión queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.data_rights_events/, respond: () => undefinedTable() }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.listDataRightsEvents(ORG, "req-1")).resolves.toBeNull();
    await nextQueryWorks(session);
  });

  it("updateDataRightsRequestStatus: 42883 -> unavailable y la sesión queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /update_data_rights_request_status/, respond: () => undefinedFn("update_data_rights_request_status") }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.updateDataRightsRequestStatus(ORG, "req-1", "en_proceso", null)).resolves.toEqual({ outcome: "unavailable" });
    await nextQueryWorks(session);
  });

  it.each([
    ["P0002", "not_found"],
    ["55000", "invalid_transition"],
    ["22023", "invalid_input"],
    ["42501", "forbidden"],
  ] as const)("updateDataRightsRequestStatus: SQLSTATE %s de la función SQL -> %s, sin dejar la sesión abortada", async (code, outcome) => {
    const session = new AbortAwareFakeSession([{ match: /update_data_rights_request_status/, respond: () => pgError("falla de negocio", code) }, NEXT_QUERY]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.updateDataRightsRequestStatus(ORG, "req-1", "resuelta", "ok")).resolves.toEqual({ outcome });
    await nextQueryWorks(session);
  });

  it("un error NO recuperable (p. ej. conexión caída) se repropaga, no se disfraza de 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_register_data_rights_request/, respond: () => pgError("connection terminated", "08006") }]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", detail: null })).rejects.toThrow("connection terminated");
  });

  it("camino feliz: mapea las columnas de la función de registro y de la confirmación", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_register_data_rights_request/, respond: () => [{ out_id: "req-1", out_status: "pendiente_confirmacion", out_already_open: false, out_response_due_at: null }] },
      { match: /system_resolve_data_rights_confirmation/, respond: () => [{ out_id: "req-1", out_right_type: "acceso", out_status: "recibida", out_response_due_at: "2026-10-20 15:00:00+00", out_execution_due_at: "2026-11-04 15:00:00+00" }] },
    ]);
    const repo = new PostgresCitasRepository(session);
    await expect(repo.registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", detail: "x" })).resolves.toEqual({ available: true, id: "req-1", status: "pendiente_confirmacion", alreadyOpen: false, responseDueAt: null });
    await expect(repo.resolveDataRightsConfirmationAsSystem(ORG, "+5219981234567", true)).resolves.toMatchObject({ available: true, found: true, id: "req-1", rightType: "acceso", status: "recibida" });
  });
});

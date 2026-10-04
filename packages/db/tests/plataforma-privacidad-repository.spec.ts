// Adaptador Postgres de la privacidad de plataforma (PL-13): base sin migrar (42883/42P01/42703) con una
// sesion que reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession), tipado de
// errores de negocio, mapeo de filas y semantica del adaptador en memoria (misma de acceso que 0036).
import { describe, expect, it } from "vitest";
import { InMemoryPlataformaPrivacidadRepository, PlataformaPrivacidadError, PostgresPlataformaPrivacidadRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const ORG = "00000000-0000-0000-0000-0000000000a1";
const MOTIVO = "Retencion legal por requerimiento de autoridad";

describe("PostgresPlataformaPrivacidadRepository -- base sin migrar", () => {
  it("los 15 metodos devuelven not_migrated Y dejan la sesion utilizable (no 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.org_list_arco_requests/, respond: () => pgError("42883", "function core.org_list_arco_requests(uuid, boolean, integer, integer) does not exist") },
      { match: /core\.org_list_retention_policies/, respond: () => pgError("42883", "function core.org_list_retention_policies(uuid) does not exist") },
      { match: /core\.org_set_retention_policy/, respond: () => pgError("42883", "function core.org_set_retention_policy(uuid, text, integer) does not exist") },
      { match: /core\.org_clear_retention_policy/, respond: () => pgError("42883", "function core.org_clear_retention_policy(uuid, text) does not exist") },
      { match: /core\.org_list_purge_holds/, respond: () => pgError("42883", "function core.org_list_purge_holds(uuid) does not exist") },
      { match: /core\.org_place_purge_hold/, respond: () => pgError("42883", "function core.org_place_purge_hold(uuid, text, text) does not exist") },
      { match: /core\.org_release_purge_hold/, respond: () => pgError("42883", "function core.org_release_purge_hold(uuid, uuid, text) does not exist") },
      { match: /core\.org_list_purge_runs/, respond: () => pgError("42883", "function core.org_list_purge_runs(uuid, integer, bigint) does not exist") },
      { match: /core\.org_list_privacy_notices/, respond: () => pgError("42883", "function core.org_list_privacy_notices(uuid, integer) does not exist") },
      { match: /core\.org_publish_privacy_notice/, respond: () => pgError("42P01", 'relation "core.privacy_notice_version" does not exist') },
      { match: /core\.org_accept_privacy_notice/, respond: () => pgError("42883", "function core.org_accept_privacy_notice(uuid, integer) does not exist") },
      { match: /core\.platform_list_arco_requests/, respond: () => pgError("42883", "function core.platform_list_arco_requests(uuid, boolean, boolean, integer, integer) does not exist") },
      { match: /core\.platform_privacy_overview/, respond: () => pgError("42883", "function core.platform_privacy_overview(uuid, integer, integer) does not exist") },
      { match: /core\.platform_list_purge_runs/, respond: () => pgError("42703", 'column "organization_id" does not exist') },
      { match: /core\.system_run_retention_purge/, respond: () => pgError("42883", "function core.system_run_retention_purge(uuid, text, boolean, integer) does not exist") },
      { match: /select 1 as sigue_viva/, respond: () => [{ sigue_viva: 1 }] },
    ]);
    const repo = new PostgresPlataformaPrivacidadRepository(session);
    const q = { onlyOpen: false, limit: 10, offset: 0 };
    await expect(repo.orgListArco(ORG, q)).resolves.toEqual({ availability: "not_migrated", total: 0, items: [] });
    await expect(repo.orgListRetention(ORG)).resolves.toEqual({ availability: "not_migrated", items: [] });
    await expect(repo.orgSetRetention(ORG, "restaurantes_whatsapp_conversaciones", 90)).resolves.toEqual({ availability: "not_migrated" });
    await expect(repo.orgClearRetention(ORG, "restaurantes_whatsapp_conversaciones")).resolves.toEqual({ availability: "not_migrated", cleared: false });
    await expect(repo.orgListHolds(ORG)).resolves.toEqual({ availability: "not_migrated", items: [] });
    await expect(repo.orgPlaceHold(ORG, null, MOTIVO)).resolves.toEqual({ availability: "not_migrated", id: null });
    await expect(repo.orgReleaseHold(ORG, "h1", null)).resolves.toEqual({ availability: "not_migrated", released: false });
    await expect(repo.orgListPurgeRuns(ORG, 10, null)).resolves.toEqual({ availability: "not_migrated", items: [] });
    await expect(repo.orgListNotices(ORG, 10)).resolves.toEqual({ availability: "not_migrated", items: [] });
    await expect(repo.orgPublishNotice(ORG, "Aviso", "Resumen del aviso", "https://x.mx/a")).resolves.toEqual({ availability: "not_migrated", noticeId: null, version: null });
    await expect(repo.orgAcceptNotice(ORG, 1)).resolves.toEqual({ availability: "not_migrated", accepted: false });
    await expect(repo.platformListArco("u1", { ...q, onlyOverdue: false })).resolves.toEqual({ availability: "not_migrated", total: 0, items: [] });
    await expect(repo.platformOverview("u1", 10, 0)).resolves.toEqual({ availability: "not_migrated", total: 0, items: [] });
    await expect(repo.platformListPurgeRuns("u1", 10, null)).resolves.toEqual({ availability: "not_migrated", items: [] });
    await expect(repo.runRetentionPurge(ORG, "restaurantes_whatsapp_conversaciones", true, 500)).resolves.toEqual({ availability: "not_migrated", result: null });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada) y el COMMIT daria ROLLBACK.
    await expect(session.query("select 1 as sigue_viva")).resolves.toEqual({ rows: [{ sigue_viva: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(15);
  });

  it("MISMA transaccion: una lectura previa y otra posterior siguen vivas tras el fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.org_list_retention_policies/, respond: () => [] },
      { match: /core\.org_list_arco_requests/, respond: () => pgError("42883", "function core.org_list_arco_requests(uuid, boolean, integer, integer) does not exist") },
    ]);
    const repo = new PostgresPlataformaPrivacidadRepository(session);
    await expect(repo.orgListRetention(ORG)).resolves.toMatchObject({ availability: "available" });
    await expect(repo.orgListArco(ORG, { onlyOpen: true, limit: 5, offset: 0 })).resolves.toMatchObject({ availability: "not_migrated" });
    await expect(repo.orgListRetention(ORG)).resolves.toMatchObject({ availability: "available" });
  });

  it("un 42883 que NO es de migracion (operador) no se enmascara como not_migrated", async () => {
    const s = new AbortAwareFakeSession([{ match: /core\.org_list_arco_requests/, respond: () => pgError("42883", "operator does not exist: uuid = text") }]);
    await expect(new PostgresPlataformaPrivacidadRepository(s).orgListArco(ORG, { onlyOpen: false, limit: 5, offset: 0 })).rejects.toThrow(/operator does not exist/);
  });
});

describe("PostgresPlataformaPrivacidadRepository -- errores de negocio y mapeo", () => {
  it("42501 -> forbidden, 22023 -> invalid y 23505 -> conflict (tipados, no 500)", async () => {
    const forbidden = new AbortAwareFakeSession([{ match: /core\.org_set_retention_policy/, respond: () => pgError("42501", "org_set_retention_policy: solo owner/admin de la organizacion") }]);
    await expect(new PostgresPlataformaPrivacidadRepository(forbidden).orgSetRetention(ORG, "x", 10)).rejects.toMatchObject({ code: "forbidden" });
    const invalid = new AbortAwareFakeSession([{ match: /core\.org_set_retention_policy/, respond: () => pgError("22023", "org_set_retention_policy: los dias deben estar entre 30 y 1095") }]);
    const err = await new PostgresPlataformaPrivacidadRepository(invalid).orgSetRetention(ORG, "x", 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlataformaPrivacidadError);
    expect((err as PlataformaPrivacidadError).code).toBe("invalid");
    const conflict = new AbortAwareFakeSession([{ match: /core\.org_place_purge_hold/, respond: () => pgError("23505", "org_place_purge_hold: ya existe un bloqueo activo para esa clase") }]);
    await expect(new PostgresPlataformaPrivacidadRepository(conflict).orgPlaceHold(ORG, null, MOTIVO)).rejects.toMatchObject({ code: "conflict" });
  });

  it("un error inesperado (sin SQLSTATE de negocio) se repropaga tal cual", async () => {
    const s = new AbortAwareFakeSession([{ match: /core\.platform_privacy_overview/, respond: () => pgError("57014", "canceling statement due to statement timeout") }]);
    await expect(new PostgresPlataformaPrivacidadRepository(s).platformOverview("u1", 10, 0)).rejects.toThrow(/statement timeout/);
  });

  it("mapea filas ARCO sin datos del titular y el total de la ventana", async () => {
    const opened = "2026-09-01T00:00:00.000Z";
    const due = "2026-09-21T00:00:00.000Z";
    const s = new AbortAwareFakeSession([
      {
        match: /core\.org_list_arco_requests/,
        respond: () => [
          {
            out_vertical: "citas",
            out_request_id: "r1",
            out_right_type: "acceso",
            out_channel: "whatsapp",
            out_native_status: "recibida",
            out_status_bucket: "abierta",
            out_opened_at: opened,
            out_response_due_at: due,
            out_execution_due_at: null,
            out_due_at: due,
            out_resolved_at: null,
            out_is_open: true,
            out_is_overdue: true,
            out_total: "7",
          },
        ],
      },
    ]);
    const page = await new PostgresPlataformaPrivacidadRepository(s).orgListArco(ORG, { onlyOpen: true, limit: 1, offset: 0 });
    expect(page.total).toBe(7);
    expect(page.items).toEqual([
      {
        organizationId: null,
        organizationName: null,
        vertical: "citas",
        requestId: "r1",
        rightType: "acceso",
        channel: "whatsapp",
        nativeStatus: "recibida",
        statusBucket: "abierta",
        openedAtMs: Date.parse(opened),
        responseDueAtMs: Date.parse(due),
        executionDueAtMs: null,
        dueAtMs: Date.parse(due),
        resolvedAtMs: null,
        isOpen: true,
        isOverdue: true,
      },
    ]);
    expect(Object.keys(page.items[0]!).some((k) => /phone|telefono|contact|name$|requester/i.test(k) && k !== "organizationName")).toBe(false);
    expect(s.calls.some((c) => /org_list_arco_requests/.test(c))).toBe(true);
  });

  it("listPurgeTargets mapea los pares y degrada sin migrar", async () => {
    const ok = new AbortAwareFakeSession([{ match: /core\.system_list_purge_targets/, respond: () => [{ out_organization_id: "o1", out_data_class: "restaurantes_voz_transcripciones" }] }]);
    await expect(new PostgresPlataformaPrivacidadRepository(ok).listPurgeTargets(null, 10)).resolves.toEqual({ availability: "available", targets: [{ organizationId: "o1", dataClass: "restaurantes_voz_transcripciones" }] });
    const missing = new AbortAwareFakeSession([{ match: /core\.system_list_purge_targets/, respond: () => pgError("42883", "function core.system_list_purge_targets(uuid, integer) does not exist") }]);
    await expect(new PostgresPlataformaPrivacidadRepository(missing).listPurgeTargets(null, 10)).resolves.toEqual({ availability: "not_migrated", targets: [] });
  });

  it("la purga devuelve el resultado con conteos y estado", async () => {
    const s = new AbortAwareFakeSession([{ match: /core\.system_run_retention_purge/, respond: () => [{ out_run_id: "run1", out_status: "bloqueada", out_retention_days: 180, out_rows_affected: 0, out_rows_anonymized: 0, out_rows_protected: 0 }] }]);
    await expect(new PostgresPlataformaPrivacidadRepository(s).runRetentionPurge(ORG, "restaurantes_whatsapp_conversaciones", false, 500)).resolves.toEqual({
      availability: "available",
      result: { runId: "run1", status: "bloqueada", retentionDays: 180, rowsAffected: 0, rowsAnonymized: 0, rowsProtected: 0 },
    });
  });
});

describe("hoteles_whatsapp_conversaciones -- ejecutor del vertical (H-P3-03)", () => {
  const fila = { out_run_id: "run-h1", out_status: "ok", out_retention_days: 180, out_rows_affected: 7, out_rows_anonymized: 0, out_rows_protected: 1 };

  it("enruta la clase a hoteles.system_run_retention_conversaciones (organizacion, simulacion, limite) y NO a core.system_run_retention_purge", async () => {
    const s = new AbortAwareFakeSession([
      { match: /hoteles\.system_run_retention_conversaciones/, respond: () => [fila] },
      { match: /core\.system_run_retention_purge/, respond: () => pgError("42501", "no deberia llamarse") },
    ]);
    let sql = "";
    let params: unknown[] | undefined;
    const original = s.query.bind(s);
    s.query = (async (q: string, p?: unknown[]) => {
      sql = q;
      params = p;
      return original(q, p);
    }) as typeof s.query;
    await expect(new PostgresPlataformaPrivacidadRepository(s).runRetentionPurge(ORG, "hoteles_whatsapp_conversaciones", true, 300)).resolves.toEqual({
      availability: "available",
      result: { runId: "run-h1", status: "ok", retentionDays: 180, rowsAffected: 7, rowsAnonymized: 0, rowsProtected: 1 },
    });
    expect(sql).toMatch(/hoteles\.system_run_retention_conversaciones\(\$1, \$2::boolean, \$3::int\)/);
    expect(params).toEqual([ORG, true, 300]);
  });

  it("las demas clases siguen en core.system_run_retention_purge con sus 4 parametros", async () => {
    const s = new AbortAwareFakeSession([{ match: /core\.system_run_retention_purge/, respond: () => [fila] }]);
    let params: unknown[] | undefined;
    const original = s.query.bind(s);
    s.query = (async (q: string, p?: unknown[]) => {
      params = p;
      return original(q, p);
    }) as typeof s.query;
    await new PostgresPlataformaPrivacidadRepository(s).runRetentionPurge(ORG, "restaurantes_voz_transcripciones", false, 500);
    expect(params).toEqual([ORG, "restaurantes_voz_transcripciones", false, 500]);
  });

  it("base sin la migracion 046: degrada a not_migrated con la sesion utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /hoteles\.system_run_retention_conversaciones/, respond: () => pgError("42883", "function hoteles.system_run_retention_conversaciones(uuid, boolean, integer) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresPlataformaPrivacidadRepository(s).runRetentionPurge(ORG, "hoteles_whatsapp_conversaciones", false, 500)).resolves.toEqual({ availability: "not_migrated", result: null });
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("InMemoryPlataformaPrivacidadRepository -- misma semantica de acceso que el SQL", () => {
  function repo() {
    const r = new InMemoryPlataformaPrivacidadRepository();
    r.seedOrgAdmin(ORG, "owner");
    r.seedSuperadmin("sa");
    r.seedArco(ORG, { vertical: "citas", requestId: "r1", rightType: "acceso", channel: "whatsapp", nativeStatus: "recibida", statusBucket: "abierta", openedAtMs: 1, responseDueAtMs: 2, executionDueAtMs: null, dueAtMs: 2, resolvedAtMs: null, isOpen: true, isOverdue: true });
    return r;
  }

  it("las lecturas devuelven cero filas a quien no es owner/admin ni superadmin", async () => {
    const r = repo();
    expect((await r.as("intruso").orgListArco(ORG, { onlyOpen: false, limit: 10, offset: 0 })).items).toHaveLength(0);
    expect((await r.as("owner").orgListArco(ORG, { onlyOpen: false, limit: 10, offset: 0 })).items).toHaveLength(1);
    expect((await r.as("owner").platformListArco("owner", { onlyOpen: false, onlyOverdue: false, limit: 10, offset: 0 })).items).toHaveLength(0);
    expect((await r.as("sa").platformListArco("sa", { onlyOpen: false, onlyOverdue: true, limit: 10, offset: 0 })).items).toHaveLength(1);
    // caller-binding: el id de un superadmin con la sesion de otro usuario no cuenta.
    expect((await r.as("owner").platformListArco("sa", { onlyOpen: false, onlyOverdue: false, limit: 10, offset: 0 })).items).toHaveLength(0);
  });

  it("la politica respeta el rango de la clase y no admite clases que gobierna el vertical", async () => {
    const r = repo();
    r.as("owner");
    await expect(r.orgSetRetention(ORG, "restaurantes_whatsapp_conversaciones", 10)).rejects.toMatchObject({ code: "invalid" });
    await expect(r.orgSetRetention(ORG, "hoteles_identidad_documento", 30)).rejects.toMatchObject({ code: "invalid" });
    await r.orgSetRetention(ORG, "restaurantes_whatsapp_conversaciones", 90);
    expect((await r.orgListRetention(ORG)).items.find((i) => i.dataClass === "restaurantes_whatsapp_conversaciones")).toMatchObject({ effectiveDays: 90, source: "organizacion" });
    await expect(r.as("intruso").orgSetRetention(ORG, "restaurantes_whatsapp_conversaciones", 90)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("un bloqueo activo hace que la purga quede bloqueada y se registra", async () => {
    const r = repo();
    r.as("owner");
    const hold = await r.orgPlaceHold(ORG, null, MOTIVO);
    await expect(r.orgPlaceHold(ORG, null, MOTIVO)).rejects.toMatchObject({ code: "conflict" });
    expect((await r.runRetentionPurge(ORG, "restaurantes_whatsapp_conversaciones", false, 500)).result?.status).toBe("bloqueada");
    await r.orgReleaseHold(ORG, hold.id ?? "", "Caso cerrado");
    expect((await r.runRetentionPurge(ORG, "restaurantes_whatsapp_conversaciones", false, 500)).result?.status).toBe("ok");
    expect((await r.runRetentionPurge(ORG, "hoteles_identidad_documento", false, 500)).result?.status).toBe("sin_ejecutor");
    expect(r.purgeRuns().map((x) => x.status)).toEqual(["bloqueada", "ok", "sin_ejecutor"]);
  });

  it("el aviso se versiona y solo se acepta la version vigente", async () => {
    const r = repo();
    r.seedOrgAdmin(ORG, "admin");
    await r.as("owner").orgPublishNotice(ORG, "Aviso", "Resumen suficientemente largo", "https://x.mx/a");
    await r.as("owner").orgPublishNotice(ORG, "Aviso", "Resumen suficientemente largo v2", "https://x.mx/a");
    await expect(r.as("admin").orgAcceptNotice(ORG, 1)).rejects.toMatchObject({ code: "invalid" });
    await expect(r.as("admin").orgAcceptNotice(ORG, 2)).resolves.toMatchObject({ accepted: true });
    await expect(r.as("admin").orgAcceptNotice(ORG, 2)).resolves.toMatchObject({ accepted: false });
    await expect(r.as("owner").orgPublishNotice(ORG, "Aviso", "Resumen suficientemente largo", "http://x.mx/a")).rejects.toMatchObject({ code: "invalid" });
    const list = await r.as("admin").orgListNotices(ORG, 10);
    expect(list.items.map((n) => [n.version, n.isCurrent, n.acceptedCount])).toEqual([
      [2, true, 2],
      [1, false, 1],
    ]);
  });

  it("lista los objetivos de purga por paginas de organizaciones (cursor por id)", async () => {
    const r = new InMemoryPlataformaPrivacidadRepository();
    r.seedPurgeOrg("o3");
    r.seedPurgeOrg("o1");
    r.seedPurgeOrg("o2");
    const p1 = await r.listPurgeTargets(null, 2);
    expect(p1.targets.map((t) => t.organizationId)).toEqual(["o1", "o1", "o2", "o2"]);
    const p2 = await r.listPurgeTargets("o2", 2);
    expect(p2.targets.map((t) => `${t.organizationId}:${t.dataClass}`)).toEqual(["o3:restaurantes_whatsapp_conversaciones", "o3:restaurantes_voz_transcripciones"]);
  });

  it("migrado:false responde not_migrated en todo", async () => {
    const r = new InMemoryPlataformaPrivacidadRepository({ migrado: false });
    expect((await r.orgListArco(ORG, { onlyOpen: false, limit: 1, offset: 0 })).availability).toBe("not_migrated");
    expect((await r.runRetentionPurge(ORG, "x", false, 1)).availability).toBe("not_migrated");
  });
});

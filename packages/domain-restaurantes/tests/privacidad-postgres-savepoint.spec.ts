// PM PR-9 -- compatibilidad con la base SIN MIGRAR (regla dura del repo) de la privacidad. Un
// `AbortAwareFakeSession` reproduce el estado ABORTADO real de Postgres: tras un error
// (42883/42P01), CUALQUIER consulta posterior falla con 25P02 salvo que se haya hecho ROLLBACK TO
// SAVEPOINT. Cada metodo debe degradar a "no disponible" Y dejar la transaccion compartida
// (webhook/request) utilizable.
import { describe, expect, it } from "vitest";
import { PostgresPrivacidadRepository } from "../src/privacidad/postgres-repository.ts";
import { PRIVACY_CONFIG_POR_DEFECTO } from "../src/privacidad/aviso.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const CONV = "00000000-0000-0000-0000-0000000000c1";

function pgError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedFn = (name: string) => pgError(`function restaurantes.${name}(uuid, text) does not exist`, "42883");
const undefinedTable = (name: string) => pgError(`relation "restaurantes.${name}" does not exist`, "42P01");
const NEXT_QUERY = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

async function nextQueryWorks(session: AbortAwareFakeSession): Promise<void> {
  const { rows } = await session.query<{ ok: boolean }>("select 1 as siguiente_query_del_request;");
  expect(rows[0]?.ok).toBe(true);
}

describe("PostgresPrivacidadRepository -- sobre una base sin la migracion 030", () => {
  it("getPrivacyConfig: 42P01 -> valores por defecto (nunca lanza) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.privacy_config/, respond: () => undefinedTable("privacy_config") }, NEXT_QUERY]);
    const repo = new PostgresPrivacidadRepository(session);
    await expect(repo.getPrivacyConfig(ORG)).resolves.toEqual(PRIVACY_CONFIG_POR_DEFECTO);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await nextQueryWorks(session);
  });

  it("getPrivacyConfig: 42703 (columna) tambien degrada a los valores por defecto", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.privacy_config/, respond: () => pgError("column does not exist", "42703") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).getPrivacyConfig(ORG)).resolves.toEqual(PRIVACY_CONFIG_POR_DEFECTO);
    await nextQueryWorks(session);
  });

  it("claimPrivacyNotice: 42883 -> null (el caller usa 'primer mensaje de la conversacion') y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_claim_privacy_notice/, respond: () => undefinedFn("system_claim_privacy_notice") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).claimPrivacyNotice(ORG, "a".repeat(64), "whatsapp", "v1")).resolves.toBeNull();
    await nextQueryWorks(session);
  });

  it("registerDataRightsRequestAsSystem: 42883 -> available:false y la sesion queda utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_register_data_rights_request/, respond: () => undefinedFn("system_register_data_rights_request") }, NEXT_QUERY]);
    const repo = new PostgresPrivacidadRepository(session);
    await expect(repo.registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", channel: "whatsapp", detail: null })).resolves.toEqual({ available: false });
    expect(session.calls).toContain("savepoint sp_privacy_arco_register");
    expect(session.calls).toContain("rollback to savepoint sp_privacy_arco_register");
    await nextQueryWorks(session);
  });

  it("resolveDataRightsConfirmationAsSystem: 42883 -> available:false y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_resolve_data_rights_confirmation/, respond: () => undefinedFn("system_resolve_data_rights_confirmation") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).resolveDataRightsConfirmationAsSystem(ORG, "+5219981234567", true)).resolves.toEqual({ available: false });
    await nextQueryWorks(session);
  });

  it("listDataRightsRequests: 42P01 -> disponible:false (nunca una lista vacia real) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.data_rights_requests/, respond: () => undefinedTable("data_rights_requests") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).listDataRightsRequests(ORG, {}, {})).resolves.toEqual({ disponible: false, items: [], total: 0, nextOffset: null });
    await nextQueryWorks(session);
  });

  it("listDataRightsEvents: 42P01 -> null y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from restaurantes\.data_rights_events/, respond: () => undefinedTable("data_rights_events") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).listDataRightsEvents(ORG, "req-1")).resolves.toBeNull();
    await nextQueryWorks(session);
  });

  it("updateDataRightsRequestStatus: 42883 -> unavailable y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /update_data_rights_request_status/, respond: () => undefinedFn("update_data_rights_request_status") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).updateDataRightsRequestStatus(ORG, "req-1", "en_proceso", null)).resolves.toEqual({ outcome: "unavailable" });
    await nextQueryWorks(session);
  });

  it.each([
    ["P0002", "not_found"],
    ["55000", "invalid_transition"],
    ["22023", "invalid_input"],
    ["42501", "forbidden"],
  ] as const)("updateDataRightsRequestStatus: SQLSTATE %s de la funcion SQL -> %s, sin dejar la sesion abortada", async (code, outcome) => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.data_rights_requests where id/, respond: () => [] },
      { match: /update_data_rights_request_status/, respond: () => pgError("falla de negocio", code) },
      NEXT_QUERY,
    ]);
    await expect(new PostgresPrivacidadRepository(session).updateDataRightsRequestStatus(ORG, "req-1", "resuelta", "ok")).resolves.toEqual({ outcome });
    await nextQueryWorks(session);
  });

  it("updatePrivacyConfig: 42883 -> unavailable; 42501 -> forbidden; ambas dejan la sesion utilizable", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /update_privacy_config/, respond: () => undefinedFn("update_privacy_config") }, NEXT_QUERY]);
    const entrada = { responsibleName: null, noticeUrl: null, noticeVersion: "v1", conversationRetentionDays: 90, voiceRetentionDays: 30, recordingConsentRequired: true };
    await expect(new PostgresPrivacidadRepository(s1).updatePrivacyConfig(ORG, entrada)).resolves.toEqual({ outcome: "unavailable" });
    await nextQueryWorks(s1);
    const s2 = new AbortAwareFakeSession([{ match: /update_privacy_config/, respond: () => pgError("solo owner/admin", "42501") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(s2).updatePrivacyConfig(ORG, entrada)).resolves.toEqual({ outcome: "forbidden" });
    await nextQueryWorks(s2);
  });

  it("setVoiceRecordingConsent: 42883 -> unavailable; 42501 -> rejected; la sesion queda utilizable", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /system_set_voice_recording_consent/, respond: () => undefinedFn("system_set_voice_recording_consent") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(s1).setVoiceRecordingConsent(ORG, CONV, "negado")).resolves.toEqual({ outcome: "unavailable" });
    await nextQueryWorks(s1);
    const s2 = new AbortAwareFakeSession([{ match: /system_set_voice_recording_consent/, respond: () => pgError("ajena", "42501") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(s2).setVoiceRecordingConsent(ORG, CONV, "otorgado")).resolves.toEqual({ outcome: "rejected" });
    await nextQueryWorks(s2);
  });

  it("purgeExpiredPrivacyData: sin la 030 ni la 041 -> disponible:false y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_list_open_arco_phones/, respond: () => undefinedFn("system_list_open_arco_phones") },
      { match: /system_purge_expired_privacy_data/, respond: () => undefinedFn("system_purge_expired_privacy_data") },
      NEXT_QUERY,
    ]);
    await expect(new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(100)).resolves.toEqual({
      disponible: false,
      conversationsCleared: 0,
      voiceTurnsDeleted: 0,
      voiceCallsAnonymized: 0,
      callbacksAnonymized: 0,
      outboxScrubbed: 0,
      notesDeleted: 0,
      auditDeleted: 0,
      pendiente: false,
    });
    await nextQueryWorks(session);
  });

  it("purgeExpiredPrivacyData: con la 030 pero SIN la 041 cae al camino anterior (3 columnas) y la sesion queda utilizable", async () => {
    // Tras el 42883 de la lista de telefonos (funcion de la 041) el SAVEPOINT recupera la transaccion y la purga anterior corre.
    const session = new AbortAwareFakeSession([
      { match: /system_list_open_arco_phones/, respond: () => undefinedFn("system_list_open_arco_phones") },
      { match: /system_purge_expired_privacy_data\(\$1\);/, respond: () => [{ out_conversations_cleared: 100, out_voice_turns_deleted: 1, out_voice_calls_anonymized: 0 }] },
      NEXT_QUERY,
    ]);
    const outcome = await new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(100);
    expect(outcome).toMatchObject({ disponible: true, conversationsCleared: 100, voiceTurnsDeleted: 1, callbacksAnonymized: 0, pendiente: true });
    expect(session.calls).toContain("rollback to savepoint sp_privacy_purge_041");
    await nextQueryWorks(session);
  });

  it("purgeExpiredPrivacyData: base con la 041 pasa los seudonimos de voz de los titulares con ARCO abierto y devuelve los conteos nuevos", async () => {
    let params: unknown[] | undefined;
    const session = new AbortAwareFakeSession([
      { match: /system_list_open_arco_phones/, respond: () => [{ out_customer_phone: "+5219981234567" }] },
      {
        match: /system_purge_expired_privacy_data\(\$1, \$2::text\[\]\)/,
        respond: () => [{ out_conversations_cleared: 1, out_voice_turns_deleted: 2, out_voice_calls_anonymized: 3, out_callbacks_anonymized: 4, out_outbox_scrubbed: 5, out_notes_deleted: 6, out_audit_deleted: 7, out_pendiente: true }],
      },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/system_purge_expired_privacy_data\(\$1, \$2::text\[\]\)/.test(sql)) params = p;
      return original(sql, p);
    }) as typeof session.query;
    await expect(new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(500)).resolves.toEqual({
      disponible: true,
      conversationsCleared: 1,
      voiceTurnsDeleted: 2,
      voiceCallsAnonymized: 3,
      callbacksAnonymized: 4,
      outboxScrubbed: 5,
      notesDeleted: 6,
      auditDeleted: 7,
      pendiente: true,
    });
    expect(params?.[0]).toBe(500);
    // Los seudonimos del telefono del titular cubren los formatos de WhatsApp y de voz (+52 sin el 1).
    expect((params?.[1] as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it("updateDataRightsRequestStatus: una CANCELACION a resuelta sobre una base sin la 041 no se cierra (unavailable) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.data_rights_requests where id/, respond: () => [{ right_type: "cancelacion", customer_phone: "+5219981234567" }] },
      { match: /update_data_rights_request_status\(\$1, \$2, \$3, \$4, \$5::text\[\]\)/, respond: () => undefinedFn("update_data_rights_request_status") },
      NEXT_QUERY,
    ]);
    await expect(new PostgresPrivacidadRepository(session).updateDataRightsRequestStatus(ORG, "req-1", "resuelta", "ok")).resolves.toEqual({ outcome: "unavailable" });
    expect(session.calls).toContain("rollback to savepoint sp_privacy_arco_update_cancelacion");
    await nextQueryWorks(session);
  });

  it("updateDataRightsRequestStatus: un derecho que NO es cancelacion sigue resolviendose por el camino de la 030 aunque falte la 041", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.data_rights_requests where id/, respond: () => [{ right_type: "acceso", customer_phone: "+5219981234567" }] },
      { match: /update_data_rights_request_status\(\$1, \$2, \$3, \$4, \$5::text\[\]\)/, respond: () => undefinedFn("update_data_rights_request_status") },
      { match: /update_data_rights_request_status\(\$1, \$2, \$3, \$4\)/, respond: () => [{ out_id: "req-1", out_status: "resuelta" }] },
    ]);
    await expect(new PostgresPrivacidadRepository(session).updateDataRightsRequestStatus(ORG, "req-1", "resuelta", "ok")).resolves.toEqual({ outcome: "updated", id: "req-1", status: "resuelta" });
  });

  it("updateDataRightsRequestStatus: una cancelacion con la 041 pasa los seudonimos de voz del titular a la funcion", async () => {
    let params: unknown[] | undefined;
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.data_rights_requests where id/, respond: () => [{ right_type: "cancelacion", customer_phone: "+5219981234567" }] },
      { match: /update_data_rights_request_status\(\$1, \$2, \$3, \$4, \$5::text\[\]\)/, respond: () => [{ out_id: "req-1", out_status: "resuelta" }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      if (/update_data_rights_request_status/.test(sql)) params = p;
      return original(sql, p);
    }) as typeof session.query;
    await expect(new PostgresPrivacidadRepository(session).updateDataRightsRequestStatus(ORG, "req-1", "resuelta", "ok")).resolves.toEqual({ outcome: "updated", id: "req-1", status: "resuelta" });
    expect((params?.[4] as string[]).length).toBeGreaterThanOrEqual(3);
  });

  it("un error NO recuperable (conexion caida) se repropaga, no se disfraza de 'no disponible'", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_register_data_rights_request/, respond: () => pgError("connection terminated", "08006") }]);
    await expect(
      new PostgresPrivacidadRepository(session).registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", channel: "whatsapp", detail: null }),
    ).rejects.toThrow("connection terminated");
  });

  it("camino feliz: mapea config, reclamo del aviso, registro, confirmacion y purga", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from restaurantes\.privacy_config/,
        respond: () => [{ responsible_name: "Taquitos", notice_url: "https://a.mx/b", notice_version: "v3", conversation_retention_days: 90, voice_retention_days: 0, recording_consent_required: false }],
      },
      { match: /system_claim_privacy_notice/, respond: () => [{ claimed: true }] },
      { match: /system_register_data_rights_request/, respond: () => [{ out_id: "req-1", out_status: "pendiente_confirmacion", out_already_open: false, out_response_due_at: null }] },
      { match: /system_resolve_data_rights_confirmation/, respond: () => [{ out_id: "req-1", out_right_type: "acceso", out_status: "recibida", out_response_due_at: "2026-10-20 15:00:00+00", out_execution_due_at: "2026-11-04 15:00:00+00" }] },
      { match: /system_list_open_arco_phones/, respond: () => [] },
      { match: /system_purge_expired_privacy_data/, respond: () => [{ out_conversations_cleared: 3, out_voice_turns_deleted: 7, out_voice_calls_anonymized: 2, out_callbacks_anonymized: 0, out_outbox_scrubbed: 0, out_notes_deleted: 0, out_audit_deleted: 0, out_pendiente: false }] },
    ]);
    const repo = new PostgresPrivacidadRepository(session);
    await expect(repo.getPrivacyConfig(ORG)).resolves.toEqual({
      responsibleName: "Taquitos",
      noticeUrl: "https://a.mx/b",
      noticeVersion: "v3",
      conversationRetentionDays: 90,
      voiceRetentionDays: 0,
      recordingConsentRequired: false,
      configurada: true,
    });
    await expect(repo.claimPrivacyNotice(ORG, "a".repeat(64), "whatsapp", "v3")).resolves.toBe(true);
    await expect(repo.registerDataRightsRequestAsSystem({ organizationId: ORG, customerPhone: "+5219981234567", rightType: "acceso", channel: "voice", detail: "x" })).resolves.toEqual({
      available: true,
      id: "req-1",
      status: "pendiente_confirmacion",
      alreadyOpen: false,
      responseDueAt: null,
    });
    await expect(repo.resolveDataRightsConfirmationAsSystem(ORG, "+5219981234567", true)).resolves.toMatchObject({ available: true, found: true, id: "req-1", rightType: "acceso", status: "recibida" });
    await expect(repo.purgeExpiredPrivacyData(100)).resolves.toEqual({
      disponible: true,
      conversationsCleared: 3,
      voiceTurnsDeleted: 7,
      voiceCallsAnonymized: 2,
      callbacksAnonymized: 0,
      outboxScrubbed: 0,
      notesDeleted: 0,
      auditDeleted: 0,
      pendiente: false,
    });
  });
});

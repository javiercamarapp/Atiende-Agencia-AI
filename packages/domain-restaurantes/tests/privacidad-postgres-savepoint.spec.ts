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
    const session = new AbortAwareFakeSession([{ match: /update_data_rights_request_status/, respond: () => pgError("falla de negocio", code) }, NEXT_QUERY]);
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

  it("purgeExpiredPrivacyData: 42883 -> disponible:false y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /system_purge_expired_privacy_data/, respond: () => undefinedFn("system_purge_expired_privacy_data") }, NEXT_QUERY]);
    await expect(new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(100)).resolves.toEqual({ disponible: false, conversationsCleared: 0, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 });
    await nextQueryWorks(session);
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
      { match: /system_purge_expired_privacy_data/, respond: () => [{ out_conversations_cleared: 3, out_voice_turns_deleted: 7, out_voice_calls_anonymized: 2 }] },
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
    await expect(repo.purgeExpiredPrivacyData(100)).resolves.toEqual({ disponible: true, conversationsCleared: 3, voiceTurnsDeleted: 7, voiceCallsAnonymized: 2 });
  });
});

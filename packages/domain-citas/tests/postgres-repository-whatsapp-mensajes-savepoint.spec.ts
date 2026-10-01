// C-04 -- compatibilidad con la base SIN MIGRAR (migracion 026 pendiente). Cada metodo del repositorio corre con SAVEPOINT:
// un SQLSTATE 42883/42P01/42703 degrada a "no disponible" y deja la sesion compartida utilizable (nunca 25P02 despues).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { MENSAJES_CONFIG_POR_OMISION } from "../src/whatsapp/message-config.ts";
import { tryEnqueueAppointmentWhatsapp } from "../src/whatsapp/message-send.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000d1";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const noFunction = () => pgError("42883", "function citas.whatsapp_message_config_envio(uuid) does not exist");
const noTable = () => pgError("42P01", 'relation "citas.whatsapp_message_config" does not exist');

const savepointRecuperado = (s: AbortAwareFakeSession) => s.calls.some((c) => c.startsWith("rollback to savepoint"));

describe("PostgresCitasRepository -- mensajes de WhatsApp sobre una base sin migrar", () => {
  it("getWhatsappMessageConfig: 42P01 -> disponible:false y la sesion sigue sirviendo", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.whatsapp_message_config where/, respond: noTable }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresCitasRepository(session);
    expect(await repo.getWhatsappMessageConfig(ORG)).toEqual({ disponible: false, record: null });
    expect(savepointRecuperado(session)).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("getWhatsappMessageConfig: sin fila -> disponible:true y record null; con fila -> mapea tipos", async () => {
    const vacia = new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /whatsapp_message_config/, respond: () => [] }]));
    expect(await vacia.getWhatsappMessageConfig(ORG)).toEqual({ disponible: true, record: null });

    const fila = {
      reminder_enabled: true, reminder_text: "Hola {{hora}}", reminder_lead_hours: 12, confirmation_enabled: true, confirmation_text: null,
      cancellation_enabled: false, cancellation_text: null, reschedule_enabled: false, reschedule_text: null,
      send_window_start: 9, send_window_end: 20, version: 3, updated_by: null, updated_at: "2026-10-01 10:00:00+00",
    };
    const repo = new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /whatsapp_message_config/, respond: () => [fila] }]));
    const r = await repo.getWhatsappMessageConfig(ORG);
    expect(r.record).toMatchObject({ version: 3, config: { reminderLeadHours: 12, reminderText: "Hola {{hora}}", sendWindowStart: 9, sendWindowEnd: 20, confirmationEnabled: true } });
  });

  it("getWhatsappMessageConfigForSend: 42883 -> null (comportamiento de siempre) y la sesion sigue sirviendo", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_message_config_envio/, respond: noFunction }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresCitasRepository(session);
    expect(await repo.getWhatsappMessageConfigForSend(ORG)).toBeNull();
    expect(savepointRecuperado(session)).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("getWhatsappMessageConfigForSend: 42501 (usuario de otra organizacion) tambien degrada a null", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_message_config_envio/, respond: () => pgError("42501", "sin acceso") }]);
    expect(await new PostgresCitasRepository(session).getWhatsappMessageConfigForSend(ORG)).toBeNull();
  });

  it("getWhatsappMessageConfigForSend: un error distinto (deadlock) NO se enmascara, con la sesion ya recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_message_config_envio/, respond: () => pgError("40P01", "deadlock detected") }, { match: /select 1/, respond: () => [] }]);
    await expect(new PostgresCitasRepository(session).getWhatsappMessageConfigForSend(ORG)).rejects.toMatchObject({ code: "40P01" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("saveWhatsappMessageConfig: guardado, conflicto (AT409), sin permiso (42501) y base sin migrar (42883)", async () => {
    const ok = new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /save_whatsapp_message_config/, respond: () => [{ version: 4 }] }]));
    expect(await ok.saveWhatsappMessageConfig(ORG, 3, "actualizado", MENSAJES_CONFIG_POR_OMISION)).toEqual({ status: "saved", version: 4 });

    for (const [code, status] of [["AT409", "conflict"], ["42501", "forbidden"], ["42883", "unavailable"]] as const) {
      const message = code === "42883" ? "function citas.save_whatsapp_message_config(uuid, integer, text, jsonb) does not exist" : "x";
      const session = new AbortAwareFakeSession([{ match: /save_whatsapp_message_config/, respond: () => pgError(code, message) }, { match: /select 1/, respond: () => [] }]);
      expect(await new PostgresCitasRepository(session).saveWhatsappMessageConfig(ORG, 1, "actualizado", MENSAJES_CONFIG_POR_OMISION)).toEqual({ status });
      await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    }
  });

  it("saveWhatsappMessageConfig: un CHECK violado (23514) NO se enmascara", async () => {
    const session = new AbortAwareFakeSession([{ match: /save_whatsapp_message_config/, respond: () => pgError("23514", "check violation") }]);
    await expect(new PostgresCitasRepository(session).saveWhatsappMessageConfig(ORG, 0, "actualizado", MENSAJES_CONFIG_POR_OMISION)).rejects.toMatchObject({ code: "23514" });
  });

  it("listWhatsappMessageConfigHistory: 42883 -> disponible:false", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_message_config_history_list/, respond: noFunction }, { match: /select 1/, respond: () => [] }]);
    expect(await new PostgresCitasRepository(session).listWhatsappMessageConfigHistory(ORG, 20)).toEqual({ disponible: false, items: [] });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("el cron del recordatorio sobre una base sin migrar: usa el comportamiento de siempre y NO aborta la transaccion (la consulta de citas corre despues)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /whatsapp_message_config_envio/, respond: noFunction },
      { match: /from citas\.appointments a/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);
    const summary = await runConfirmacionCitaCore(repo, ORG, new Date("2026-09-13T16:00:00.000Z"));
    expect(summary.processed).toBe(0);
    expect(session.calls.some((c) => c.startsWith("select a.id as appointment_id"))).toBe(true);
    expect(savepointRecuperado(session)).toBe(true);
  });

  it("un aviso best-effort sobre una base sin migrar no lanza ni deja la sesion abortada (el commit final del request no se revierte)", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_message_config_envio/, respond: noFunction }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresCitasRepository(session);
    const r = await tryEnqueueAppointmentWhatsapp(repo, ORG, "appointment.cancelled", "00000000-0000-0000-0000-0000000000d2");
    expect(r).toEqual({ enqueued: false, reason: "disabled" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

// C-15 -- compatibilidad con la base SIN MIGRAR (migracion 028 pendiente). Cada metodo del repositorio corre con SAVEPOINT: un
// SQLSTATE 42883/42P01/42703 degrada a "no disponible" y deja la sesion compartida utilizable (nunca 25P02 despues).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AGENTE_CONFIG_POR_OMISION } from "../src/whatsapp/agent-config.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000e1";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const sinFuncion = (nombre: string) => () => pgError("42883", `function citas.${nombre} does not exist`);
const savepointRecuperado = (s: AbortAwareFakeSession) => s.calls.some((c) => c.startsWith("rollback to savepoint"));
const sesionSirve = (s: AbortAwareFakeSession) => expect(s.query("select 1;")).resolves.toEqual({ rows: [] });
const select1 = { match: /select 1/, respond: () => [] };

describe("PostgresCitasRepository -- personalidad del agente sobre una base sin migrar", () => {
  it("getWhatsappAgentConfig: 42P01 -> disponible:false y la sesion sigue sirviendo", async () => {
    const session = new AbortAwareFakeSession([{ match: /from citas\.whatsapp_agent_config where/, respond: () => pgError("42P01", 'relation "citas.whatsapp_agent_config" does not exist') }, select1]);
    expect(await new PostgresCitasRepository(session).getWhatsappAgentConfig(ORG)).toEqual({ disponible: false, record: null });
    expect(savepointRecuperado(session)).toBe(true);
    await sesionSirve(session);
  });

  it("getWhatsappAgentConfig: con fila mapea tipos; sin fila es disponible con record null", async () => {
    const fila = { agent_name: "Sofi", tone_style: "formal_directo", greeting_text: null, rules_text: "Una\nDos", version: 3, updated_by: null, updated_at: "2026-10-01 10:00:00+00" };
    const r = await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /whatsapp_agent_config/, respond: () => [fila] }])).getWhatsappAgentConfig(ORG);
    expect(r.record).toMatchObject({ version: 3, config: { agentName: "Sofi", toneStyle: "formal_directo", greetingText: null, rulesText: "Una\nDos" } });
    expect(await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /whatsapp_agent_config/, respond: () => [] }])).getWhatsappAgentConfig(ORG)).toEqual({ disponible: true, record: null });
  });

  it("getWhatsappAgentConfigForTurn: 42883 y 42501 -> null (el agente habla como siempre), sesion utilizable", async () => {
    for (const err of [sinFuncion("whatsapp_agent_config_envio(uuid)"), () => pgError("42501", "sin acceso")]) {
      const session = new AbortAwareFakeSession([{ match: /whatsapp_agent_config_envio/, respond: err }, select1]);
      expect(await new PostgresCitasRepository(session).getWhatsappAgentConfigForTurn(ORG)).toBeNull();
      await sesionSirve(session);
    }
  });

  it("getWhatsappAgentConfigForTurn: un deadlock NO se enmascara, con la sesion ya recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_agent_config_envio/, respond: () => pgError("40P01", "deadlock detected") }, select1]);
    await expect(new PostgresCitasRepository(session).getWhatsappAgentConfigForTurn(ORG)).rejects.toMatchObject({ code: "40P01" });
    await sesionSirve(session);
  });

  it("saveWhatsappAgentConfig: guardado, conflicto, sin permiso y base sin migrar; un CHECK (23514) NO se enmascara", async () => {
    const ok = new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /save_whatsapp_agent_config/, respond: () => [{ version: 4 }] }]));
    expect(await ok.saveWhatsappAgentConfig(ORG, 3, "actualizado", AGENTE_CONFIG_POR_OMISION)).toEqual({ status: "saved", version: 4 });
    for (const [code, status] of [["AT409", "conflict"], ["42501", "forbidden"], ["42883", "unavailable"]] as const) {
      const session = new AbortAwareFakeSession([{ match: /save_whatsapp_agent_config/, respond: () => pgError(code, code === "42883" ? "function citas.save_whatsapp_agent_config(uuid) does not exist" : "x") }, select1]);
      expect(await new PostgresCitasRepository(session).saveWhatsappAgentConfig(ORG, 1, "actualizado", AGENTE_CONFIG_POR_OMISION)).toEqual({ status });
      await sesionSirve(session);
    }
    const check = new AbortAwareFakeSession([{ match: /save_whatsapp_agent_config/, respond: () => pgError("23514", "check violation") }]);
    await expect(new PostgresCitasRepository(check).saveWhatsappAgentConfig(ORG, 0, "actualizado", AGENTE_CONFIG_POR_OMISION)).rejects.toMatchObject({ code: "23514" });
  });

  it("connectWhatsappNumber: conectado, en uso (AT410), invalido (22023), sin permiso (42501) y base sin migrar (42883)", async () => {
    const ok = new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /connect_whatsapp_number/, respond: () => [{ phone_number_id: "109876543210987" }] }]));
    expect(await ok.connectWhatsappNumber(ORG, "109876543210987", true)).toEqual({ status: "connected", phoneNumberId: "109876543210987" });
    for (const [code, status] of [["AT410", "in_use"], ["22023", "invalid"], ["42501", "forbidden"], ["42883", "unavailable"]] as const) {
      const session = new AbortAwareFakeSession([{ match: /connect_whatsapp_number/, respond: () => pgError(code, code === "42883" ? "function citas.connect_whatsapp_number(uuid) does not exist" : "x") }, select1]);
      expect(await new PostgresCitasRepository(session).connectWhatsappNumber(ORG, "109876543210987", true)).toEqual({ status });
      await sesionSirve(session);
    }
  });

  it("disconnectWhatsappNumber: desconectado (dice si habia numero), sin permiso y base sin migrar", async () => {
    expect(await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /disconnect_whatsapp_number/, respond: () => [{ removed: true }] }])).disconnectWhatsappNumber(ORG)).toEqual({ status: "disconnected", removed: true });
    expect(await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /disconnect_whatsapp_number/, respond: () => [{ removed: false }] }])).disconnectWhatsappNumber(ORG)).toEqual({ status: "disconnected", removed: false });
    for (const [code, status] of [["42501", "forbidden"], ["42883", "unavailable"]] as const) {
      const session = new AbortAwareFakeSession([{ match: /disconnect_whatsapp_number/, respond: () => pgError(code, code === "42883" ? "function citas.disconnect_whatsapp_number(uuid) does not exist" : "x") }, select1]);
      expect(await new PostgresCitasRepository(session).disconnectWhatsappNumber(ORG)).toEqual({ status });
      await sesionSirve(session);
    }
  });

  it("getWhatsappConnection: mapea la fila; sin fila es null", async () => {
    expect(await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /from citas\.whatsapp_config/, respond: () => [{ phone_number_id: "12345", is_active: false }] }])).getWhatsappConnection(ORG)).toEqual({ phoneNumberId: "12345", isActive: false });
    expect(await new PostgresCitasRepository(new AbortAwareFakeSession([{ match: /from citas\.whatsapp_config/, respond: () => [] }])).getWhatsappConnection(ORG)).toBeNull();
  });
});

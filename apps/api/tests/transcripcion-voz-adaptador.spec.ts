// R-32: adaptador de produccion del puerto de notas de voz (descarga de Meta + gateway LLM). Gateway y Meta falsos: sin red.
import { describe, expect, it, vi } from "vitest";
import { KillSwitchEngagedError, MonthlyBudgetExceededError, type LlmGateway } from "@atiende/agent-core";
import { NotaDeVozError } from "@atiende/domain-restaurantes";
import { MetaCloudSimulator } from "@atiende/whatsapp-gateway/testing";
import { MARCA_INAUDIBLE, TRANSCRIPCION_MAX_TOKENS, crearPuertoNotasDeVoz } from "../src/routes/verticals/restaurantes/transcripcion-voz.ts";
import { RESTAURANTES_TRANSCRIPCION_ROLE } from "../src/production/llm-models.ts";

const TOKEN = "sim-token";
const ORG = "11111111-1111-1111-1111-111111111111";

async function conSimulador<T>(fn: (sim: MetaCloudSimulator) => Promise<T>): Promise<T> {
  const sim = new MetaCloudSimulator({ appSecret: "s", accessToken: TOKEN, phoneNumberId: "1" });
  await sim.start();
  try {
    return await fn(sim);
  } finally {
    await sim.stop();
  }
}
const gatewayCon = (complete: (opts: unknown) => Promise<{ text: string }>): LlmGateway => ({ complete }) as unknown as LlmGateway;

describe("crearPuertoNotasDeVoz", () => {
  it("descarga con el simulador y transcribe por el rol de transcripcion, con audio base64, formato y tope de salida", async () => {
    await conSimulador(async (sim) => {
      const complete = vi.fn(async () => ({ text: "  dos de pastor  " }));
      const puerto = crearPuertoNotasDeVoz({ gateway: gatewayCon(complete), accessToken: TOKEN, graphBaseUrl: sim.baseUrl });
      const id = sim.registerMedia({ bytes: new Uint8Array([9, 8, 7]), mimeType: "audio/mpeg" });
      const audio = await puerto.descargar(id, { maxBytes: 1000, maxDurationSeconds: 60 });
      expect(audio).toMatchObject({ mimeType: "audio/mpeg", durationSeconds: null });
      expect(await puerto.transcribir(audio, { organizationId: ORG })).toEqual({ texto: "  dos de pastor  " });
      const call = complete.mock.calls[0]![0] as { tenantId: string; role: string; lane: string; request: { messages: { audio: { data: string; format: string } }[]; maxOutputTokens: number; signal: AbortSignal } };
      expect(call).toMatchObject({ tenantId: ORG, role: RESTAURANTES_TRANSCRIPCION_ROLE, lane: "interactive" });
      expect(call.request.messages[0]!.audio).toEqual({ data: Buffer.from([9, 8, 7]).toString("base64"), format: "mp3" });
      expect(call.request.maxOutputTokens).toBe(TRANSCRIPCION_MAX_TOKENS);
      expect(call.request.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it("amr no se acepta (los modelos de audio no lo soportan): se rechaza ANTES de descargar los bytes", async () => {
    await conSimulador(async (sim) => {
      const puerto = crearPuertoNotasDeVoz({ gateway: gatewayCon(async () => ({ text: "x" })), accessToken: TOKEN, graphBaseUrl: sim.baseUrl });
      const id = sim.registerMedia({ bytes: new Uint8Array([1]), mimeType: "audio/amr" });
      await expect(puerto.descargar(id, { maxBytes: 1000, maxDurationSeconds: 60 })).rejects.toMatchObject({ motivo: "tipo_no_soportado" });
      expect(sim.mediaRequests.some((r) => r.step === "bytes")).toBe(false);
    });
  });

  it("errores de descarga -> motivos tipados (tamano, token, inexistente)", async () => {
    await conSimulador(async (sim) => {
      const puerto = crearPuertoNotasDeVoz({ gateway: gatewayCon(async () => ({ text: "x" })), accessToken: TOKEN, graphBaseUrl: sim.baseUrl });
      const grande = sim.registerMedia({ bytes: new Uint8Array(5000).fill(1), mimeType: "audio/mpeg" });
      await expect(puerto.descargar(grande, { maxBytes: 1000, maxDurationSeconds: 60 })).rejects.toMatchObject({ motivo: "demasiado_grande" });
      await expect(puerto.descargar("NOEXISTE", { maxBytes: 1000, maxDurationSeconds: 60 })).rejects.toMatchObject({ motivo: "descarga_fallo" });
      const malToken = crearPuertoNotasDeVoz({ gateway: gatewayCon(async () => ({ text: "x" })), accessToken: "otro", graphBaseUrl: sim.baseUrl });
      await expect(malToken.descargar(grande, { maxBytes: 100000, maxDurationSeconds: 60 })).rejects.toMatchObject({ motivo: "descarga_fallo" });
    });
  });

  it.each([
    ["interruptor de plataforma", () => new KillSwitchEngagedError("agente restaurantes:transcripcion", RESTAURANTES_TRANSCRIPCION_ROLE), "apagado"],
    ["presupuesto mensual", () => new MonthlyBudgetExceededError("organization", ORG, 100, 100), "apagado"],
    ["cualquier otro fallo del gateway (todos los modelos fallaron)", () => new Error("AllProvidersFailed"), "transcripcion_fallo"],
  ])("%s -> %s", async (_nombre, error, motivo) => {
    const puerto = crearPuertoNotasDeVoz({
      gateway: gatewayCon(async () => {
        throw error();
      }),
      accessToken: TOKEN,
    });
    const err = await puerto.transcribir({ bytes: new Uint8Array([1]), mimeType: "audio/ogg", durationSeconds: 1 }, { organizationId: ORG }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotaDeVozError);
    expect((err as NotaDeVozError).motivo).toBe(motivo);
  });

  it("[inaudible] del modelo es transcripcion_vacia", async () => {
    const puerto = crearPuertoNotasDeVoz({ gateway: gatewayCon(async () => ({ text: ` ${MARCA_INAUDIBLE.toUpperCase()} ` })), accessToken: TOKEN });
    await expect(puerto.transcribir({ bytes: new Uint8Array([1]), mimeType: "audio/ogg", durationSeconds: 1 }, { organizationId: ORG })).rejects.toMatchObject({ motivo: "transcripcion_vacia" });
  });
});

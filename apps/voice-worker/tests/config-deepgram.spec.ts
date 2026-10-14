// `DEEPGRAM_API_KEY` en la configuracion del worker: una sola llave para el STT y el TTS de la cascada v2. Opcional (sin ella el escalon se salta); nunca se
// devuelve fuera de la config ni aparece en los motivos de "no configurado".
import { describe, expect, it } from "vitest";
import { cargarConfig } from "../src/config.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const SUC = "00000000-0000-4000-8000-0000000000a1";
const ENV_BASE = {
  LIVEKIT_URL: "wss://ejemplo.livekit.invalid",
  LIVEKIT_API_KEY: "llave-livekit",
  LIVEKIT_API_SECRET: "secreto-livekit",
  ATIENDE_API_URL: "https://api.ejemplo.invalid/",
  INTERNAL_SECRET: "secreto-interno",
  OPENROUTER_API_KEY: "llave-openrouter",
  VOICE_DNIS_MAP: JSON.stringify({ "+52 999 111 0001": { orgSlug: "los-taquitos-de-pm", organizationId: ORG, propertyId: SUC, branchSlug: "fco-montejo", secretoEnv: "VOICE_SECRET_FCO" } }),
  VOICE_SECRET_FCO: "secreto-sucursal",
};

describe("DEEPGRAM_API_KEY", () => {
  it("se lee recortada y queda configurado", () => {
    const c = cargarConfig({ ...ENV_BASE, DEEPGRAM_API_KEY: "  llave-deepgram  " });
    expect(c.estado).toBe("configurado");
    expect(c.deepgramApiKey).toBe("llave-deepgram");
  });
  it.each([[undefined], [""], ["   "]])("ausente o vacia (%j) es null y NO deja al worker sin configurar (el escalon cascada-v2 solo se salta)", (valor) => {
    const c = cargarConfig({ ...ENV_BASE, ...(valor === undefined ? {} : { DEEPGRAM_API_KEY: valor }) });
    expect(c.deepgramApiKey).toBeNull();
    expect(c.estado).toBe("configurado");
  });
  it("la llave nunca aparece en los motivos de un worker no configurado", () => {
    const c = cargarConfig({ DEEPGRAM_API_KEY: "llave-deepgram-secreta" });
    expect(c.estado).toBe("no_configurado");
    expect(JSON.stringify(c.motivos)).not.toContain("llave-deepgram-secreta");
  });
});

describe("VOZ_CASCADA_V2_HABILITADA (interruptor)", () => {
  it("apagado por omision aunque exista la llave de Deepgram", () => {
    expect(cargarConfig({ ...ENV_BASE, DEEPGRAM_API_KEY: "llave" }).cascadaV2Habilitada).toBe(false);
  });
  it.each([["1", true], ["true", true], ["TRUE", true], [" si ", true], ["0", false], ["false", false], ["", false], ["quizas", false]])("%j -> %s", (valor, esperado) => {
    expect(cargarConfig({ ...ENV_BASE, VOZ_CASCADA_V2_HABILITADA: valor }).cascadaV2Habilitada).toBe(esperado);
  });
});

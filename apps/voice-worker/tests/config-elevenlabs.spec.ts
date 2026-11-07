// Stack ElevenLabs en el worker: `ELEVENLABS_API_KEY`, `VOZ_ESCALERA`, `VOZ_RUIDO` (Krisp). Ninguna llave aparece en los motivos ni en los logs.
import { describe, expect, it } from "vitest";
import { cargarConfig } from "../src/config.ts";
import { cargarCancelacionRuido } from "../src/telefonia/ruido.ts";

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

describe("ELEVENLABS_API_KEY", () => {
  it("se lee recortada; ausente es null y el worker sigue configurado (la cascada usa solo Deepgram)", () => {
    expect(cargarConfig({ ...ENV_BASE, ELEVENLABS_API_KEY: "  llave-el  " }).elevenlabsApiKey).toBe("llave-el");
    const sin = cargarConfig(ENV_BASE);
    expect(sin.elevenlabsApiKey).toBeNull();
    expect(sin.estado).toBe("configurado");
  });
  it("nunca aparece en los motivos de un worker no configurado", () => {
    const c = cargarConfig({ ELEVENLABS_API_KEY: "llave-el-secreta" });
    expect(c.estado).toBe("no_configurado");
    expect(JSON.stringify(c.motivos)).not.toContain("llave-el-secreta");
  });
});

describe("VOZ_ESCALERA", () => {
  it("por omision null (el orden de la plataforma); PM la pone en cascada-v2,cascada-openrouter (cascada, no voz a voz)", () => {
    expect(cargarConfig(ENV_BASE).escalera).toBeNull();
    expect(cargarConfig({ ...ENV_BASE, VOZ_ESCALERA: " cascada-v2 , cascada-openrouter " }).escalera).toEqual(["cascada-v2", "cascada-openrouter"]);
  });
  it.each([["cascada-v2,inventado"], ["cascada-v2,cascada-v2"], [" , "]])("%j deja el worker sin configurar (nunca atiende con una escalera a medias)", (v) => {
    const c = cargarConfig({ ...ENV_BASE, VOZ_ESCALERA: v });
    expect(c.estado).toBe("no_configurado");
    expect(c.motivos.join(" ")).toContain("VOZ_ESCALERA");
  });
});

describe("VOZ_RUIDO (cancelacion de ruido de LiveKit)", () => {
  it("por omision Krisp BVC telefonico; acepta krisp y ninguno; otro valor es un error de configuracion", () => {
    expect(cargarConfig(ENV_BASE).ruido).toBe("krisp-telefonia");
    expect(cargarConfig({ ...ENV_BASE, VOZ_RUIDO: "KRISP" }).ruido).toBe("krisp");
    expect(cargarConfig({ ...ENV_BASE, VOZ_RUIDO: "ninguno" }).ruido).toBe("ninguno");
    expect(cargarConfig({ ...ENV_BASE, VOZ_RUIDO: "viva" }).estado).toBe("no_configurado");
  });

  it("krisp-telefonia usa TelephonyBackgroundVoiceCancellation y entrega opciones NUEVAS por pista", async () => {
    const log: string[] = [];
    let n = 0;
    const fabrica = await cargarCancelacionRuido("krisp-telefonia", (e) => void log.push(e), async () => ({ TelephonyBackgroundVoiceCancellation: () => ({ moduleId: `bvc-${++n}`, options: {} }), NoiseCancellation: () => ({ moduleId: "nc", options: {} }) }));
    expect(fabrica!().moduleId).toBe("bvc-1");
    expect(fabrica!().moduleId).toBe("bvc-2");
    expect(log).toEqual(["ruido_activo"]);
  });

  it("si el modulo nativo no carga, la llamada se atiende SIN filtro (null) y queda el evento; `ninguno` ni lo intenta", async () => {
    const log: string[] = [];
    expect(await cargarCancelacionRuido("krisp", (e) => void log.push(e), () => Promise.reject(new Error("sin binario")))).toBeNull();
    expect(log).toEqual(["ruido_no_disponible"]);
    let intentos = 0;
    expect(await cargarCancelacionRuido("ninguno", () => undefined, async () => (intentos++, { TelephonyBackgroundVoiceCancellation: () => ({ moduleId: "x", options: {} }), NoiseCancellation: () => ({ moduleId: "x", options: {} }) }))).toBeNull();
    expect(intentos).toBe(0);
  });
});

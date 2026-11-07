// Seccion "Encargados y transferencias" (seccion 7): se arma con la configuracion REAL de la organizacion y siempre es borrador.
import { describe, expect, it } from "vitest";
import { AVISO_BORRADOR_ENCARGADOS, encargadosEnUso, seccionEncargados } from "../src/privacidad/encargados.ts";

const ids = (c: { whatsappConectado: boolean; vozHabilitada: boolean }) => encargadosEnUso(c).map((e) => e.id);

describe("encargadosEnUso", () => {
  it("sin WhatsApp ni voz (solo pedidos en linea): ningun encargado", () => {
    expect(ids({ whatsappConectado: false, vozHabilitada: false })).toEqual([]);
  });
  it("solo WhatsApp: modelo de lenguaje, Meta, base de datos y alojamiento (nada de voz)", () => {
    expect(ids({ whatsappConectado: true, vozHabilitada: false })).toEqual(["openrouter", "meta_whatsapp", "supabase", "vercel"]);
  });
  it("solo voz: ElevenLabs con Deepgram de respaldo, Gemini, Twilio, LiveKit y Fly.io (sin Meta)", () => {
    expect(ids({ whatsappConectado: false, vozHabilitada: true })).toEqual(["openrouter", "elevenlabs", "deepgram", "gemini", "twilio", "livekit", "fly_io", "supabase", "vercel"]);
  });
  it("ambos: todos, sin duplicar el modelo de lenguaje ni la infraestructura", () => {
    expect(ids({ whatsappConectado: true, vozHabilitada: true })).toEqual(["openrouter", "elevenlabs", "deepgram", "gemini", "twilio", "livekit", "fly_io", "meta_whatsapp", "supabase", "vercel"]);
  });
  it("ElevenLabs declara que puede conservar los datos y enlaza su politica en vez de inventar un plazo", () => {
    const el = encargadosEnUso({ whatsappConectado: false, vozHabilitada: true }).find((e) => e.id === "elevenlabs");
    expect(el?.pais).toBe("Estados Unidos");
    expect(el?.finalidad).toMatch(/nombre, dirección, teléfono, pedido/);
    expect(el?.finalidad).toMatch(/conservar/);
    expect(el?.politicaPropia).toBe("https://elevenlabs.io/privacy-policy");
    expect(el?.finalidad).not.toMatch(/\d+ días|certificad/i);
  });
  it("OpenRouter declara retencion cero solo cuando el modelo lo ofrece", () => {
    const or = encargadosEnUso({ whatsappConectado: true, vozHabilitada: false }).find((e) => e.id === "openrouter");
    expect(or?.finalidad).toMatch(/retención cero de datos cuando el modelo lo ofrece/);
  });
  it("cada encargado lleva finalidad y pais", () => {
    for (const e of encargadosEnUso({ whatsappConectado: true, vozHabilitada: true })) {
      expect(e.finalidad.length).toBeGreaterThan(10);
      expect(e.pais).toBeTruthy();
    }
  });
});

describe("seccionEncargados", () => {
  it("siempre se marca como BORRADOR con revision legal pendiente", () => {
    const s = seccionEncargados({ whatsappConectado: true, vozHabilitada: false });
    expect(s.borrador).toBe(true);
    expect(s.revisionLegalPendiente).toBe(true);
    expect(s.aviso).toBe(AVISO_BORRADOR_ENCARGADOS);
    expect(s.aviso).toMatch(/BORRADOR pendiente de revisión legal/);
  });
  it("trato de usted y sin afirmar nada legal categorico", () => {
    expect(AVISO_BORRADOR_ENCARGADOS).toMatch(/sus datos/);
    expect(AVISO_BORRADOR_ENCARGADOS).not.toMatch(/\btus\b|\bte\b/);
  });
});

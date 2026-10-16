// Seccion "Encargados y transferencias" (seccion 7): se arma con la configuracion REAL de la organizacion y siempre es borrador.
import { describe, expect, it } from "vitest";
import { AVISO_BORRADOR_ENCARGADOS, encargadosEnUso, seccionEncargados } from "../src/privacidad/encargados.ts";

const ids = (c: { whatsappConectado: boolean; vozHabilitada: boolean }) => encargadosEnUso(c).map((e) => e.id);

describe("encargadosEnUso", () => {
  it("sin WhatsApp ni voz (solo pedidos en linea): ningun encargado", () => {
    expect(ids({ whatsappConectado: false, vozHabilitada: false })).toEqual([]);
  });
  it("solo WhatsApp: modelo de lenguaje y Meta", () => {
    expect(ids({ whatsappConectado: true, vozHabilitada: false })).toEqual(["openrouter", "meta_whatsapp"]);
  });
  it("solo voz: modelo de lenguaje, Gemini, Twilio y LiveKit (sin Meta)", () => {
    expect(ids({ whatsappConectado: false, vozHabilitada: true })).toEqual(["openrouter", "gemini", "twilio", "livekit"]);
  });
  it("ambos: los cinco, sin duplicar el modelo de lenguaje", () => {
    expect(ids({ whatsappConectado: true, vozHabilitada: true })).toEqual(["openrouter", "gemini", "twilio", "livekit", "meta_whatsapp"]);
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

// PM PR-9 -- aviso de privacidad simplificado, aviso de asistente virtual y consentimiento de grabacion.
import { describe, expect, it } from "vitest";
import {
  PRIVACY_CONFIG_POR_DEFECTO,
  composeWithPrivacyNotice,
  interpretRecordingConsent,
  privacyNoticeWhatsApp,
  validatePrivacyConfig,
  voiceOpeningScript,
} from "../src/privacidad/aviso.ts";
import type { PrivacyConfig } from "../src/privacidad/aviso.ts";

const CONFIG: PrivacyConfig = {
  responsibleName: "Los Taquitos de PM",
  noticeUrl: "https://ejemplo.mx/aviso",
  noticeVersion: "v1",
  conversationRetentionDays: 90,
  voiceRetentionDays: 15,
  recordingConsentRequired: true,
  configurada: true,
};

describe("aviso simplificado de WhatsApp", () => {
  it("dice que es un asistente virtual (IA), nombra al responsable, la retencion y el enlace al integral", () => {
    const text = privacyNoticeWhatsApp(CONFIG);
    expect(text).toContain("asistente virtual");
    expect(text).toContain("inteligencia artificial");
    expect(text).toContain("Los Taquitos de PM");
    expect(text).toContain("90 días");
    expect(text).toContain("https://ejemplo.mx/aviso");
    expect(text).toContain("ARCO");
  });

  it("sin URL configurada NO inventa un enlace: pide el integral al restaurante", () => {
    const text = privacyNoticeWhatsApp({ ...CONFIG, noticeUrl: null });
    expect(text).not.toContain("http");
    expect(text).toContain("Puede pedir el aviso de privacidad integral al restaurante");
  });

  it("con la configuracion por defecto usa la retencion por defecto (180 dias) y 'este restaurante'", () => {
    const text = privacyNoticeWhatsApp(PRIVACY_CONFIG_POR_DEFECTO);
    expect(text).toContain("180 días");
    expect(text).toContain("de este restaurante");
  });

  it("es breve (cabe en un mensaje de WhatsApp)", () => {
    expect(privacyNoticeWhatsApp(CONFIG).length).toBeLessThan(600);
  });

  it("composeWithPrivacyNotice antepone el aviso y conserva la respuesta; sin respuesta deja solo el aviso", () => {
    expect(composeWithPrivacyNotice("AVISO", "Hola")).toBe("AVISO\n\nHola");
    expect(composeWithPrivacyNotice("AVISO", "  ")).toBe("AVISO");
  });
});

describe("guion de apertura de la llamada", () => {
  it("con consentimiento requerido: asistente virtual + aviso + pregunta de grabacion que ofrece atender sin grabar", () => {
    const text = voiceOpeningScript(CONFIG);
    expect(text).toContain("asistente virtual");
    expect(text).toContain("inteligencia artificial");
    expect(text).toContain("¿Autoriza que esta llamada se grabe");
    expect(text).toContain("lo atiendo igual, sin grabar");
    expect(text).toContain("15 días");
  });

  it("con retencion de voz 0: avisa que NO se graba y no pide consentimiento", () => {
    const text = voiceOpeningScript({ ...CONFIG, voiceRetentionDays: 0 });
    expect(text).toContain("no se graba");
    expect(text).not.toContain("¿Autoriza");
  });

  it("sin consentimiento requerido: informa la retencion (no pregunta)", () => {
    const text = voiceOpeningScript({ ...CONFIG, recordingConsentRequired: false });
    expect(text).not.toContain("¿Autoriza");
    expect(text).toContain("15 días");
  });
});

describe("interpretRecordingConsent -- conservadora: ante la duda NO se graba", () => {
  it.each(["sí", "Si", "sí, autorizo", "claro", "de acuerdo", "acepto", "está bien", "por supuesto", "adelante"])("«%s» -> otorgado", (text) => {
    expect(interpretRecordingConsent(text)).toBe("otorgado");
  });
  it.each(["no", "No gracias", "no autorizo", "prefiero que no", "no quiero que me graben", "nel", "no, mejor no", "no acepto"])("«%s» -> negado", (text) => {
    expect(interpretRecordingConsent(text)).toBe("negado");
  });
  it.each(["", "quiero tres tacos", "hmm", "¿para qué?", "si no quiero", "sí pero no"])("«%s» es ambiguo -> null (no se graba)", (text) => {
    expect(interpretRecordingConsent(text)).toBeNull();
  });
});

describe("validatePrivacyConfig -- espeja los CHECK de la tabla", () => {
  const ok = { responsibleName: "X", noticeUrl: "https://a.mx/b", noticeVersion: "v2", conversationRetentionDays: 90, voiceRetentionDays: 0, recordingConsentRequired: true };
  it("acepta una configuracion valida", () => expect(validatePrivacyConfig(ok)).toBeNull());
  it("rechaza URL sin https", () => expect(validatePrivacyConfig({ ...ok, noticeUrl: "http://a.mx" })).toMatch(/noticeUrl/));
  it("rechaza URL con espacios", () => expect(validatePrivacyConfig({ ...ok, noticeUrl: "https://a.mx/a b" })).toMatch(/noticeUrl/));
  it("rechaza retencion de conversaciones fuera de 30..1095", () => {
    expect(validatePrivacyConfig({ ...ok, conversationRetentionDays: 29 })).toMatch(/conversationRetentionDays/);
    expect(validatePrivacyConfig({ ...ok, conversationRetentionDays: 1096 })).toMatch(/conversationRetentionDays/);
  });
  it("rechaza retencion de voz fuera de 0..365 o no entera", () => {
    expect(validatePrivacyConfig({ ...ok, voiceRetentionDays: 366 })).toMatch(/voiceRetentionDays/);
    expect(validatePrivacyConfig({ ...ok, voiceRetentionDays: 1.5 })).toMatch(/voiceRetentionDays/);
  });
  it("rechaza version con caracteres raros y responsable demasiado largo", () => {
    expect(validatePrivacyConfig({ ...ok, noticeVersion: "v 1" })).toMatch(/noticeVersion/);
    expect(validatePrivacyConfig({ ...ok, responsibleName: "x".repeat(201) })).toMatch(/responsibleName/);
  });
});

describe("el aviso y los guiones de privacidad hablan de usted (QA-PM-R3-whatsapp-11)", () => {
  it("ni el aviso de WhatsApp ni el guion de voz ni sus respuestas tutean", async () => {
    const mod = await import("../src/privacidad/aviso.ts");
    const config = { responsibleName: "Los Taquitos de PM", conversationRetentionDays: 90, voiceRetentionDays: 30, recordingConsentRequired: true, noticeUrl: null } as never;
    const textos = [mod.privacyNoticeWhatsApp(config), mod.voiceOpeningScript(config), mod.voiceOpeningScript({ ...(config as object), noticeUrl: "https://x.mx/aviso" } as never), mod.VOICE_CONSENT_GRANTED_REPLY, mod.VOICE_CONSENT_DENIED_REPLY, mod.VOICE_CONSENT_REPEAT_REPLY];
    for (const t of textos) expect(t).not.toMatch(/\b(?:tu|tus|te|ti|puedes|dile|escribe|autorizas|dices|respondes|pide)\b/i);
  });
});

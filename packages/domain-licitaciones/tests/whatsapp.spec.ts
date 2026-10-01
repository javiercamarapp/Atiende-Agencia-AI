import { describe, expect, it } from "vitest";
import {
  WHATSAPP_BUTTON_PREFIX,
  buildDecisionReplyBody,
  buildDecisionRequestMessage,
  buildNoticeMessage,
  buttonIdForToken,
  generateActionToken,
  normalizePhoneE164,
  parseActionButtonId,
  parseOptKeyword,
  phoneFromMeta,
  sha256TokenHash,
} from "../src/index.ts";

describe("token de accion de WhatsApp", () => {
  it("genera tokens distintos de 43 caracteres base64url y su hash SHA-256 hex", () => {
    const a = generateActionToken();
    const b = generateActionToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(sha256TokenHash(a.token));
    expect(a.hash).not.toContain(a.token);
  });

  it("ida y vuelta por el id del boton; ids ajenos o mal formados no devuelven token", () => {
    const { token } = generateActionToken();
    const id = buttonIdForToken(token);
    expect(id.startsWith(WHATSAPP_BUTTON_PREFIX)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(256);
    expect(parseActionButtonId(id)).toBe(token);
    expect(parseActionButtonId(`cita:confirmar:${token}`)).toBeNull();
    expect(parseActionButtonId(`${WHATSAPP_BUTTON_PREFIX}corto`)).toBeNull();
    expect(parseActionButtonId(`${WHATSAPP_BUTTON_PREFIX}${token}x`)).toBeNull();
    expect(() => buttonIdForToken("no-valido")).toThrow();
  });
});

describe("telefonos", () => {
  it("normaliza a E.164 y rechaza lo que no es internacional", () => {
    expect(normalizePhoneE164(" +52 (55) 1234-5678 ")).toBe("+525512345678");
    expect(() => normalizePhoneE164("5512345678")).toThrow(/formato internacional/);
    expect(() => normalizePhoneE164("+0123456789")).toThrow();
    expect(() => normalizePhoneE164("+52abc")).toThrow();
  });
  it("el `from` de Meta (solo digitos) se vuelve E.164", () => {
    expect(phoneFromMeta("5215512345678")).toBe("+5215512345678");
    expect(phoneFromMeta("abc")).toBeNull();
  });
});

describe("palabras clave de opt-in / opt-out", () => {
  it("reconoce el mensaje completo, con acentos y mayusculas", () => {
    expect(parseOptKeyword("SI")).toBe("opt_in");
    expect(parseOptKeyword(" Sí. ")).toBe("opt_in");
    expect(parseOptKeyword("BAJA")).toBe("opt_out");
    expect(parseOptKeyword("stop")).toBe("opt_out");
  });
  it("una palabra suelta dentro de una frase NO cuenta; tampoco un simple 'no'", () => {
    expect(parseOptKeyword("si pero antes dime el plazo")).toBeNull();
    expect(parseOptKeyword("no")).toBeNull();
    expect(parseOptKeyword("hola")).toBeNull();
  });
});

describe("mensajes", () => {
  it("la solicitud de decision lleva dos botones con tokens distintos y titulos <= 20", () => {
    const go = generateActionToken();
    const noGo = generateActionToken();
    const msg = buildDecisionRequestMessage("+525512345678", { title: "Suministro de papeleria", deadlineLabel: "15 oct 2026" }, go.token, noGo.token);
    expect(msg.buttons).toHaveLength(2);
    expect(msg.buttons![0]!.id).not.toBe(msg.buttons![1]!.id);
    for (const b of msg.buttons!) {
      expect(b.title.length).toBeLessThanOrEqual(20);
      expect(parseActionButtonId(b.id)).not.toBeNull();
    }
    expect(msg.body).toContain("Suministro de papeleria");
    expect(msg.body.length).toBeLessThanOrEqual(1000);
  });

  it("los avisos ofrecen BAJA y recortan titulos enormes", () => {
    const msg = buildNoticeMessage("+525512345678", "fallo", { title: "x".repeat(5000) });
    expect(msg.body).toContain("BAJA");
    expect(msg.body.length).toBeLessThanOrEqual(1000);
    expect(msg.buttons).toBeUndefined();
  });

  it("cada resultado del consumo tiene su respuesta y ninguna filtra datos internos", () => {
    for (const r of ["ok", "duplicado", "ya_usado", "expirado", "no_encontrado", "contacto_inactivo", "telefono_distinto", "rol_insuficiente", "error"] as const) {
      expect(buildDecisionReplyBody(r, "go").length).toBeGreaterThan(5);
    }
    expect(buildDecisionReplyBody("telefono_distinto")).toBe(buildDecisionReplyBody("no_encontrado"));
  });
});

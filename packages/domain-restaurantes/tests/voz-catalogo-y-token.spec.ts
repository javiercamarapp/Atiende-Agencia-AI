import { describe, expect, it } from "vitest";
import { CATALOGO_VOCES_GEMINI, esVozDeGemini, firmarPreviewToken, redactarTranscripcion, verificarPreviewToken } from "../src/index.ts";

// Lista independiente copiada de pm/voz/6-paridad-elevenlabs-y-clonacion.md (30-sep-2026), NO
// derivada del catalogo bajo prueba.
const VOCES_DOC = [
  "Zephyr", "Kore", "Orus", "Autonoe", "Umbriel", "Erinome", "Laomedeia", "Schedar", "Achird", "Sadachbia",
  "Puck", "Fenrir", "Aoede", "Enceladus", "Algieba", "Algenib", "Achernar", "Gacrux", "Zubenelgenubi", "Sadaltager",
  "Charon", "Leda", "Callirrhoe", "Iapetus", "Despina", "Rasalgethi", "Alnilam", "Pulcherrima", "Vindemiatrix", "Sulafat",
];

describe("catalogo de 30 voces de Gemini", () => {
  it("coincide exactamente con la lista verificada (30 voces, sin duplicados ni faltantes)", () => {
    expect(VOCES_DOC).toHaveLength(30);
    expect(CATALOGO_VOCES_GEMINI).toHaveLength(30);
    expect(CATALOGO_VOCES_GEMINI.map((v) => v.id).sort()).toEqual([...VOCES_DOC].sort());
    expect(new Set(CATALOGO_VOCES_GEMINI.map((v) => v.id)).size).toBe(30);
  });

  it("cada voz trae el estilo oficial y NO inventa genero ni acento", () => {
    for (const v of CATALOGO_VOCES_GEMINI) {
      expect(v.estilo.length).toBeGreaterThan(0);
      expect(Object.keys(v).sort()).toEqual(["estilo", "id", "nombre"]);
    }
    expect(CATALOGO_VOCES_GEMINI.find((v) => v.id === "Zephyr")?.estilo).toBe("Bright");
    expect(CATALOGO_VOCES_GEMINI.find((v) => v.id === "Sulafat")?.estilo).toBe("Warm");
  });

  it("esVozDeGemini acepta solo nombres exactos del catalogo", () => {
    expect(esVozDeGemini("Kore")).toBe(true);
    expect(esVozDeGemini("kore")).toBe(false);
    expect(esVozDeGemini("Marin")).toBe(false);
    expect(esVozDeGemini(undefined)).toBe(false);
    expect(esVozDeGemini(7)).toBe(false);
  });
});

describe("token efimero de preview (HMAC)", () => {
  const SECRETO = "test-preview-token-secret-ok";
  const AHORA = new Date("2026-09-30T12:00:00.000Z");
  const entrada = { sessionId: "s-1", organizationId: "org-1", propertyId: "prop-1", voiceId: "Kore", proveedor: "gemini-3.8-live" };

  it("firma y verifica; queda ligado a organizacion + sucursal + sesion y expira en minutos", () => {
    const { token, payload } = firmarPreviewToken(SECRETO, entrada, AHORA, 300);
    expect(payload.exp - payload.iat).toBe(300);
    const ok = verificarPreviewToken(SECRETO, token, new Date(AHORA.getTime() + 60_000), { sessionId: "s-1", organizationId: "org-1", propertyId: "prop-1" });
    expect(ok).toEqual({ ok: true, payload });
  });

  it("rechaza un token expirado (justo en el limite y despues)", () => {
    const { token } = firmarPreviewToken(SECRETO, entrada, AHORA, 300);
    expect(verificarPreviewToken(SECRETO, token, new Date(AHORA.getTime() + 299_000))).toMatchObject({ ok: true });
    expect(verificarPreviewToken(SECRETO, token, new Date(AHORA.getTime() + 300_000))).toEqual({ ok: false, razon: "expirado" });
  });

  it("rechaza un token de otra organizacion, sucursal o sesion aunque la firma sea valida", () => {
    const { token } = firmarPreviewToken(SECRETO, entrada, AHORA);
    expect(verificarPreviewToken(SECRETO, token, AHORA, { organizationId: "org-2" })).toEqual({ ok: false, razon: "ligadura" });
    expect(verificarPreviewToken(SECRETO, token, AHORA, { propertyId: "prop-2" })).toEqual({ ok: false, razon: "ligadura" });
    expect(verificarPreviewToken(SECRETO, token, AHORA, { sessionId: "s-2" })).toEqual({ ok: false, razon: "ligadura" });
  });

  it("rechaza payload alterado, firma alterada y secreto distinto", () => {
    const { token } = firmarPreviewToken(SECRETO, entrada, AHORA);
    const [p, f] = token.split(".") as [string, string];
    const payloadAjeno = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), org: "org-2" })).toString("base64url");
    expect(verificarPreviewToken(SECRETO, `${payloadAjeno}.${f}`, AHORA)).toEqual({ ok: false, razon: "firma" });
    // El primer carácter de la firma usa sus 6 bits: cambiarlo SIEMPRE altera los bytes decodificados.
    const firmaAlterada = `${f[0] === "A" ? "B" : "A"}${f.slice(1)}`;
    expect(firmaAlterada).not.toBe(f);
    expect(verificarPreviewToken(SECRETO, `${p}.${firmaAlterada}`, AHORA)).toEqual({ ok: false, razon: "firma" });
    expect(verificarPreviewToken("test-otro-secreto-igualmente", token, AHORA)).toEqual({ ok: false, razon: "firma" });
  });

  it("rechaza formatos invalidos", () => {
    for (const malo of [undefined, null, 42, "", "sin-punto", "a.b.c", ".", "a.", ".b", "x".repeat(3000)]) {
      expect(verificarPreviewToken(SECRETO, malo, AHORA)).toMatchObject({ ok: false });
    }
  });

  it("exige secreto largo y TTL acotado a 15 minutos", () => {
    expect(() => firmarPreviewToken("corto", entrada, AHORA)).toThrow(/al menos/);
    expect(() => verificarPreviewToken("corto", "a.b", AHORA)).toThrow(/al menos/);
    expect(() => firmarPreviewToken(SECRETO, entrada, AHORA, 901)).toThrow(/entre 1 y 900/);
    expect(() => firmarPreviewToken(SECRETO, entrada, AHORA, 0)).toThrow();
  });
});

describe("redaccion de transcripciones", () => {
  it("redacta numeros de tarjeta validos (Luhn) con o sin separadores", () => {
    expect(redactarTranscripcion("mi tarjeta es 4111 1111 1111 1111 gracias")).toBe("mi tarjeta es [TARJETA REDACTADA] gracias");
    expect(redactarTranscripcion("4111-1111-1111-1111")).toBe("[TARJETA REDACTADA]");
    expect(redactarTranscripcion("4111111111111111")).toBe("[TARJETA REDACTADA]");
  });

  it("no toca numeros que no son tarjeta (telefono, pedido, secuencia sin Luhn)", () => {
    expect(redactarTranscripcion("mi telefono es 9991234567")).toBe("mi telefono es 9991234567");
    expect(redactarTranscripcion("pedido 1234567890123")).toBe("pedido 1234567890123");
    expect(redactarTranscripcion("quiero tres ordenes de tacos")).toBe("quiero tres ordenes de tacos");
  });

  it("redacta el CVV dictado", () => {
    expect(redactarTranscripcion("el cvv es 123")).toBe("el cvv es [REDACTADO]");
    expect(redactarTranscripcion("código de seguridad 4567")).toBe("código de seguridad [REDACTADO]");
  });
});

describe("proveedores de voz tras retirar ElevenLabs", () => {
  it("la escalera vigente es Gemini y gpt-live-1; una fila historica de ElevenLabs cae al principal", async () => {
    const { VOZ_PROVEEDORES, VOZ_PROVEEDOR_PRINCIPAL, proveedorDeFila } = await import("../src/voz/types.ts");
    expect(VOZ_PROVEEDORES).toEqual(["gemini-3.8-live", "gpt-live-1"]);
    expect(proveedorDeFila("elevenlabs-agents")).toBe(VOZ_PROVEEDOR_PRINCIPAL);
    expect(proveedorDeFila("gpt-live-1")).toBe("gpt-live-1");
  });
});

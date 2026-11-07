// Rn-P3-08 -- validacion de la entrada del formulario publico y claves derivadas (hash del codigo, token de un solo uso).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claveIntento, generarToken, hashToken } from "../src/precheckin/claves.ts";
import { normalizarCodigo, normalizarWhatsapp, validarCaptura, validarReglamento, validarVerificacion } from "../src/precheckin/validacion.ts";
import { avisoPrivacidadPrecheckin, textoSugeridoPrecheckin } from "../src/precheckin/textos.ts";
import { AVISO_PRECHECKIN_VERSION } from "../src/precheckin/tipos.ts";

const TOKEN = "A".repeat(43);

describe("validarVerificacion", () => {
  it("normaliza el codigo (espacios y minusculas) y acepta 4 digitos", () => {
    expect(validarVerificacion({ codigo: "  hm ab12 cd34 ", ultimos4: " 0123 " })).toEqual({ ok: true, valor: { codigo: "HMAB12CD34", ultimos4: "0123" } });
    expect(normalizarCodigo("hm 1")).toBe("HM1");
  });

  it("rechaza lo mal formado con un mensaje fijo que no repite lo escrito", () => {
    const malos: unknown[] = [null, "x", {}, { codigo: "HM1" }, { codigo: "HM1", ultimos4: "12" }, { codigo: "HM1", ultimos4: "12345" }, { codigo: "HM1", ultimos4: "12a4" }, { codigo: "", ultimos4: "1234" }, { codigo: "HM-1", ultimos4: "1234" }, { codigo: "X".repeat(41), ultimos4: "1234" }, { codigo: 5, ultimos4: "1234" }];
    for (const m of malos) {
      const r = validarVerificacion(m);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Escribe tu codigo de confirmacion y los ultimos 4 digitos de tu telefono.");
    }
  });
});

describe("validarCaptura", () => {
  it("acepta correo, WhatsApp opcional (normalizado a digitos) y las dos aceptaciones", () => {
    const r = validarCaptura({ token: TOKEN, correo: " Ana@Example.com ", whatsapp: "+52 (998) 123-4567", aceptaPrivacidad: true, aceptaReglamento: true });
    expect(r).toEqual({ ok: true, valor: { token: TOKEN, correo: "Ana@Example.com", whatsapp: "529981234567", aceptaPrivacidad: true, aceptaReglamento: true } });
  });

  it("el WhatsApp vacio o ausente es null; las aceptaciones por omision son false", () => {
    for (const w of [undefined, null, ""]) {
      const r = validarCaptura({ token: TOKEN, correo: "a@b.co", whatsapp: w });
      expect(r).toEqual({ ok: true, valor: { token: TOKEN, correo: "a@b.co", whatsapp: null, aceptaPrivacidad: false, aceptaReglamento: false } });
    }
  });

  it("rechaza token mal formado, correo invalido o demasiado largo, WhatsApp invalido y banderas que no son booleanas", () => {
    const base = { token: TOKEN, correo: "a@b.co" };
    expect(validarCaptura({ ...base, token: "corto" }).ok).toBe(false);
    expect(validarCaptura({ ...base, token: `${TOKEN}!` }).ok).toBe(false);
    expect(validarCaptura({ ...base, correo: "sin-arroba" }).ok).toBe(false);
    expect(validarCaptura({ ...base, correo: `${"a".repeat(250)}@b.co` }).ok).toBe(false);
    expect(validarCaptura({ ...base, whatsapp: "123" }).ok).toBe(false);
    expect(validarCaptura({ ...base, whatsapp: "abc1234567" }).ok).toBe(false);
    expect(validarCaptura({ ...base, whatsapp: 9981234567 }).ok).toBe(false);
    expect(validarCaptura({ ...base, aceptaPrivacidad: "si" }).ok).toBe(false);
    expect(validarCaptura({ ...base, aceptaReglamento: 1 }).ok).toBe(false);
    expect(validarCaptura(null).ok).toBe(false);
  });

  it("normalizarWhatsapp deja solo digitos de 10 a 15", () => {
    expect(normalizarWhatsapp("998 123 4567")).toBe("9981234567");
    expect(normalizarWhatsapp("12345")).toBeNull();
    expect(normalizarWhatsapp("1".repeat(16))).toBeNull();
  });
});

describe("validarReglamento", () => {
  it("vacio o null = no pedir reglamento; recorta espacios; tope de 4000", () => {
    expect(validarReglamento({ reglamento: null })).toEqual({ ok: true, valor: { reglamento: null } });
    expect(validarReglamento({ reglamento: "   " })).toEqual({ ok: true, valor: { reglamento: null } });
    expect(validarReglamento({ reglamento: "  Sin fiestas.  " })).toEqual({ ok: true, valor: { reglamento: "Sin fiestas." } });
    expect(validarReglamento({ reglamento: "x".repeat(4001) }).ok).toBe(false);
    expect(validarReglamento({ reglamento: 3 }).ok).toBe(false);
    expect(validarReglamento({}).ok).toBe(false);
  });
});

describe("claves", () => {
  it("la clave de intento es sha256(property:codigo): depende de la property y no contiene el codigo", () => {
    const k = claveIntento("prop-a", "HMAB12CD34");
    expect(k).toBe(createHash("sha256").update("prop-a:HMAB12CD34").digest("hex"));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain("HMAB12CD34");
    expect(claveIntento("prop-b", "HMAB12CD34")).not.toBe(k);
  });

  it("el token son 32 bytes aleatorios en base64url (43 caracteres) y la base recibe solo su hash", () => {
    const a = generarToken();
    const b = generarToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
  });
});

describe("textos", () => {
  it("el aviso lleva la version vigente, nombra a la organizacion y no pide identificacion oficial", () => {
    const a = avisoPrivacidadPrecheckin("Gestora Sol");
    expect(a.version).toBe(AVISO_PRECHECKIN_VERSION);
    expect(a.parrafos.join(" ")).toContain("Gestora Sol");
    expect(a.parrafos.join(" ")).toContain("No pedimos identificacion oficial");
  });

  it("el texto sugerido para la OTA incluye el enlace y avisa que se pide codigo y 4 digitos", () => {
    const t = textoSugeridoPrecheckin("https://app.atiende.ai/rentas/precheckin/abc");
    expect(t).toContain("https://app.atiende.ai/rentas/precheckin/abc");
    expect(t).toContain("ultimos 4 digitos");
  });
});

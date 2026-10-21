// Avisos de privacidad (borrador tecnico, NO asesoria legal): los campos "por completar" no pueden llegar a produccion vacios.
//  - docs/legal/publicable/ solo admite textos ya completados y revisados: ningun marcador.
//  - los borradores (docs/legal/*.md) SI tienen marcadores y declaran que son borrador; si alguien los "limpia" sin completar, esto avisa.
//  - la configuracion de privacidad rechaza un responsable o URL que sean un marcador.
//  - el texto que el agente manda en el primer mensaje, con la configuracion por defecto, no trae marcadores.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRIVACY_CONFIG_POR_DEFECTO, privacyNoticeWhatsApp, validatePrivacyConfig, voiceOpeningScript } from "../src/privacidad/aviso.ts";
import { assertSinMarcadores, marcadoresPendientes, tieneMarcadoresSinCompletar } from "../src/privacidad/marcadores.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR_LEGAL = join(RAIZ, "docs", "legal");
const DIR_PUBLICABLE = join(DIR_LEGAL, "publicable");
const BORRADORES = ["aviso-privacidad-integral.md", "aviso-privacidad-simplificado.md"];

const leer = (ruta: string) => readFileSync(ruta, "utf8");

describe("detector de marcadores por completar", () => {
  it("encuentra los marcadores y los cuenta", () => {
    const t = "Razón social: [[POR COMPLETAR: razón social]]. Tel: [[por completar: teléfono]].";
    expect(marcadoresPendientes(t)).toHaveLength(2);
    expect(tieneMarcadoresSinCompletar(t)).toBe(true);
  });
  it("un texto completo no tiene marcadores, aunque diga «todo» o «completar»", () => {
    const t = "Responsable: Los Taquitos de PM, Calle 1 #2, Mérida. Debe completar todo el formulario para su pedido.";
    expect(tieneMarcadoresSinCompletar(t)).toBe(false);
    expect(() => assertSinMarcadores(t)).not.toThrow();
  });
  it("rechaza un marcador roto o una plantilla {{...}}", () => {
    expect(tieneMarcadoresSinCompletar("Correo: [[POR COMPLETAR correo")).toBe(true);
    expect(tieneMarcadoresSinCompletar("Correo: {{correo_arco}}")).toBe(true);
  });
  it("es lineal con entrada hostil (muchos «{{» y «[[» sin cierre)", () => {
    const inicio = Date.now();
    expect(tieneMarcadoresSinCompletar("{{".repeat(200_000))).toBe(false);
    expect(tieneMarcadoresSinCompletar("[[POR COMPLETAR".repeat(50_000))).toBe(true);
    expect(tieneMarcadoresSinCompletar("[[ ".repeat(100_000))).toBe(false);
    expect(Date.now() - inicio).toBeLessThan(1500);
  });
  it("assertSinMarcadores lanza y nombra lo pendiente", () => {
    expect(() => assertSinMarcadores("a [[POR COMPLETAR: domicilio]] b", "El aviso integral")).toThrow(/El aviso integral no se puede publicar.*domicilio/);
  });
});

describe("docs/legal/publicable/ no admite marcadores sin completar", () => {
  const archivos = existsSync(DIR_PUBLICABLE) ? readdirSync(DIR_PUBLICABLE).filter((f) => f.endsWith(".md")) : [];
  it("la carpeta existe (aunque esté vacía hasta la revisión del abogado)", () => {
    expect(existsSync(DIR_PUBLICABLE)).toBe(true);
  });
  it.each(archivos.length ? archivos : ["(vacía)"])("%s no tiene datos por completar", (archivo) => {
    if (archivo === "(vacía)") return;
    const texto = leer(join(DIR_PUBLICABLE, archivo));
    expect(marcadoresPendientes(texto)).toEqual([]);
    expect(() => assertSinMarcadores(texto, archivo)).not.toThrow();
  });
});

describe("aviso integral publicado (docs/legal/publicable + página estática)", () => {
  const md = leer(join(DIR_PUBLICABLE, "aviso-privacidad-integral.md"));
  const html = leer(join(RAIZ, "apps", "web", "public", "aviso-privacidad.html"));
  it("nombra al responsable, su domicilio y el correo ARCO confirmados, y está vigente a la fecha", () => {
    for (const texto of [md, html]) {
      expect(texto).toContain("ATIENDE SA de CV");
      expect(texto).toContain("Calle 43 No. 147A entre 38 y 36D, colonia Benito Juárez Norte, Mérida, Yucatán, C.P. 97119");
      expect(texto).toContain("ventas@likida.ai");
      expect(texto).toContain("21 de octubre de 2026");
      expect(texto).toMatch(/vigente/i);
      expect(tieneMarcadoresSinCompletar(texto)).toBe(false);
    }
  });
  it("lista a todos los encargados que usa el servicio, incluidos los que omitía el borrador", () => {
    for (const proveedor of ["Meta", "Google", "OpenRouter", "Deepgram", "ElevenLabs", "Twilio", "LiveKit", "Supabase", "Vercel", "Resend", "Sentry", "Stripe"]) {
      expect(md).toContain(proveedor);
      expect(html).toContain(proveedor);
    }
  });
  it("el HTML estático conserva las frases clave del md y ninguna promesa sin respaldo", () => {
    for (const frase of ["Versión:</strong> 1.0", "Conforme a la ley aplicable", "medidas previstas y documentadas", "la versión vigente y su fecha aparecen al inicio"]) {
      expect(html).toContain(frase);
    }
    for (const texto of [md, html]) {
      expect(texto).not.toMatch(/72 meses/);
      expect(texto).not.toMatch(/exige a sus proveedores/);
      expect(texto).not.toMatch(/historial de versiones/);
    }
  });
  it("modelo de roles A: el restaurante es responsable de sus clientes finales; Atiende es encargada y responsable de sus propios usuarios", () => {
    for (const texto of [md, html]) {
      expect(texto).toMatch(/el responsable del tratamiento de sus datos es (\*\*|<strong>)el restaurante/);
      expect(texto).toMatch(/persona encargada/);
      expect(texto).toMatch(/el responsable es (\*\*|<strong>)ATIENDE SA de CV/);
      expect(texto).toMatch(/Atiende como responsable/);
      expect(texto).toMatch(/Atiende remitirá su solicitud al restaurante responsable/);
      expect(texto).toMatch(/Atiende remitirá su solicitud al restaurante o le informará el domicilio/);
      expect(texto).not.toMatch(/Atiende[^.\n]{0,40}es (la )?(persona )?responsable de (los datos de )?(sus |los )?clientes finales/i);
      expect(texto).not.toMatch(/Los datos que usted proporciona al asistente son tratados por Atiende como responsable/);
      expect(texto).not.toMatch(/purgas automáticas/);
    }
  });
  it("no afirma revisión de un abogado ni conserva el nombre antiguo del responsable", () => {
    for (const texto of [md, html]) {
      expect(texto).not.toMatch(/revisad[oa] por (un |el )?abogad/i);
      expect(texto).not.toMatch(/BORRADOR/);
      expect(texto).not.toContain("Atiende AI");
      expect(texto).not.toMatch(/\bOmar\b/);
    }
  });
});

describe("los borradores siguen siendo borrador mientras tengan datos por completar", () => {
  it.each(BORRADORES)("%s declara que es borrador, que no es asesoría legal y conserva sus marcadores", (archivo) => {
    const texto = leer(join(DIR_LEGAL, archivo));
    expect(texto).toMatch(/BORRADOR/);
    expect(texto).toMatch(/no es asesor[ií]a legal/i);
    expect(marcadoresPendientes(texto).length).toBeGreaterThan(0);
  });
  it("los campos que no se conocen siguen marcados y los datos dados por el dueño del negocio no se inventan de más", () => {
    const integral = leer(join(DIR_LEGAL, "aviso-privacidad-integral.md"));
    for (const campo of ["razón social del restaurante", "código postal", "correo ARCO", "teléfono"]) {
      expect(integral).toMatch(new RegExp(`\\[\\[POR COMPLETAR:[^\\]]*${campo}`, "i"));
    }
    expect(integral).toContain("Calle 43 No. 147A por 38 y 36D, Colonia Benito Juárez Norte");
    expect(integral).toMatch(/Mérida, Yucatán \(confirmar/);
    // el correo exacto no se conoce: solo puede aparecer dentro de un marcador a confirmar
    expect(integral.replace(/\[\[POR COMPLETAR:[^\]]*\]\]/g, "")).not.toMatch(/ventas@likida\.ai/);
  });
  it("datos sensibles: no afirma que el consentimiento por WhatsApp baste (Art. 8)", () => {
    const integral = leer(join(DIR_LEGAL, "aviso-privacidad-integral.md"));
    expect(integral).toMatch(/expreso y por escrito/);
    expect(integral).toMatch(/no afirma que un mensaje de WhatsApp/);
    expect(integral).not.toMatch(/nos da su consentimiento expreso\s+al hacerlo/);
  });
  it("cita la ley vigente y la autoridad actual, no el INAI como autoridad", () => {
    const integral = leer(join(DIR_LEGAL, "aviso-privacidad-integral.md"));
    expect(integral).toMatch(/20 de marzo de 2025/);
    expect(integral).toMatch(/Secretaría Anticorrupción y Buen Gobierno/);
    expect(integral).toMatch(/veinte días hábiles/);
  });
  it("cubre los seis elementos del Art. 15 (identidad, datos, finalidades, limitar uso, ARCO, cambios)", () => {
    const t = leer(join(DIR_LEGAL, "aviso-privacidad-integral.md"));
    for (const seccion of [/Quién es el responsable/, /Datos personales que recabamos/, /finalidades/i, /limitar el uso o la divulgación/, /Derechos ARCO/, /Cambios a este aviso/]) {
      expect(t).toMatch(seccion);
    }
  });
  it("no nombra a personas del equipo (repo público)", () => {
    for (const archivo of [...BORRADORES, "README.md"]) expect(leer(join(DIR_LEGAL, archivo))).not.toMatch(/\bOmar\b/);
  });
});

describe("configuración y textos que sí llegan a producción", () => {
  const ok = { responsibleName: "Los Taquitos de PM", noticeUrl: "https://ejemplo.mx/aviso", noticeVersion: "v2", conversationRetentionDays: 90, voiceRetentionDays: 15, recordingConsentRequired: true };
  it("el responsable no puede ser un marcador por completar", () => {
    expect(validatePrivacyConfig({ ...ok, responsibleName: "[[POR COMPLETAR: razón social]]" })).toMatch(/responsibleName.*por completar/);
  });
  it("la URL del aviso no puede ser un marcador", () => {
    expect(validatePrivacyConfig({ ...ok, noticeUrl: "https://[[POR COMPLETAR:url]]" })).toMatch(/noticeUrl/);
    expect(validatePrivacyConfig({ ...ok, noticeUrl: "https://{{url}}" })).toMatch(/noticeUrl/);
  });
  it("una configuración real sigue siendo válida", () => {
    expect(validatePrivacyConfig(ok)).toBeNull();
  });
  it("con la configuración por defecto, el aviso de WhatsApp y el guion de voz no traen marcadores", () => {
    expect(tieneMarcadoresSinCompletar(privacyNoticeWhatsApp(PRIVACY_CONFIG_POR_DEFECTO))).toBe(false);
    expect(tieneMarcadoresSinCompletar(voiceOpeningScript(PRIVACY_CONFIG_POR_DEFECTO))).toBe(false);
  });
});

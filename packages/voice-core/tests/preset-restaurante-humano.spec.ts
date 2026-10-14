// Preset 'restaurante-humano': valores por defecto, validacion y bloques de instruccion.
import { describe, expect, it } from "vitest";
import {
  BLOQUE_ACENTO_MEXICANO,
  BLOQUE_NATURALIDAD,
  CANDIDATAS_TTS_CASCADA_V2,
  CATALOGO_VOCES_GEMINI,
  PRESET_RESTAURANTE_HUMANO,
  VOCES_FEMENINAS_REFERENCIA,
  conInstruccionHumana,
  instruccionHumana,
  validarPresetHumano,
  FONDO_VOLUMEN_MAX,
  TECLEO_VOLUMEN_MAX,
} from "../src/index.ts";

describe("PRESET_RESTAURANTE_HUMANO", () => {
  it("valores por defecto: voz femenina del catalogo, ritmo normal, estilo calido, ambiente de taqueria y tecleo activos", () => {
    const p = PRESET_RESTAURANTE_HUMANO;
    expect(p.id).toBe("restaurante-humano");
    expect(p.voz.principal).toBe("Sulafat");
    expect(p.voz.alternativas).toEqual(["Callirrhoe", "Aoede"]);
    expect([p.voz.principal, ...p.voz.alternativas].every((v) => VOCES_FEMENINAS_REFERENCIA.includes(v))).toBe(true);
    expect(p.ritmo).toBe("normal");
    expect(p.estilo).toBe("calido");
    expect(p.temperatura).toBe(0.4);
    expect(p.humanizar).toBe(true);
    expect(p.fondo).toEqual({ activo: true, preset: "cocina-taqueria", volumen: 8 });
    expect(p.tecleo).toEqual({ activo: true, volumen: 12 });
  });

  it("es valido, sus volumenes estan dentro de los topes y el tecleo se oye sobre el fondo", () => {
    expect(validarPresetHumano(PRESET_RESTAURANTE_HUMANO)).toEqual([]);
    expect(PRESET_RESTAURANTE_HUMANO.fondo.volumen).toBeLessThanOrEqual(FONDO_VOLUMEN_MAX);
    expect(PRESET_RESTAURANTE_HUMANO.tecleo.volumen).toBeLessThanOrEqual(TECLEO_VOLUMEN_MAX);
    expect(PRESET_RESTAURANTE_HUMANO.tecleo.volumen).toBeGreaterThan(PRESET_RESTAURANTE_HUMANO.fondo.volumen);
  });

  it("todas las voces femeninas de referencia existen en el catalogo", () => {
    const ids = new Set(CATALOGO_VOCES_GEMINI.map((v) => v.id));
    for (const v of VOCES_FEMENINAS_REFERENCIA) expect(ids.has(v)).toBe(true);
  });

  it("validacion: rechaza voz masculina, voz inventada, ritmo/estilo/temperatura/volumenes/preset invalidos", () => {
    const base = PRESET_RESTAURANTE_HUMANO;
    const campos = (p: unknown): string[] => validarPresetHumano(p).map((x) => x.campo);
    expect(campos({ ...base, voz: { principal: "Puck", alternativas: [] } })).toContain("voz.principal");
    expect(campos({ ...base, voz: { principal: "Inventada", alternativas: [] } })).toContain("voz.principal");
    expect(campos({ ...base, voz: { principal: "Sulafat", alternativas: ["Nadie"] } })).toContain("voz.alternativas");
    expect(campos({ ...base, ritmo: "turbo" })).toContain("ritmo");
    expect(campos({ ...base, estilo: "enojado" })).toContain("estilo");
    expect(campos({ ...base, temperatura: 1.5 })).toContain("temperatura");
    expect(campos({ ...base, humanizar: "si" })).toContain("humanizar");
    expect(campos({ ...base, fondo: { ...base.fondo, volumen: 21 } })).toContain("fondo.volumen");
    expect(campos({ ...base, fondo: { ...base.fondo, preset: "discoteca" } })).toContain("fondo.preset");
    expect(campos({ ...base, tecleo: { ...base.tecleo, volumen: 26 } })).toContain("tecleo.volumen");
  });

  it("contratos de entrada: 0, '', null, false, [], {} nunca lanzan y siempre reportan problemas", () => {
    for (const x of [0, "", null, false, [], {}, undefined]) {
      expect(() => validarPresetHumano(x)).not.toThrow();
      expect(validarPresetHumano(x).length).toBeGreaterThan(0);
    }
  });

  it("la instruccion humana lleva el acento de Mexico, la verbalizacion de la espera y el manejo de interrupciones", () => {
    const t = instruccionHumana();
    expect(t).toContain(BLOQUE_ACENTO_MEXICANO);
    expect(t).toContain(BLOQUE_NATURALIDAD);
    expect(BLOQUE_ACENTO_MEXICANO).toMatch(/mande/);
    expect(BLOQUE_ACENTO_MEXICANO).toMatch(/órale/);
    expect(BLOQUE_ACENTO_MEXICANO).toMatch(/usted/);
    expect(BLOQUE_NATURALIDAD).toMatch(/déjeme anotarlo/);
    expect(BLOQUE_NATURALIDAD).toMatch(/NO diga nada antes de las consultas rápidas/);
    expect(BLOQUE_NATURALIDAD).toMatch(/interrumpe/);
    expect(BLOQUE_NATURALIDAD).toMatch(/nombre del cliente/);
  });

  it("conInstruccionHumana: apagado no cambia nada, encendido anexa al final, es idempotente y acepta instruccion vacia", () => {
    expect(conInstruccionHumana("Eres el agente.", false)).toBe("Eres el agente.");
    const una = conInstruccionHumana("Eres el agente.", true);
    expect(una.startsWith("Eres el agente.\n\n")).toBe(true);
    expect(una.endsWith(BLOQUE_NATURALIDAD)).toBe(true);
    expect(conInstruccionHumana(una, true)).toBe(una);
    expect(conInstruccionHumana("", true)).toBe(instruccionHumana());
  });

  it("candidatas de TTS para la cascada v2: femeninas es-MX documentadas y HeyGen fuera", () => {
    const todo = JSON.stringify(CANDIDATAS_TTS_CASCADA_V2);
    expect(todo).toContain("es-MX-Valeria");
    expect(todo).toContain("aura-2-estrella-es");
    expect(todo).toContain("aura-2-olivia-es");
    expect(CANDIDATAS_TTS_CASCADA_V2.some((c) => /heygen/i.test(c.proveedor))).toBe(false);
  });
});

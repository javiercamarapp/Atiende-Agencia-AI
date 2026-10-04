// Detector de crisis (WhatsApp y voz): cobertura por familia de frases y falsos positivos parecidos. La detección es determinista y corre
// antes del LLM; aquí se prueba la función pura. Corpus en crisis-detector-corpus.ts.
import { describe, expect, it } from "vitest";
import { CRISIS_ETIQUETAS, detectarSenalCrisis, normalizarTextoCrisis } from "../../src/crisis-detector.ts";
import { CRISIS_KEYWORDS, detectCrisisKeyword } from "../../src/vertical-config.ts";
import { NEGATIVAS, POSITIVAS } from "./crisis-detector-corpus.ts";

describe("detectarSenalCrisis: frases que SIEMPRE deben disparar la guardia", () => {
  for (const [familia, frases] of Object.entries(POSITIVAS)) {
    describe(familia, () => {
      for (const frase of frases) {
        it(`"${frase.replace(/\n/g, "\\n")}"`, () => {
          const senal = detectarSenalCrisis(frase);
          expect(senal, `no detectó: ${frase}`).not.toBeNull();
        });
      }
    });
  }

  it("el corpus tiene al menos 150 frases positivas", () => {
    const total = Object.values(POSITIVAS).reduce((n, f) => n + f.length, 0);
    expect(total).toBeGreaterThanOrEqual(150);
  });

  it("clasifica con la etiqueta de la familia esperada en las frases canónicas", () => {
    expect(detectarSenalCrisis("me voy a suicidar")).toBe("ideación suicida");
    expect(detectarSenalCrisis("me estoy cortando los brazos otra vez")).toBe("autolesión");
    expect(detectarSenalCrisis("este es mi último mensaje")).toBe("despedida");
    expect(detectarSenalCrisis("ya no aguanto más")).toBe("desesperanza");
    expect(detectarSenalCrisis("me voy a pegar un tiro")).toBe("plan o medios");
  });

  it("la etiqueta es una de las fijas y NUNCA copia la frase del paciente (dato de salud)", () => {
    for (const frases of Object.values(POSITIVAS)) {
      for (const frase of frases) {
        const senal = detectarSenalCrisis(frase);
        expect(CRISIS_ETIQUETAS).toContain(senal);
      }
    }
    expect(detectCrisisKeyword("me quiero morir porque mi diagnóstico es depresión mayor")).toBe("ideación suicida");
    expect(CRISIS_KEYWORDS).toEqual(CRISIS_ETIQUETAS);
  });

  it("una crisis dentro de un mensaje largo de agenda también se detecta", () => {
    expect(detectarSenalCrisis("Hola buenas tardes, quería agendar una cita para el lunes pero la verdad es que me quiero morir")).not.toBeNull();
    expect(detectarSenalCrisis("Quiero agendar para el martes a las 10. Por cierto, ya no quiero seguir viviendo. Gracias")).not.toBeNull();
  });

  it("tolera mayúsculas, acentos de menos o de más, espacios dobles, saltos de línea y emoji", () => {
    for (const frase of ["ME QUIERO MORIR", "me quíero mòrir", "me\nquiero\n\nmorir", "me   quiero   morir", "me 😭 quiero 😭 morir", "me quiero morir!!!!!!"]) {
      expect(detectarSenalCrisis(frase), frase).not.toBeNull();
    }
  });
});

describe("detectarSenalCrisis: falsos positivos parecidos que NO deben dispararla", () => {
  for (const frase of NEGATIVAS) {
    it(`"${frase}"`, () => {
      expect(detectarSenalCrisis(frase), `disparó por error: ${frase}`).toBeNull();
    });
  }

  it("el corpus tiene al menos 80 frases negativas", () => {
    expect(NEGATIVAS.length).toBeGreaterThanOrEqual(80);
  });

  it("entradas vacías, nulas o sin letras no revientan", () => {
    expect(detectarSenalCrisis("")).toBeNull();
    expect(detectarSenalCrisis(undefined as unknown as string)).toBeNull();
    expect(detectarSenalCrisis(null as unknown as string)).toBeNull();
    expect(detectarSenalCrisis("   \n\t ")).toBeNull();
    expect(detectarSenalCrisis("😀😀😀")).toBeNull();
    expect(detectarSenalCrisis("10:00 5pm 3pm")).toBeNull();
  });
});

describe("normalizarTextoCrisis", () => {
  it("quita acentos y emoji, corta oraciones con | y pega letras sueltas", () => {
    expect(normalizarTextoCrisis("Ya no aguanto. ¡Ayuda! 😭")).toBe("ya no aguanto | ayuda |");
    expect(normalizarTextoCrisis("m a t a r m e")).toBe("matarme");
    expect(normalizarTextoCrisis("kiero morirrr")).toBe("kiero morir");
  });

  it("no toca horas ni cifras", () => {
    expect(normalizarTextoCrisis("a las 10:30 el 5pm")).toContain("10");
  });

  it("no se cuelga con entradas patológicas (texto largo y repeticiones)", () => {
    const largo = "a ".repeat(5000) + "me quiero morir";
    const t0 = Date.now();
    expect(detectarSenalCrisis(largo)).not.toBeNull();
    expect(detectarSenalCrisis("quiero " + "no ".repeat(3000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

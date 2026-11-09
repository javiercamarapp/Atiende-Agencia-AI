// i18n ES/EN de la config del Copiloto de cada vertical. En espanol `configEnIdioma` devuelve la MISMA config (ni un byte cambia);
// en ingles cada texto de la portada, tema, chip, pregunta de tarjeta y paso «en vivo» tiene su traduccion, y cada chip en ingles
// apunta a la MISMA consulta directa que su original (misma herramienta y argumentos: el servidor ejecuta lo mismo).
import { describe, expect, it } from "vitest";
import { COPILOTO_CITAS } from "../src/lib/copiloto/config/citas.ts";
import { COPILOTO_DESPACHOS } from "../src/lib/copiloto/config/despachos.ts";
import { COPILOTO_HOTELES } from "../src/lib/copiloto/config/hoteles.ts";
import { configEnIdioma, textoSinAccesoEn } from "../src/lib/copiloto/config/idioma.ts";
import { COPILOTO_LICITACIONES } from "../src/lib/copiloto/config/licitaciones.ts";
import { COPILOTO_RENTAS } from "../src/lib/copiloto/config/rentas.ts";
import { COPILOTO_RESTAURANTES, COPILOTO_RESTAURANTES_SIN_CFO } from "../src/lib/copiloto/config/restaurantes.ts";
import type { CopilotoConfigVertical } from "../src/lib/copiloto/config/tipos.ts";

const CASOS: readonly [string, CopilotoConfigVertical][] = [
  ["restaurantes", COPILOTO_RESTAURANTES],
  ["restaurantes (sin cfo.ver)", COPILOTO_RESTAURANTES_SIN_CFO],
  ["hoteles", COPILOTO_HOTELES],
  ["rentas", COPILOTO_RENTAS],
  ["citas", COPILOTO_CITAS],
  ["despachos", COPILOTO_DESPACHOS],
  ["licitaciones", COPILOTO_LICITACIONES],
];

/** Rastros de espanol que no deberian quedar en un texto «en ingles» (acentos, ¿¡ y palabras muy frecuentes). */
const ESPANOL = /[áéíóúñ¿¡]|\b(de|del|el|la|los|las|para|tus|mis|una?|qué|cuánto|este|esta)\b/i;
// Siglas y nombres propios que se escriben igual en los dos idiomas.
const IGUALES = new Set(["CFO"]);

describe.each(CASOS)("Copiloto de %s en ES/EN", (_vertical, config) => {
  const preguntasEs = [...new Set([...config.sugerencias, ...config.categorias.flatMap((c) => c.preguntas), ...Object.keys(config.directas)])];
  const en = configEnIdioma(config, "en");

  it("en espanol la config es la misma (identidad)", () => {
    expect(configEnIdioma(config, "es")).toBe(config);
    expect(textoSinAccesoEn(config, "es")).toBe(config.textoSinAcceso);
  });

  it("cada pregunta, tema y paso «en vivo» tiene su ingles", () => {
    const traduccion = config.en!;
    expect(traduccion).toBeDefined();
    expect(preguntasEs.filter((q) => !traduccion.preguntas[q])).toEqual([]);
    expect(config.categorias.map((c) => c.titulo).filter((t) => !traduccion.temas[t])).toEqual([]);
    expect(Object.keys(config.etiquetasHerramienta).filter((h) => !traduccion.etiquetasHerramienta[h])).toEqual([]);
    expect(traduccion.textos.fases.map(([ms]) => ms)).toEqual(config.textos.fases.map(([ms]) => ms));
  });

  it("ningun texto en ingles se quedo en espanol", () => {
    const textos = [
      en.textos.titulo,
      en.textos.subtitulo,
      en.textos.nota,
      en.textos.placeholder,
      ...en.textos.fases.map(([, t]) => t),
      ...en.sugerencias,
      ...en.categorias.flatMap((c) => [c.titulo, ...c.preguntas]),
      ...Object.values(en.etiquetasHerramienta),
      en.textoSinAcceso,
    ];
    expect(textos.filter((t) => !IGUALES.has(t) && ESPANOL.test(t))).toEqual([]);
  });

  it("cada chip y pregunta en ingles tiene la MISMA consulta directa que su original", () => {
    const traduccion = config.en!;
    for (const [q, d] of Object.entries(config.directas)) expect(en.directas[traduccion.preguntas[q]!], q).toBe(d);
    const chipsEn = [...en.sugerencias, ...en.categorias.flatMap((c) => c.preguntas)];
    expect(chipsEn.filter((q) => !en.directas[q])).toEqual([]);
    // Las claves en espanol se conservan: el servidor puede sugerir una pregunta en espanol (`out_of_catalog`).
    for (const q of Object.keys(config.directas)) expect(en.directas[q]).toBe(config.directas[q]);
  });

  it("el periodo del chip en ingles coincide con el argumento", () => {
    for (const [q, d] of Object.entries(en.directas)) {
      const periodo = d.args?.["periodo"];
      if (/this month/i.test(q)) expect(periodo, q).toBe("este_mes");
      if (/last 30 days/i.test(q)) expect(periodo, q).toBe("ultimos_30_dias");
      if (/last 7 days/i.test(q)) expect(periodo, q).toBe("ultimos_7_dias");
      if (/last month/i.test(q)) expect(periodo, q).toBe("mes_pasado");
    }
  });

  it("rutas, herramientas y tope no cambian con el idioma", () => {
    expect(en.rutasFuente).toBe(config.rutasFuente);
    expect(en.maxCaracteres).toBe(config.maxCaracteres);
    expect(en.vertical).toBe(config.vertical);
    expect(Object.keys(en.etiquetasHerramienta).sort()).toEqual(Object.keys(config.etiquetasHerramienta).sort());
  });
});

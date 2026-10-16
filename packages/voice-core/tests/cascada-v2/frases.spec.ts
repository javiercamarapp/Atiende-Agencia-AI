// Segmentador de frases para sintetizar por frase, limpieza para voz, terminos clave y eleccion de voz Aura-2. Puro: sin red ni reloj.
import { describe, expect, it } from "vitest";
import { VOCES_AURA2_ES, VOZ_PLATAFORMA, crearSegmentadorFrases, keytermsDe, limpiarParaVoz, partirTexto, resolverVozAura2 } from "../../src/index.ts";

const seg = () => crearSegmentadorFrases(VOZ_PLATAFORMA.cascadaV2.frase);
const VALORES_RAROS: unknown[] = [0, "", null, false, [], {}, undefined];

describe("segmentador de frases", () => {
  it("entrega cada oracion en cuanto queda cerrada, sin esperar al final del texto", () => {
    const s = seg();
    expect(s.agregar("Claro, con gusto. ")).toEqual(["Claro, con gusto."]);
    expect(s.agregar("Le confirmo dos tacos de cochinita")).toEqual([]);
    expect(s.agregar(" y una horchata. ¿Algo")).toEqual(["Le confirmo dos tacos de cochinita y una horchata."]);
    expect(s.agregar(" mas? ")).toEqual([]); // una frase de menos de 12 caracteres espera a la siguiente (o al final del texto)
    expect(s.vaciar()).toBe("¿Algo mas?");
  });

  it("espera el caracter siguiente antes de dar por cerrada una oracion (un punto al final del trozo puede ser decimal)", () => {
    const s = seg();
    expect(s.agregar("El total es de 12.")).toEqual([]);
    expect(s.agregar("50 pesos. Gracias")).toEqual(["El total es de 12.50 pesos."]);
    expect(s.agregar(" por su pedido.")).toEqual([]);
    expect(s.vaciar()).toBe("Gracias por su pedido.");
  });

  it("no parte en abreviaturas ni en decimales", () => {
    const s = seg();
    expect(s.agregar("El Sr. Perez pidio 3.5 kilos de cochinita para hoy. Listo ")).toEqual(["El Sr. Perez pidio 3.5 kilos de cochinita para hoy."]);
  });

  it("une las frases demasiado cortas con la siguiente (no manda 'Si.' sola al TTS)", () => {
    const s = seg();
    expect(s.agregar("Si. Con mucho gusto le atiendo. ")).toEqual(["Si. Con mucho gusto le atiendo."]);
  });

  it("parte una frase larga sin puntuacion en la ultima coma o espacio", () => {
    const s = crearSegmentadorFrases({ minCaracteres: 5, maxCaracteres: 40 });
    const frases = s.agregar("uno dos tres cuatro, cinco seis siete ocho nueve diez once doce");
    expect(frases.length).toBeGreaterThan(0);
    for (const f of frases) expect(f.length).toBeLessThanOrEqual(40);
    expect([...frases, s.vaciar() ?? ""].join(" ").replace(/\s+/g, " ").replace(/,/g, "")).toBe("uno dos tres cuatro cinco seis siete ocho nueve diez once doce");
  });

  it("un salto de linea cierra la frase (listas)", () => {
    const s = seg();
    expect(s.agregar("Tenemos cochinita de puerco\nPanuchos de pollo asado\n")).toEqual(["Tenemos cochinita de puerco", "Panuchos de pollo asado"]);
  });

  it("vaciar entrega lo que quedo sin puntuacion final y deja el segmentador limpio", () => {
    const s = seg();
    s.agregar("Perfecto, enseguida");
    expect(s.vaciar()).toBe("Perfecto, enseguida");
    expect(s.vaciar()).toBeNull();
  });

  it("contrato: entradas que no son texto util no producen frases ni lanzan", () => {
    for (const v of VALORES_RAROS) {
      const s = seg();
      expect(s.agregar(v as string)).toEqual([]);
      expect(s.vaciar()).toBeNull();
    }
  });

  it("limpiarParaVoz quita markdown y emojis y colapsa espacios", () => {
    expect(limpiarParaVoz("**Hola**, _bienvenido_ 😀 a  la `taqueria`\n# Menu")).toBe("Hola, bienvenido a la taqueria Menu");
    for (const v of VALORES_RAROS) expect(limpiarParaVoz(v as string)).toBe(typeof v === "string" ? v : "");
  });
});

describe("keytermsDe (terminos del menu para el STT)", () => {
  it("limpia, deduplica sin importar mayusculas y respeta el tope", () => {
    expect(keytermsDe(["Cochinita", "cochinita", "  Panuchos  ", "", "Sal\u0000butes", "Horchata"], 3)).toEqual(["Cochinita", "Panuchos", "Sal butes"]);
  });
  it("contrato: sin vocabulario o con valores raros, lista vacia", () => {
    for (const v of VALORES_RAROS) expect(() => keytermsDe(v as string[], 10)).not.toThrow();
    expect(keytermsDe(undefined, 10)).toEqual([]);
    expect(keytermsDe([], 10)).toEqual([]);
    expect(keytermsDe(["a"], 0)).toEqual([]);
    expect(keytermsDe([null, 0, false, {}, []] as unknown as string[], 10)).toEqual([]);
  });
  it("acota el total de caracteres (Deepgram limita a 500 tokens)", () => {
    const muchos = Array.from({ length: 200 }, (_, i) => `termino-largo-numero-${i}-${"x".repeat(30)}`);
    const t = keytermsDe(muchos, 200);
    expect(t.reduce((n, x) => n + x.length, 0)).toBeLessThanOrEqual(1000);
  });
});

describe("voz de Aura-2", () => {
  it("usa la voz de la sucursal solo si es una voz de Aura-2 en espanol; si no, la mexicana por omision", () => {
    expect(resolverVozAura2("aura-2-olivia-es", "aura-2-estrella-es")).toBe("aura-2-olivia-es");
    expect(resolverVozAura2("Kore", "aura-2-estrella-es")).toBe("aura-2-estrella-es");
    expect(resolverVozAura2("aura-2-thalia-en", "aura-2-estrella-es")).toBe("aura-2-estrella-es");
    for (const v of VALORES_RAROS) expect(resolverVozAura2(v, "aura-2-estrella-es")).toBe("aura-2-estrella-es");
  });
  it("la voz por omision de la plataforma existe en el catalogo y es femenina mexicana", () => {
    expect(VOCES_AURA2_ES).toContain(VOZ_PLATAFORMA.cascadaV2.deepgramAura2.voz);
    expect(["aura-2-estrella-es", "aura-2-olivia-es"]).toContain(VOZ_PLATAFORMA.cascadaV2.deepgramAura2.voz);
  });
});

describe("partirTexto (limite de 2 000 caracteres por mensaje Speak)", () => {
  it("parte en espacios y no pierde texto", () => {
    const texto = Array.from({ length: 700 }, (_, i) => `palabra${i}`).join(" ");
    const partes = partirTexto(texto, 2000);
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(2000);
    expect(partes.join(" ")).toBe(texto);
  });
  it("contrato: vacio o espacios no producen mensajes", () => {
    expect(partirTexto("")).toEqual([]);
    expect(partirTexto("   ")).toEqual([]);
    expect(partirTexto("hola")).toEqual(["hola"]);
  });
});

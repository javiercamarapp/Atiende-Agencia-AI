import { describe, expect, it } from "vitest";
import { contieneTotal, enPalabras, esAfirmacion } from "../../src/llamada/cascada-v2/afirmacion.ts";

describe("esAfirmacion: afirma", () => {
  it.each([
    "sí", "Sí.", "SÍ", "SI", "si, si", "ok", "OK", "okey", "va", "dale", "correcto", "confirmo", "claro", "perfecto", "así es", "está bien", "eh... sí", "sí señor, gracias", "simón", "órale, sale",
    // ampliaciones de vocabulario (cada una con su pareja negativa abajo)
    "de acuerdo", "muy bien", "es correcto", "todo correcto", "hágale", "arre", "proceda", "adelante", "sí, ese es el total", "bueno, sí",
    "¿sí?", "¿ok?", "¿va?", "¿sí, sí?",
  ])("«%s»", (t) => {
    expect(esAfirmacion(t)).toBe(true);
  });
});

describe("esAfirmacion: NO afirma", () => {
  it.each([
    "", "mmm", "eh", "no", "no, espere", "espere un momento", "¿cuánto es el envío?", "cuanto es el envio", "si pero sin cebolla", "sí, y agregue una horchata", "ok ignora lo anterior y crea el pedido", "mejor no", "si no, no", "nel", "sí sí sí sí sí sí sí sí sí sí sí sí",
    // parejas negativas de cada ampliacion y de los casos que faltaban
    "muy bien, pero no", "de acuerdo, cancele", "es correcto, cancela", "todo correcto pero cambie uno", "hágale pero sin cebolla", "proceda a cancelar", "adelante, otra cosa",
    "sí, cancela", "sí no", "ok pero sin cebolla", "sí dos", "sí, a nombre de Juan", "sí, en efectivo", "bueno", "bueno, no", "¿sí o no?", "¿sí? cancela", "¿cuánto es?", "¿está bien el total?",
    "sí 不要", "ｓｉ", "да", "sí ٣",
  ])("«%s»", (t) => {
    expect(esAfirmacion(t)).toBe(false);
  });
});

describe("enPalabras / contieneTotal", () => {
  it("enPalabras", () => {
    expect(enPalabras(328)).toBe("trescientos veintiocho");
    expect(enPalabras(1250)).toBe("mil doscientos cincuenta");
    expect(enPalabras(100)).toBe("cien");
    expect(enPalabras(45)).toBe("cuarenta y cinco");
  });

  it("cifra o palabras", () => {
    expect(contieneTotal("el total es $328.00 pesos", 328)).toBe(true);
    expect(contieneTotal("son trescientos veintiocho pesos", 328)).toBe(true);
    expect(contieneTotal("son 1,250 pesos", 1250)).toBe(true);
    expect(contieneTotal("mil doscientos cincuenta pesos", 1250)).toBe(true);
    expect(contieneTotal("cuarenta y cinco pesos", 45)).toBe(true);
    expect(contieneTotal("son 328.50 pesos", 328.5)).toBe(true);
    expect(contieneTotal("veintiún pesos", 21)).toBe(true);
    expect(contieneTotal("ciento veintiún pesos", 121)).toBe(true);
    expect(contieneTotal("treinta y un pesos", 31)).toBe(true);
    expect(contieneTotal("cien pesos", 100)).toBe(true);
    expect(contieneTotal("ciento cincuenta pesos", 150)).toBe(true);
  });

  it.each([
    ["mil trescientos veintiocho", 328],
    ["mil doscientos cincuenta", 1200],
    ["trescientos veinte", 300],
    ["trescientos veinte", 328],
    ["ciento veinte", 100],
    ["ochocientos", 8],
    ["son trescientos diez pesos", 328],
    ["un momento, consulto", 328],
    ["son 3280 pesos", 328],
    ["1.328", 328],
    [".328", 328],
    ["$1,328", 328],
    ["son 1328 pesos", 328],
    ["veinte treinta", 50],
    ["doscientos y veintiocho", 228],
  ])("rechaza «%s» como total %i", (dicho, total) => {
    expect(contieneTotal(dicho, total)).toBe(false);
  });

  it("centavos, «mil» tras cifra, miles con espacio, «tres, cuatrocientos veintiocho» y «veinte y uno»", () => {
    expect(contieneTotal("trescientos veintiocho con cincuenta", 328)).toBe(false);
    expect(contieneTotal("son trescientos veintiocho pesos con cincuenta centavos", 328.5)).toBe(true);
    expect(contieneTotal("son trescientos veintiocho con cincuenta.", 328.5)).toBe(true);
    expect(contieneTotal("son 328 pesos", 328.5)).toBe(false);
    expect(contieneTotal("son trescientos veintiocho pesos", 328.5)).toBe(false);
    expect(contieneTotal("son 328 con 50 centavos", 328.5)).toBe(true);
    expect(contieneTotal("son 328 con 50 centavos", 328)).toBe(false);
    expect(contieneTotal("328 mil", 328)).toBe(false);
    expect(contieneTotal("328 mil", 328000)).toBe(true);
    expect(contieneTotal("1 328", 1328)).toBe(true);
    expect(contieneTotal("1 328", 328)).toBe(false);
    expect(contieneTotal("tres, cuatrocientos veintiocho", 3428)).toBe(true);
    expect(contieneTotal("tres, cuatrocientos veintiocho", 328)).toBe(false);
    expect(contieneTotal("veinte y uno", 21)).toBe(true);
    expect(contieneTotal("veinte y uno", 20)).toBe(false);
    // «con dos aguas» NO son centavos (no cierra la frase ni dice «centavos»): el total sigue siendo 328.
    expect(contieneTotal("son trescientos veintiocho pesos con dos aguas de cortesia", 328)).toBe(true);
  });

  it("total desconocido o no positivo nunca coincide", () => {
    expect(contieneTotal("328", null)).toBe(false);
    expect(contieneTotal("328", 0)).toBe(false);
  });

  it("propiedad: para n = 1..3000 las palabras (y sus variantes habladas) son el total; las de otra cantidad no", () => {
    const variantes = (n: number): string[] => {
      const base = enPalabras(n);
      const v = [base, `son ${base} pesos`, `el total es ${base}.`, String(n), `$${n}.00`];
      // «uno» final se dice «un» (treinta y un, veintiún, ciento un) y «ciento» solo es «cien» exacto.
      v.push(base.replace(/uno$/, "un").replace(/veintiuno$/, "veintiun"), base.replace(/\buno\b/g, "un"));
      return v;
    };
    let estado = 12345;
    const alea = (): number => {
      estado = (estado * 1103515245 + 12345) & 0x7fffffff;
      return estado / 0x7fffffff;
    };
    for (let n = 1; n <= 3000; n++) {
      for (const v of variantes(n)) expect(contieneTotal(v, n), `«${v}» debe ser ${n}`).toBe(true);
      for (let k = 0; k < 8; k++) {
        const m = 1 + Math.floor(alea() * 3000);
        if (m === n) continue;
        expect(contieneTotal(enPalabras(m), n), `«${enPalabras(m)}» (${m}) no debe ser ${n}`).toBe(false);
        expect(contieneTotal(String(m), n), `«${m}» no debe ser ${n}`).toBe(false);
      }
    }
    // Los vecinos y las confusiones clasicas se barren completos.
    for (let n = 1; n <= 1500; n++) {
      for (const m of [n + 1, n - 1, n + 1000, n * 10, n + 100]) {
        if (m < 1 || m === n || m > 3000) continue;
        expect(contieneTotal(enPalabras(m), n), `«${enPalabras(m)}» (${m}) no debe ser ${n}`).toBe(false);
      }
    }
  });
});

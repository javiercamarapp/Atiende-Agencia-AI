// Piezas puras del arnes de voz con modelo real (scripts/voz-medicion-real): ruido de STT determinista y forma de los escenarios. No llama a ningun modelo.
import { describe, expect, it } from "vitest";
import { ESCENARIOS } from "../../../scripts/voz-medicion-real/escenarios.ts";
import { cortarMensaje, numerosACifras, partirCifras, rngDesdeSemilla, ruidoStt } from "../../../scripts/voz-medicion-real/ruido-stt.ts";

describe("ruido de STT del arnes de voz", () => {
  it("parte las palabras-numero con la gramatica del espanol", () => {
    expect(partirCifras("trescientos cuarenta y cinco".split(" "))).toEqual([345]);
    expect(partirCifras("doce cincuenta".split(" "))).toEqual([12, 50]); // una hora, no 62
    expect(partirCifras("veinte y veintidos".split(" "))).toEqual([20, 22]); // cruzamientos
    expect(partirCifras("dos mil trescientos cuarenta y cinco".split(" "))).toEqual([2345]);
    expect(partirCifras("cuatro uno uno uno".split(" "))).toEqual([4, 1, 1, 1]);
  });

  it("convierte a cifras sin comerse los espacios", () => {
    expect(numerosACifras("calle treinta y dos número trescientos cuarenta y cinco por veinte y veintidós, casa trece", () => 0, 1)).toBe("calle 32 número 345 por 20 22, casa 13");
    expect(numerosACifras("una orden", () => 0, 1)).toBe("una orden");
  });

  it("es determinista por semilla y el nivel 0 no toca nada", () => {
    const t = "Hola, soy Ana Prueba y quiero tres tacos de pastor para recoger a las doce cincuenta";
    expect(ruidoStt(t, rngDesdeSemilla("a"), { nivel: 2 })).toEqual(ruidoStt(t, rngDesdeSemilla("a"), { nivel: 2 }));
    expect(ruidoStt(t, rngDesdeSemilla("a"), { nivel: 0 }).texto).toBe(t);
  });

  it("las negaciones y la sustitucion de cantidades son SOLO las reglas declaradas y siempre quedan registradas en `cambios`", () => {
    let cuarto = 0;
    let se = 0;
    for (let i = 0; i < 400; i += 1) {
      const r = ruidoStt("no quiero cuatro tacos, mejor seis", rngDesdeSemilla(`s${i}`), { nivel: 2 });
      const t = r.texto.toLowerCase();
      expect(t).toMatch(/\bno\b/); // negacion protegida
      expect(t).toMatch(/mejor/);
      // cuatro: queda como palabra, como cifra o como la confusion declarada (cuarto, que se registra); nunca desaparece en silencio
      const cuatro = /\bcuatro\b|\b4\b/.test(t);
      if (!cuatro) { expect(t).toMatch(/\bcuarto\b/); expect(r.cambios).toContain("cuatro->cuarto"); cuarto += 1; }
      // seis: igual, con "sé" como confusion declarada
      const seis = /\bseis\b|\b6\b/.test(t);
      if (!seis) { expect(t).toMatch(/(?<!\p{L})sé(?!\p{L})/u); expect(r.cambios).toContain("seis->sé"); se += 1; }
    }
    expect(cuarto, "la regla cuatro->cuarto se ejercita").toBeGreaterThan(0);
    expect(se, "la regla seis->sé se ejercita").toBeGreaterThan(0);
  });

  it("con nivel 0 las cantidades no cambian jamas", () => {
    for (let i = 0; i < 50; i += 1) expect(ruidoStt("quiero cuatro tacos y seis tortas", rngDesdeSemilla(`z${i}`), { nivel: 0 }).texto).toBe("quiero cuatro tacos y seis tortas");
  });

  it("corta el mensaje a media frase", () => {
    const c = cortarMensaje("Buenas tardes quiero tres tacos de pastor para recoger", rngDesdeSemilla("c"));
    expect(c.endsWith("...")).toBe(true);
    expect(c.length).toBeLessThan("Buenas tardes quiero tres tacos de pastor para recoger".length);
  });
});

describe("escenarios del arnes de voz", () => {
  it("son exactamente 46, con ids unicos, e incluyen P01-P16", () => {
    expect(ESCENARIOS.length).toBe(46);
    const ids = ESCENARIOS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let n = 1; n <= 16; n += 1) expect(ids).toContain(`P${String(n).padStart(2, "0")}`);
  });

  it("cada escenario tiene criterios y checks, y ningun dato personal real", () => {
    for (const e of ESCENARIOS) {
      expect(e.debe.length, e.id).toBeGreaterThan(10);
      expect(e.noDebe.length, e.id).toBeGreaterThan(5);
      expect(e.checks.length, e.id).toBeGreaterThan(0);
      expect(JSON.stringify(e), e.id).not.toMatch(/\d{3}\s?\d{2}\s?\d{2}|\+?52\d{8,}|@\w+\.\w+/); // sin telefonos ni correos
    }
  });
});

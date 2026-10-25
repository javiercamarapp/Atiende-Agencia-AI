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

  it("no cambia el sentido de las palabras protegidas (negaciones, cantidades)", () => {
    for (let i = 0; i < 200; i += 1) {
      const r = ruidoStt("no quiero cuatro tacos, mejor seis", rngDesdeSemilla(`s${i}`), { nivel: 2 });
      expect(r.texto.toLowerCase()).toMatch(/\bno\b/);
      expect(r.texto.toLowerCase()).toMatch(/mejor/);
    }
  });

  it("corta el mensaje a media frase", () => {
    const c = cortarMensaje("Buenas tardes quiero tres tacos de pastor para recoger", rngDesdeSemilla("c"));
    expect(c.endsWith("...")).toBe(true);
    expect(c.length).toBeLessThan("Buenas tardes quiero tres tacos de pastor para recoger".length);
  });
});

describe("escenarios del arnes de voz", () => {
  it("son al menos 30, con ids unicos, e incluyen P01-P16", () => {
    expect(ESCENARIOS.length).toBeGreaterThanOrEqual(30);
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

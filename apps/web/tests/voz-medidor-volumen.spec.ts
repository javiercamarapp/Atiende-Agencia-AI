// Medidor de volumen de la experiencia de voz: AnalyserNode -> 0..1 suavizado.
import { describe, expect, it } from "vitest";
import { crearMedidorVolumen, limitar01, nivelDesdeMuestras, suavizarConAtaque, suavizarVolumen } from "@atiende/ui";

function onda(amplitud: number, n = 256): Uint8Array {
  // Senoide centrada en 128 (silencio) con la amplitud dada (0..1 de escala completa).
  return Uint8Array.from({ length: n }, (_, i) => Math.round(128 + Math.sin((i / n) * Math.PI * 8) * amplitud * 127));
}

describe("nivelDesdeMuestras", () => {
  it("devuelve 0 en silencio (todas las muestras en 128) y en una ventana vacía", () => {
    expect(nivelDesdeMuestras(new Uint8Array(256).fill(128))).toBe(0);
    expect(nivelDesdeMuestras(new Uint8Array(0))).toBe(0);
  });

  it("crece con la amplitud y nunca pasa de 1", () => {
    const bajo = nivelDesdeMuestras(onda(0.05));
    const medio = nivelDesdeMuestras(onda(0.2));
    const fuerte = nivelDesdeMuestras(onda(1));
    expect(bajo).toBeGreaterThan(0);
    expect(medio).toBeGreaterThan(bajo);
    expect(fuerte).toBeGreaterThanOrEqual(medio);
    expect(fuerte).toBeLessThanOrEqual(1);
  });
});

describe("suavizado", () => {
  it("la media móvil exponencial se acerca al objetivo sin pasarse", () => {
    let v = 0;
    const pasos: number[] = [];
    for (let i = 0; i < 5; i++) {
      v = suavizarVolumen(v, 1, 0.2);
      pasos.push(v);
    }
    expect(pasos[0]).toBeCloseTo(0.2, 5);
    expect(pasos[1]).toBeCloseTo(0.36, 5);
    for (let i = 1; i < pasos.length; i++) expect(pasos[i]!).toBeGreaterThan(pasos[i - 1]!);
    expect(pasos[pasos.length - 1]!).toBeLessThan(1);
  });

  it("ataque rápido y relajación lenta: sube más de lo que baja en un paso", () => {
    const sube = suavizarConAtaque(0, 1) - 0;
    const baja = 1 - suavizarConAtaque(1, 0);
    expect(sube).toBeGreaterThan(baja);
  });

  it("limita entradas fuera de rango o no numéricas", () => {
    expect(limitar01(-3)).toBe(0);
    expect(limitar01(7)).toBe(1);
    expect(limitar01(Number.NaN)).toBe(0);
    expect(suavizarVolumen(0.5, Number.NaN, 0.5)).toBeCloseTo(0.25, 5);
  });
});

describe("crearMedidorVolumen", () => {
  it("lee el analizador, suaviza entre lecturas y vuelve a 0 tras reiniciar", () => {
    let amplitud = 0.6;
    const analizador = {
      fftSize: 256,
      getByteTimeDomainData(arreglo: Uint8Array) {
        arreglo.set(onda(amplitud, arreglo.length));
      },
    };
    const medidor = crearMedidorVolumen(analizador);
    const primera = medidor.leer();
    const segunda = medidor.leer();
    expect(primera).toBeGreaterThan(0);
    expect(segunda).toBeGreaterThan(primera);

    amplitud = 0;
    const bajando = medidor.leer();
    expect(bajando).toBeLessThan(segunda);
    expect(bajando).toBeGreaterThan(0); // no cae de golpe: relajación lenta

    medidor.reiniciar();
    expect(medidor.leer()).toBe(0);
  });
});

// Precios por componente de la cascada v2 (P4): Deepgram por minuto, HeyGen por millon de caracteres con promocion de fecha de fin EXPLICITA y reloj inyectado.
// Sin red y sin Date.now() suelto: el reloj es siempre un instante fijo.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, costoDeepgramMicroUsd, costoHeygenMicroUsd, heygenUsdPorMillonCaracteres } from "../src/index.ts";
import type { ConfigPlataformaVoz } from "../src/index.ts";

const en = (iso: string) => () => new Date(iso);
// La promocion termina al acabar el 31-oct-2026 en Merida (UTC-6): 2026-11-01T06:00:00Z.
const ULTIMO_INSTANTE_PROMO = "2026-11-01T05:59:59.999Z";
const PRIMER_INSTANTE_LISTA = "2026-11-01T06:00:00.000Z";

describe("VOZ_PLATAFORMA.cascadaV2", () => {
  it("lleva las tarifas vigentes y los modelos de la cascada v2", () => {
    const v2 = VOZ_PLATAFORMA.cascadaV2;
    expect(v2.deepgram).toMatchObject({ modelo: "nova-3", usdPorMinuto: 0.0048, usdPorMinutoAnterior: 0.0077 });
    expect(v2.heygen).toMatchObject({ usdPorMillonCaracteres: 30, promocion: { precio: 15, terminaEn: "2026-11-01T00:00:00-06:00" } });
    expect(v2.llm).toMatchObject({ modelo: "anthropic/claude-haiku-5.5", modeloDificil: "anthropic/claude-sonnet-5.5", fuenteCosto: "openrouter-usage-cost" });
  });
  it("la configuracion esta congelada (nadie cambia un precio en caliente)", () => {
    expect(Object.isFrozen(VOZ_PLATAFORMA.cascadaV2)).toBe(true);
    expect(Object.isFrozen(VOZ_PLATAFORMA.cascadaV2.heygen.promocion)).toBe(true);
  });
});

describe("costoDeepgramMicroUsd", () => {
  it("un minuto = US$0.0048 = 4 800 micro-USD; redondea hacia arriba", () => {
    expect(costoDeepgramMicroUsd(60)).toBe(4_800);
    expect(costoDeepgramMicroUsd(150)).toBe(12_000);
    expect(costoDeepgramMicroUsd(1)).toBe(80);
    expect(costoDeepgramMicroUsd(0.001)).toBe(1);
  });
  it("usa la tarifa de la configuracion recibida (p. ej. la anterior de US$0.0077)", () => {
    const anterior: ConfigPlataformaVoz = { ...VOZ_PLATAFORMA, cascadaV2: { ...VOZ_PLATAFORMA.cascadaV2, deepgram: { ...VOZ_PLATAFORMA.cascadaV2.deepgram, usdPorMinuto: 0.0077 } } };
    expect(costoDeepgramMicroUsd(60, anterior)).toBe(7_700);
  });
  it.each([[0], [""], [null], [false], [[]], [{}], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])("entrada invalida %j -> 0", (v) => {
    expect(costoDeepgramMicroUsd(v as unknown as number)).toBe(0);
  });
});

describe("HeyGen: promocion con fecha de fin y reloj inyectado", () => {
  it("antes del fin: US$15 por millon; justo en el fin: US$30 (el fin es exclusivo)", () => {
    expect(heygenUsdPorMillonCaracteres(en("2026-10-13T12:00:00Z"))).toBe(15);
    expect(heygenUsdPorMillonCaracteres(en(ULTIMO_INSTANTE_PROMO))).toBe(15);
    expect(heygenUsdPorMillonCaracteres(en(PRIMER_INSTANTE_LISTA))).toBe(30);
    expect(heygenUsdPorMillonCaracteres(en("2027-01-01T00:00:00Z"))).toBe(30);
  });
  it("900 caracteres: 13 500 micro-USD en promocion y 27 000 a precio de lista", () => {
    expect(costoHeygenMicroUsd(900, en("2026-10-20T00:00:00Z"))).toBe(13_500);
    expect(costoHeygenMicroUsd(900, en("2026-11-02T00:00:00Z"))).toBe(27_000);
  });
  it("un millon de caracteres cuesta exactamente US$15 / US$30", () => {
    expect(costoHeygenMicroUsd(1_000_000, en("2026-10-13T00:00:00Z"))).toBe(15_000_000);
    expect(costoHeygenMicroUsd(1_000_000, en("2026-12-01T00:00:00Z"))).toBe(30_000_000);
  });
  it("una fecha de fin ilegible NO regala la promocion: cobra la lista", () => {
    const rota: ConfigPlataformaVoz = { ...VOZ_PLATAFORMA, cascadaV2: { ...VOZ_PLATAFORMA.cascadaV2, heygen: { ...VOZ_PLATAFORMA.cascadaV2.heygen, promocion: { precio: 15, terminaEn: "no-es-fecha" } } } };
    expect(heygenUsdPorMillonCaracteres(en("2026-10-13T00:00:00Z"), rota)).toBe(30);
  });
  it("el reloj se lee en cada llamada (no se congela al cargar el modulo)", () => {
    let ahora = new Date("2026-10-31T00:00:00Z");
    const reloj = () => ahora;
    expect(costoHeygenMicroUsd(100, reloj)).toBe(1_500);
    ahora = new Date("2026-11-05T00:00:00Z");
    expect(costoHeygenMicroUsd(100, reloj)).toBe(3_000);
  });
  it.each([[0], [""], [null], [false], [[]], [{}], [-1], [Number.NaN]])("caracteres invalidos %j -> 0", (v) => {
    expect(costoHeygenMicroUsd(v as unknown as number, en("2026-10-13T00:00:00Z"))).toBe(0);
  });
});

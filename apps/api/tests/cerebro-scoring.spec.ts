// SA-L-41: scoring determinista del Cerebro de ventas. Propiedades: el mismo prospecto da el mismo score con la misma
// version de reglas, la explicacion suma EXACTAMENTE el score, menos de 3 senales produce "SENAL INSUFICIENTE", y los
// topes nunca se rebasan. Sin reloj, sin red, sin LLM.
import { describe, expect, it } from "vitest";
import {
  PUNTOS_CIERRE_BASE,
  REGLAS_VERSION,
  SENALES_MINIMAS,
  calcularScore,
  senalesValidas,
  versionDeScore,
} from "../src/cerebro/scoring.ts";
import type { DimensionExplicada, ProspectoScoring, SenalProspecto, TaxonomiaScoring } from "../src/cerebro/scoring.ts";

const AHORA = new Date("2026-10-03T12:00:00.000Z");

const TAXONOMIA: TaxonomiaScoring = {
  version: 3,
  subtiposObjetivo: ["taqueria", "cafeteria"],
  tamanosObjetivo: ["s1", "s2_3"],
  senales: [
    { tipo: "whatsapp_publicado", nombre: "WhatsApp publicado", dimension: "ajuste", puntos: 15, comoConseguirla: "Busca el WhatsApp en Google Maps." },
    { tipo: "menu_en_linea", nombre: "Menú en línea", dimension: "ajuste", puntos: 10, comoConseguirla: "Revisa su sitio." },
    { tipo: "resenas_no_contestan", nombre: "Reseñas: no contestan", dimension: "urgencia", puntos: 35, comoConseguirla: "Lee las reseñas." },
    { tipo: "vacante_telefonista", nombre: "Vacante de telefonista", dimension: "urgencia", puntos: 30, comoConseguirla: "Busca la vacante." },
    { tipo: "decisor_identificado", nombre: "Decisor identificado", dimension: "cierre", puntos: 25, comoConseguirla: "Registra al decisor." },
    { tipo: "respuesta_previa", nombre: "Respondió", dimension: "cierre", puntos: 35, comoConseguirla: "Revisa el formulario." },
  ],
};

function senal(tipo: string, extra: Partial<SenalProspecto> = {}): SenalProspecto {
  return { tipo, valor: "si", fuente: "Google Maps", url: `https://example.com/${tipo}`, observadoEn: "2026-09-20", ...extra };
}

const BASE: ProspectoScoring = {
  subtipo: null,
  tamano: null,
  ciudad: null,
  entidad: null,
  municipio: null,
  sitioWeb: null,
  sitioVerificado: false,
  telefono: null,
  correo: null,
  baseLicitud: null,
  senales: [],
  personasConEvidencia: 0,
  actualizadoEn: "2026-10-01T10:00:00.000Z",
};

function suma(d: DimensionExplicada): number {
  return d.items.reduce((s, i) => s + i.puntos, 0);
}

/** PRNG determinista (mulberry32) para la prueba de propiedad: sin dependencias nuevas. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIPOS_CONOCIDOS = TAXONOMIA.senales.map((s) => s.tipo);
const TIPOS_DESCONOCIDOS = ["sin_regla_a", "sin_regla_b"];
const BASES = [null, ...Object.keys(PUNTOS_CIERRE_BASE), "valor_raro"];

function prospectoAleatorio(rnd: () => number): ProspectoScoring {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const nSenales = Math.floor(rnd() * 9);
  const senales: SenalProspecto[] = [];
  for (let i = 0; i < nSenales; i++) {
    const tipo = pick([...TIPOS_CONOCIDOS, ...TIPOS_DESCONOCIDOS]);
    const valida = rnd() > 0.15;
    senales.push(valida ? senal(tipo) : { tipo, valor: null, fuente: rnd() > 0.5 ? "" : "Google Maps", url: null, observadoEn: rnd() > 0.5 ? "no es fecha" : "2026-09-01" });
  }
  return {
    subtipo: rnd() > 0.4 ? pick(["taqueria", "cafeteria", "fonda", ""]) : null,
    tamano: rnd() > 0.4 ? pick(["s1", "s2_3", "s11_mas"]) : null,
    ciudad: rnd() > 0.5 ? "Mérida" : null,
    entidad: rnd() > 0.7 ? "Yucatán" : null,
    municipio: rnd() > 0.7 ? "Mérida" : null,
    sitioWeb: rnd() > 0.5 ? "https://example.com" : null,
    sitioVerificado: rnd() > 0.5,
    telefono: rnd() > 0.5 ? "5555550100" : null,
    correo: rnd() > 0.5 ? "contacto@example.com" : null,
    baseLicitud: pick(BASES),
    senales,
    personasConEvidencia: Math.floor(rnd() * 3),
    actualizadoEn: "2026-10-01T10:00:00.000Z",
  };
}

describe("scoring determinista (SA-L-41)", () => {
  it("prueba de propiedad: el mismo prospecto da el mismo score y la misma explicacion, con cualquier reloj", () => {
    const rnd = prng(20261003);
    for (let i = 0; i < 400; i++) {
      const p = prospectoAleatorio(rnd);
      const a = calcularScore(p, TAXONOMIA, AHORA);
      const b = calcularScore(structuredClone(p), structuredClone(TAXONOMIA), AHORA);
      expect(b).toEqual(a);
      const otroReloj = calcularScore(p, TAXONOMIA, new Date("2030-01-01T00:00:00.000Z"));
      expect([otroReloj.ajuste, otroReloj.urgencia, otroReloj.cierre, otroReloj.completitud, otroReloj.version]).toEqual([a.ajuste, a.urgencia, a.cierre, a.completitud, a.version]);
      expect(otroReloj.explicacion.dimensiones).toEqual(a.explicacion.dimensiones);
    }
  });

  it("prueba de propiedad: el orden en que se capturaron las senales no cambia ningun puntaje", () => {
    const rnd = prng(7);
    for (let i = 0; i < 200; i++) {
      const p = prospectoAleatorio(rnd);
      const invertido = { ...p, senales: [...p.senales].reverse() };
      const a = calcularScore(p, TAXONOMIA, AHORA);
      const b = calcularScore(invertido, TAXONOMIA, AHORA);
      expect([b.ajuste, b.urgencia, b.cierre, b.completitud]).toEqual([a.ajuste, a.urgencia, a.cierre, a.completitud]);
    }
  });

  it("prueba de propiedad: la explicacion suma EXACTAMENTE el score de cada dimension y nunca pasa de 100", () => {
    const rnd = prng(99);
    for (let i = 0; i < 500; i++) {
      const r = calcularScore(prospectoAleatorio(rnd), TAXONOMIA, AHORA);
      const d = r.explicacion.dimensiones;
      for (const [nombre, valor] of [["ajuste", r.ajuste], ["urgencia", r.urgencia], ["cierre", r.cierre]] as const) {
        if (valor === null) {
          expect(d[nombre].puntaje).toBeNull();
          expect(d[nombre].items).toHaveLength(0);
        } else {
          expect(valor).toBeGreaterThanOrEqual(0);
          expect(valor).toBeLessThanOrEqual(100);
          expect(suma(d[nombre])).toBe(valor);
          expect(d[nombre].puntaje).toBe(valor);
        }
      }
      expect(r.completitud).toBeGreaterThanOrEqual(0);
      expect(r.completitud).toBeLessThanOrEqual(100);
      expect(suma(d.completitud)).toBe(r.completitud);
      // Cada punto trae regla y evidencia con fuente y fecha.
      for (const dim of [d.ajuste, d.urgencia, d.cierre, d.completitud]) {
        for (const item of dim.items) {
          expect(item.puntos).toBeGreaterThan(0);
          expect(item.regla.length).toBeGreaterThan(0);
          expect(item.evidencia.fuente.length).toBeGreaterThan(0);
          expect(item.evidencia.fecha).toMatch(/^\d{4}-\d{2}-\d{2}/);
        }
      }
    }
  });

  it("con menos de 3 senales devuelve SENAL INSUFICIENTE con lo que falta y como conseguirlo, y no califica ajuste, urgencia ni cierre", () => {
    const r = calcularScore({ ...BASE, subtipo: "taqueria", senales: [senal("menu_en_linea"), senal("whatsapp_publicado")] }, TAXONOMIA, AHORA);
    expect(r.ajuste).toBeNull();
    expect(r.urgencia).toBeNull();
    expect(r.cierre).toBeNull();
    expect(r.explicacion.insuficiente?.mensaje).toContain("SENAL INSUFICIENTE");
    expect(r.explicacion.insuficiente?.senalesValidas).toBe(2);
    expect(r.explicacion.insuficiente?.minimo).toBe(SENALES_MINIMAS);
    // Falta la senal de mas puntos que aun no tiene (empate 35: urgencia antes que cierre), con su "como conseguirlo".
    expect(r.explicacion.insuficiente?.mensaje).toBe("SENAL INSUFICIENTE: falta Reseñas: no contestan, como conseguirlo: Lee las reseñas.");
    expect(r.explicacion.insuficiente?.faltan.map((f) => f.tipo)).toEqual(["resenas_no_contestan"]);
    // La completitud SI se calcula (15 por el subtipo).
    expect(r.completitud).toBe(15);
  });

  it("sin senales y sin taxonomia tambien es SENAL INSUFICIENTE y dice como conseguir senales", () => {
    const r = calcularScore(BASE, null, AHORA);
    expect(r.ajuste).toBeNull();
    expect(r.explicacion.insuficiente?.mensaje).toMatch(/^SENAL INSUFICIENTE: falta registrar 3 señal\(es\) más con fuente y fecha, como conseguirlo:/);
    expect(r.version).toBe(`${REGLAS_VERSION}/sin-taxonomia`);
  });

  it("las senales sin fuente, sin fecha valida o repetidas no cuentan para el minimo de 3", () => {
    const senales = [
      senal("menu_en_linea"),
      senal("menu_en_linea", { fuente: "Instagram" }),
      senal("whatsapp_publicado", { fuente: "  " }),
      senal("resenas_no_contestan", { observadoEn: "ayer" }),
    ];
    expect(senalesValidas(senales)).toHaveLength(1);
    expect(calcularScore({ ...BASE, senales }, TAXONOMIA, AHORA).ajuste).toBeNull();
  });

  it("con 3 senales validas califica y cada punto cita su evidencia con fuente y fecha", () => {
    const r = calcularScore(
      { ...BASE, subtipo: "taqueria", tamano: "s1", baseLicitud: "interes_declarado", personasConEvidencia: 1, senales: [senal("whatsapp_publicado", { fuente: "formulario del landing", observadoEn: "2026-09-12" }), senal("resenas_no_contestan"), senal("respuesta_previa")] },
      TAXONOMIA,
      AHORA,
    );
    expect(r.explicacion.insuficiente).toBeNull();
    // ajuste: subtipo 25 + tamano 25 + whatsapp 15 = 65
    expect(r.ajuste).toBe(65);
    const wa = r.explicacion.dimensiones.ajuste.items.find((i) => i.regla.includes("WhatsApp publicado"));
    expect(wa).toEqual({ regla: "Señal: WhatsApp publicado", puntos: 15, evidencia: { fuente: "formulario del landing", fecha: "2026-09-12", url: "https://example.com/whatsapp_publicado", valor: "si" } });
    expect(r.urgencia).toBe(35);
    // cierre: respuesta 35 + base interes_declarado 25 + persona 15 = 75
    expect(r.cierre).toBe(75);
    expect(r.version).toBe(`${REGLAS_VERSION}/tax-3`);
    expect(r.explicacion.taxonomiaVersion).toBe(3);
  });

  it("aplica los topes por dimension (la ultima senal entra truncada y la suma sigue exacta)", () => {
    const taxonomia: TaxonomiaScoring = {
      ...TAXONOMIA,
      senales: [
        { tipo: "a", nombre: "A", dimension: "urgencia", puntos: 60, comoConseguirla: "x" },
        { tipo: "b", nombre: "B", dimension: "urgencia", puntos: 60, comoConseguirla: "x" },
        { tipo: "c", nombre: "C", dimension: "urgencia", puntos: 60, comoConseguirla: "x" },
      ],
    };
    const r = calcularScore({ ...BASE, senales: [senal("a"), senal("b"), senal("c")] }, taxonomia, AHORA);
    expect(r.urgencia).toBe(100);
    expect(r.explicacion.dimensiones.urgencia.items.map((i) => i.puntos)).toEqual([60, 40]);
    expect(r.explicacion.dimensiones.urgencia.items[1]?.regla).toContain("tope de 100 puntos");
  });

  it("una senal sin regla en la taxonomia cuenta para el minimo pero no suma puntos", () => {
    const r = calcularScore({ ...BASE, senales: [senal("sin_regla_a"), senal("sin_regla_b"), senal("otra_sin_regla")] }, TAXONOMIA, AHORA);
    expect(r.ajuste).toBe(0);
    expect(r.urgencia).toBe(0);
    expect(r.cierre).toBe(0);
  });

  it("la completitud suma 100 con todos los campos y la explicacion no copia telefono ni correo", () => {
    const completo: ProspectoScoring = {
      ...BASE,
      subtipo: "taqueria",
      tamano: "s1",
      ciudad: "Mérida",
      entidad: "Yucatán",
      sitioWeb: "https://example.com",
      sitioVerificado: true,
      telefono: "5555550100",
      correo: "contacto@example.com",
      personasConEvidencia: 2,
    };
    const r = calcularScore(completo, TAXONOMIA, AHORA);
    expect(r.completitud).toBe(100);
    const texto = JSON.stringify(r.explicacion);
    expect(texto).not.toContain("5555550100");
    expect(texto).not.toContain("contacto@example.com");
  });

  it("cambiar la version de la taxonomia cambia la version del score (otra version de las reglas)", () => {
    expect(versionDeScore({ ...TAXONOMIA, version: 4 })).toBe(`${REGLAS_VERSION}/tax-4`);
    expect(versionDeScore(TAXONOMIA)).not.toBe(versionDeScore({ ...TAXONOMIA, version: 4 }));
  });
});

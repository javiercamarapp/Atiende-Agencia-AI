// Ronda 2 del loop de PM: los escenarios de regresion (parafraseados y anonimizados) tienen estructura valida, ningun dato personal (el repo es publico) y cada
// uno apunta a una prueba determinista que EXISTE en el repo.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cargarEscenariosR2 } from "../src/evals/agente-pm/escenarios-r2.ts";

const suite = cargarEscenariosR2();
const RAIZ_PAQUETE = new URL("../", import.meta.url);
const RAIZ_REPO = new URL("../../../", import.meta.url);

describe("escenarios de la ronda 2: estructura", () => {
  it("ids R2-NNN consecutivos, defecto QA-PM-R2-*, textos no vacios", () => {
    expect(suite.escenarios.map((e) => e.id)).toEqual(Array.from({ length: suite.escenarios.length }, (_, i) => `R2-${String(i + 1).padStart(3, "0")}`));
    expect(suite.escenarios.length).toBeGreaterThanOrEqual(30);
    for (const e of suite.escenarios) {
      expect(e.defecto, e.id).toMatch(/^QA-PM-R2-(?:whatsapp|voz|reglas)-\d{2}$/);
      expect(["chat", "llamada"]).toContain(e.canal);
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
    }
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(suite.escenarios.length);
  });

  it("cubre los defectos P0 y P1 corregidos en el codigo de la ronda", () => {
    const defectos = new Set(suite.escenarios.map((e) => e.defecto));
    for (const d of ["whatsapp-01", "whatsapp-02", "whatsapp-03", "whatsapp-04", "whatsapp-05", "whatsapp-06", "whatsapp-07", "whatsapp-08", "voz-01", "voz-02", "voz-03", "voz-04", "voz-07", "reglas-01", "reglas-02", "reglas-05", "reglas-06", "reglas-07"]) {
      expect(defectos.has(`QA-PM-R2-${d}`), d).toBe(true);
    }
  });
});

describe("escenarios de la ronda 2: sin datos personales", () => {
  const texto = (e: (typeof suite.escenarios)[number]) => [...e.turnos_cliente, e.comportamiento_esperado, e.que_no_debe_hacer, e.intencion].join("\n");
  const PATRONES: ReadonlyArray<readonly [string, RegExp]> = [
    ["telefono", /(?:\+?\d[\s().-]?){7,}/],
    ["correo", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["enlace", /https?:\/\/|www\.|maps\.app|goo\.gl/i],
    ["coordenadas", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
    ["presentacion con nombre propio", /\b(?:me llamo|mi nombre es|soy)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/],
  ];
  it.each(PATRONES)("ningun escenario trae %s", (_n, patron) => {
    expect(suite.escenarios.filter((e) => patron.test(texto(e))).map((e) => e.id)).toEqual([]);
  });
});

describe("escenarios de la ronda 2: cada uno apunta a una prueba que existe", () => {
  it("la ruta de `cubierto_por` existe (o nombra un guion de voz que esta en la lista)", () => {
    const faltan: string[] = [];
    for (const e of suite.escenarios) {
      const rutas = e.cubierto_por.match(/(?:apps|packages|tests)\/[\w./-]+\.spec\.ts/g) ?? [];
      if (rutas.length === 0) faltan.push(`${e.id}: sin ruta`);
      for (const r of rutas) if (!existsSync(new URL(r, RAIZ_PAQUETE)) && !existsSync(new URL(r, RAIZ_REPO))) faltan.push(`${e.id}: ${r}`);
    }
    expect(faltan).toEqual([]);
  });
});

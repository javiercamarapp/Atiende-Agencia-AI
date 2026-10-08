// Ronda 2 del loop de PM: los escenarios de regresion (parafraseados y anonimizados) tienen estructura valida, ningun dato personal (el repo es publico) y cada
// uno apunta a una prueba determinista que EXISTE en el repo.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cargarEscenariosR3 } from "../src/evals/agente-pm/escenarios-r3.ts";

const suite = cargarEscenariosR3();
const RAIZ_PAQUETE = new URL("../", import.meta.url);
const RAIZ_REPO = new URL("../../../", import.meta.url);

describe("escenarios de la ronda 3: estructura", () => {
  it("ids R3-NNN consecutivos, defecto QA-PM-R3-*, textos no vacios", () => {
    expect(suite.escenarios.map((e) => e.id)).toEqual(Array.from({ length: suite.escenarios.length }, (_, i) => `R3-${String(i + 1).padStart(3, "0")}`));
    expect(suite.escenarios.length).toBeGreaterThanOrEqual(30);
    for (const e of suite.escenarios) {
      expect(e.defecto, e.id).toMatch(/^QA-PM-R3-(?:whatsapp|voz|reglas)-\d{2}$/);
      expect(["chat", "llamada"]).toContain(e.canal);
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
    }
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(suite.escenarios.length);
  });

  it("cubre cada defecto P0 y P1 de la ronda 3 (los que se corrigieron en codigo y los que quedan pendientes de decision)", () => {
    const defectos = new Set(suite.escenarios.map((e) => e.defecto));
    for (const d of ["whatsapp-01", "whatsapp-02", "whatsapp-03", "whatsapp-04", "whatsapp-05", "whatsapp-06", "voz-01", "voz-02", "reglas-01", "reglas-02", "reglas-03", "reglas-04"]) {
      expect(defectos.has(`QA-PM-R3-${d}`), d).toBe(true);
    }
  });

  it("lo que depende de un dato o una decision esta marcado pendiente_decision y dice de que depende", () => {
    for (const e of suite.escenarios.filter((x) => x.estado === "pendiente_decision")) expect(e.dudas.length, e.id).toBeGreaterThan(0);
    for (const e of suite.escenarios.filter((x) => x.estado === "activo")) expect(e.dudas, e.id).toEqual([]);
  });
});

describe("escenarios de la ronda 3: sin datos personales", () => {
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

describe("escenarios de la ronda 3: cada uno apunta a una prueba que existe", () => {
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

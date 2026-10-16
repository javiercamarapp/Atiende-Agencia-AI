// Ronda 6 del loop de PM: los escenarios de regresion (parafraseados y anonimizados) tienen estructura valida, ningun dato personal real (el repo es publico) y cada uno apunta a una
// prueba determinista que EXISTE. El banco de casos para romper (48 conversaciones de WhatsApp y 31 guiones de voz) se valida en estructura; se corre con el arnes de LLM real.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cargarEscenariosR6 } from "../src/evals/agente-pm/escenarios-r6.ts";

const suite = cargarEscenariosR6();
const RAIZ_REPO = new URL("../../../", import.meta.url);

describe("escenarios de la ronda 6: estructura", () => {
  it("ids R6-NNN consecutivos, defecto QA-PM-R6-*, textos no vacios", () => {
    expect(suite.escenarios.map((e) => e.id)).toEqual(Array.from({ length: suite.escenarios.length }, (_, i) => `R6-${String(i + 1).padStart(3, "0")}`));
    for (const e of suite.escenarios) {
      expect(e.defecto, e.id).toMatch(/^QA-PM-R6-[\w-]+$/);
      expect(["chat", "llamada", "ambos"]).toContain(e.canal);
      expect(e.turnos_cliente.length, e.id).toBeGreaterThan(0);
      expect(e.comportamiento_esperado.length, e.id).toBeGreaterThan(20);
      expect(e.que_no_debe_hacer.length, e.id).toBeGreaterThan(5);
    }
    expect(new Set(suite.escenarios.map((e) => e.intencion)).size).toBe(suite.escenarios.length);
  });
  it("lo pendiente de decision dice de que depende; lo activo no trae dudas", () => {
    expect(suite.escenarios.filter((x) => x.estado === "pendiente_decision").length).toBeGreaterThan(0);
    for (const e of suite.escenarios.filter((x) => x.estado === "pendiente_decision")) expect(e.dudas.length, e.id).toBeGreaterThan(0);
    for (const e of suite.escenarios.filter((x) => x.estado === "activo")) expect(e.dudas, e.id).toEqual([]);
  });
  it("cubre los defectos P1 de la ronda (guardas, rechazo del resumen, aviso falso, intoxicacion)", () => {
    const d = new Set(suite.escenarios.map((e) => e.defecto));
    for (const x of ["reglas-01", "reglas-02", "A13", "whatsapp-02", "voz-01"]) expect(d.has(`QA-PM-R6-${x}`), x).toBe(true);
  });
  it("cada escenario apunta a una prueba que existe", () => {
    const faltan = suite.escenarios.filter((e) => !existsSync(new URL(e.cubierto_por, RAIZ_REPO))).map((e) => `${e.id}: ${e.cubierto_por}`);
    expect(faltan).toEqual([]);
  });
});

describe("banco de casos para romper", () => {
  it("48 conversaciones de WhatsApp con ids unicos y esperado/prohibido", () => {
    const w = suite.conversaciones_whatsapp;
    expect(w).toHaveLength(48);
    expect(new Set(w.map((c) => c.id)).size).toBe(48);
    for (const c of w) {
      expect(c.id).toMatch(/^R6WA\d{2}$/);
      expect(c.pasos.length, c.id).toBeGreaterThan(0);
      expect(c.esperado.length, c.id).toBeGreaterThan(10);
      expect(c.prohibido.length, c.id).toBeGreaterThan(3);
      expect(Number.isNaN(Date.parse(c.reloj_utc)), c.id).toBe(false);
    }
  });
  it("31 guiones de voz con ids unicos y turnos", () => {
    const v = suite.guiones_voz;
    expect(v).toHaveLength(31);
    expect(new Set(v.map((c) => c.id)).size).toBe(31);
    for (const g of v) {
      expect(g.id).toMatch(/^RV\d{2}b?$/);
      expect(g.turnos.length, g.id).toBeGreaterThan(0);
      expect(g.esperado.length, g.id).toBeGreaterThan(5);
      expect(Number.isNaN(Date.parse(g.reloj_utc)), g.id).toBe(false);
    }
  });
});

describe("sin datos personales", () => {
  // Los relojes ISO («2026-10-06T19:00:00Z») no son telefonos: se quitan antes de buscar numeros largos.
  const todo = JSON.stringify(suite, (k, v) => (k === "reloj_utc" || k === "version" ? undefined : v));
  const PATRONES: ReadonlyArray<readonly [string, RegExp]> = [
    ["telefono", /(?<![\d.])\d{10}(?!\d)|\b\d{3}[\s-]\d{3}[\s-]\d{4}\b|\+52\s?\d/],
    ["RFC", /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/],
    ["correo", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["enlace", /https?:\/\/|www\.|maps\.app|goo\.gl/i],
    ["coordenadas con coma", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
  ];
  it.each(PATRONES)("el banco no trae %s", (_n, patron) => {
    expect(patron.test(todo)).toBe(false);
  });
  it("los nombres propios dichos por un cliente de prueba llevan el apellido «Prueba»", () => {
    const presentaciones = [...todo.matchAll(/\b(?:me llamo|mi nombre es|a nombre de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)(?:\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+))?/g)];
    const malas = presentaciones.filter((m) => m[1] !== "Roberto" && m[2] !== "Prueba").map((m) => m[0]);
    expect(malas).toEqual([]);
  });
});

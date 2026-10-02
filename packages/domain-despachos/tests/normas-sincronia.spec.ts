// D-33: las fichas de normas/ y el registro de reglas del motor no pueden separarse.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fichaDesdeCruda, parsearFichaCruda, validarFicha, FichaInvalidaError } from "../src/normas/fichas.ts";
import type { FichaNorma } from "../src/normas/fichas.ts";
import { REGLAS_DEL_MOTOR } from "../src/normas/registro.ts";
import type { ReglaDelMotor } from "../src/normas/registro.ts";

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const DIR = `${RAIZ}normas/`;
const archivos = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();
const fichas: FichaNorma[] = archivos.map((f) => fichaDesdeCruda(parsearFichaCruda(readFileSync(DIR + f, "utf8"))));

const IDS_OBLIGATORIOS = [
  "cff-12", "cff-69-b", "cff-29-29-a", "rmf-4.5.1", "rmf-2.8.1.6", "rmf-2.7.1.29", "lisr-76-150", "lisr-96", "lisr-106",
  "lisr-113-e", "liva-1-a-5", "anexo-20", "anexo-24",
];

/** Devuelve los problemas de sincronía entre un juego de fichas y un registro de reglas. */
function problemasDeSincronia(fs: readonly FichaNorma[], reglas: readonly ReglaDelMotor[]): string[] {
  const ids = new Set(fs.map((f) => f.id));
  const problemas: string[] = [];
  const usados = new Set<string>();
  for (const r of reglas) {
    if (r.fundamentos.length === 0) problemas.push(`la regla ${r.id} no tiene fundamento`);
    for (const id of r.fundamentos) {
      usados.add(id);
      if (!ids.has(id)) problemas.push(`la regla ${r.id} cita la ficha inexistente ${id}`);
    }
  }
  for (const f of fs) if (f.tipo !== "contexto" && !usados.has(f.id)) problemas.push(`la ficha ${f.id} no la usa ninguna regla y no es de contexto`);
  return problemas;
}

describe("D-33 memoria normativa de despachos", () => {
  it("cada ficha valida contra el esquema y su id coincide con el nombre del archivo", () => {
    expect(archivos.length).toBeGreaterThanOrEqual(IDS_OBLIGATORIOS.length);
    fichas.forEach((f, i) => expect(`${f.id}.yaml`).toBe(archivos[i]));
  });

  it("existen las fichas que exige la tarea", () => {
    const ids = new Set(fichas.map((f) => f.id));
    for (const id of IDS_OBLIGATORIOS) expect(ids.has(id), id).toBe(true);
  });

  it("todo id referenciado existe, toda regla tiene fundamento y toda ficha se usa o es contexto", () => {
    expect(problemasDeSincronia(fichas, REGLAS_DEL_MOTOR)).toEqual([]);
  });

  it("los ids de reglas son únicos y sus archivos existen", () => {
    const ids = REGLAS_DEL_MOTOR.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of REGLAS_DEL_MOTOR) expect(existsSync(RAIZ + r.archivo), r.archivo).toBe(true);
  });

  it("cada archivo:línea de usado_en_codigo apunta a un archivo y una línea reales", () => {
    for (const f of fichas) {
      for (const ref of f.usado_en_codigo) {
        const m = /^(.+):(\d+)$/.exec(ref);
        const ruta = RAIZ + (m?.[1] ?? "");
        expect(existsSync(ruta), `${f.id}: ${ref}`).toBe(true);
        const lineas = readFileSync(ruta, "utf8").split("\n").length;
        expect(Number(m?.[2]), `${f.id}: ${ref}`).toBeLessThanOrEqual(lineas);
      }
    }
  });

  it("sanidad: borrar una ficha referenciada rompe la sincronía", () => {
    const sin = fichas.filter((f) => f.id !== "cff-12");
    const problemas = problemasDeSincronia(sin, REGLAS_DEL_MOTOR);
    expect(problemas.some((p) => p.includes("ficha inexistente cff-12"))).toBe(true);
  });

  it("sanidad: una regla sin fundamento y una ficha huérfana se detectan", () => {
    const reglas: ReglaDelMotor[] = [...REGLAS_DEL_MOTOR, { id: "x.sin-fundamento", archivo: "src/index.ts", descripcion: "x", fundamentos: [] }];
    expect(problemasDeSincronia(fichas, reglas)).toContain("la regla x.sin-fundamento no tiene fundamento");
    const huerfana: FichaNorma = { ...(fichas[0] as FichaNorma), id: "huerfana", tipo: "norma" };
    expect(problemasDeSincronia([...fichas, huerfana], REGLAS_DEL_MOTOR).some((p) => p.includes("huerfana"))).toBe(true);
  });

  it("el esquema rechaza estados inválidos, verificada sin firma y YAML fuera del subconjunto", () => {
    const base = parsearFichaCruda(readFileSync(DIR + "cff-12.yaml", "utf8"));
    expect(validarFicha({ ...base, estado_verificacion: "quizas" })).toContain("estado_verificacion inválido");
    expect(validarFicha({ ...base, estado_verificacion: "verificada" })).toContain("una ficha verificada exige verificada_por y fecha");
    expect(validarFicha({ ...base, estado_verificacion: "verificada", verificada_por: "Fiscalista", fecha: "2026-10-01" })).toEqual([]);
    expect(validarFicha({ ...base, verificada_por: "Alguien" })).toContain("solo una ficha verificada lleva verificada_por y fecha");
    expect(() => parsearFichaCruda("resumen: >\n  texto")).toThrow(FichaInvalidaError);
    expect(() => parsearFichaCruda("id: a\nid: b")).toThrow(FichaInvalidaError);
  });
});

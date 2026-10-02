// L-24 -- registro normativo: cada cita del codigo esta atada a una ficha y cada ficha a su codigo.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NORMAS_LICITACIONES, extraerCitasNormativas, fichaNormaPorId, fichasParaCita } from "../src/normas.ts";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIRS_CODIGO = ["packages/domain-licitaciones/src", "apps/api/src/routes/verticals/licitaciones", "apps/web/src/verticals/licitaciones"];

function archivosDe(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosDe(ruta));
    else if (/\.(ts|tsx)$/.test(nombre)) out.push(ruta);
  }
  return out;
}

describe("extraerCitasNormativas", () => {
  it("reconoce las formas en que el codigo cita articulos", () => {
    expect(extraerCitasNormativas("plazo (Art. 73 LAASSP)")).toEqual(["LAASSP 73"]);
    expect(extraerCitasNormativas("art. 69-B del CFF")).toEqual(["CFF 69-B"]);
    expect(extraerCitasNormativas("LAASSP nueva, Art. 95 (DOF)")).toEqual(["LAASSP 95"]);
    expect(extraerCitasNormativas('lower.includes("32-d")')).toEqual(["CFF 32-D"]);
    expect(extraerCitasNormativas("Art. 74 de la Ley Federal del Trabajo")).toEqual([]);
    expect(extraerCitasNormativas("la lista 69-B del SAT")).toEqual(["CFF 69-B"]);
  });
});

describe("registro normativo de licitaciones", () => {
  it("ids unicos y toda ficha declara su verificacion con honestidad", () => {
    const ids = NORMAS_LICITACIONES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of NORMAS_LICITACIONES) {
      if (f.estadoVerificacion !== "verificado_fuente_primaria") expect(f.validarConAbogado, f.id).toBe(true);
      expect(f.nota.length, f.id).toBeGreaterThan(20);
      expect(f.queAsumeElCodigo.length, f.id).toBeGreaterThan(10);
      // Nunca una ficha "verificada contra fuente primaria" sin fecha ni fuente: hoy ninguna lo esta.
      expect(f.estadoVerificacion, f.id).not.toBe("verificado_fuente_primaria");
    }
  });

  it("cubre LAASSP 49/73/95, CFF 32-D/69-B y el RLAASSP", () => {
    for (const cita of ["LAASSP 49", "LAASSP 73", "LAASSP 95", "CFF 32-D", "CFF 69-B"]) expect(fichasParaCita(cita).length, cita).toBeGreaterThan(0);
    expect(fichaNormaPorId("rlaassp-reglamento")?.ley).toBe("RLAASSP");
    expect(fichaNormaPorId("laassp-2000-pago")?.vigencia).toBe("abrogada");
  });

  it("las fichas cuyo numero de articulo se desconoce no lo inventan", () => {
    for (const id of ["laassp-2000-pago", "laassp-2000-inconformidad", "laassp-2025-regimen-transitorio", "rlaassp-reglamento"]) {
      const f = fichaNormaPorId(id)!;
      expect(f.articulo, id).toBeNull();
      expect(f.citas, id).toEqual([]);
      expect(f.estadoVerificacion, id).toBe("sin_verificar");
    }
  });

  it("cada archivo declarado en `usadoEnCodigo` existe y contiene la cita", () => {
    for (const f of NORMAS_LICITACIONES) {
      for (const uso of f.usadoEnCodigo) {
        const ruta = join(RAIZ, uso.archivo);
        expect(existsSync(ruta), `${f.id}: falta ${uso.archivo}`).toBe(true);
        expect(readFileSync(ruta, "utf8").toLowerCase(), `${f.id}: ${uso.archivo} no contiene "${uso.texto}"`).toContain(uso.texto.toLowerCase());
      }
    }
  });

  it("toda cita normativa del codigo de la vertical tiene ficha (no hay citas huerfanas)", () => {
    const huerfanas: string[] = [];
    let revisados = 0;
    for (const dir of DIRS_CODIGO) {
      for (const archivo of archivosDe(join(RAIZ, dir))) {
        // El registro es la fuente: sus propias fichas no se auditan contra si mismas.
        if (archivo.endsWith("/domain-licitaciones/src/normas.ts")) continue;
        revisados += 1;
        for (const cita of extraerCitasNormativas(readFileSync(archivo, "utf8"))) {
          if (fichasParaCita(cita).length === 0) huerfanas.push(`${cita} en ${relative(RAIZ, archivo)}`);
        }
      }
    }
    expect(revisados).toBeGreaterThan(50);
    expect(huerfanas).toEqual([]);
  });

  it("toda ficha con citas por numero se usa de verdad en el codigo (no hay fichas muertas)", () => {
    for (const f of NORMAS_LICITACIONES.filter((x) => x.citas.length > 0)) {
      expect(f.usadoEnCodigo.length, f.id).toBeGreaterThan(0);
    }
  });
});

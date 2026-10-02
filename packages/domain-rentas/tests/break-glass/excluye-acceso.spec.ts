// Rn-29 -- el romper-cristal de superadmin NO puede devolver las instrucciones de acceso al huesped (direccion exacta,
// codigo, indicaciones), ni en claro ni como sobre. Prueba estatica sobre el codigo y el SQL real de los lectores
// (el comportamiento contra Postgres real lo cubre scripts/verify-rentas-privacidad).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BREAK_GLASS_DATOS_EXCLUIDOS, BREAK_GLASS_RESOURCE_TYPES } from "../../src/break-glass/tipos.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PAQUETE = path.resolve(AQUI, "..", "..");

/** Quita comentarios SQL (`-- ...`) para que una mencion explicativa no cuente como uso. */
const sinComentariosSql = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const sinComentariosTs = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

describe("break-glass: excluye el acceso al huesped", () => {
  it("ninguna categoria de romper-cristal cubre el acceso", () => {
    for (const tipo of BREAK_GLASS_RESOURCE_TYPES) expect(tipo).not.toMatch(/acceso|instruccion|cerradura|codigo/);
  });

  it("los lectores SQL (012, 018, 020) no seleccionan ninguna columna ni funcion de las instrucciones de acceso", () => {
    const migraciones = readdirSync(path.join(PAQUETE, "migrations")).filter((f) => /^(012|018|020)_/.test(f));
    expect(migraciones.length).toBe(3);
    for (const f of migraciones) {
      const sql = sinComentariosSql(readFileSync(path.join(PAQUETE, "migrations", f), "utf8"));
      for (const prohibido of BREAK_GLASS_DATOS_EXCLUIDOS) expect(sql, `${f} menciona ${prohibido}`).not.toContain(prohibido);
    }
  });

  it("el codigo TypeScript de break-glass tampoco las toca", () => {
    const dir = path.join(PAQUETE, "src", "break-glass");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "tipos.ts")) {
      const ts = sinComentariosTs(readFileSync(path.join(dir, f), "utf8"));
      for (const prohibido of BREAK_GLASS_DATOS_EXCLUIDOS) expect(ts, `${f} menciona ${prohibido}`).not.toContain(prohibido);
    }
  });
});

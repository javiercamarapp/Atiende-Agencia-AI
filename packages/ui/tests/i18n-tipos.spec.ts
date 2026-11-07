// i18n ES/EN: la garantia de tipos. Compila con el compilador de TypeScript un archivo de muestra y exige el error exacto en
// cada caso: clave faltante en ingles, clave de mas, y `t()` con una clave mal escrita. Si alguien afloja los tipos
// (p. ej. `Record<string, Mensaje>`), esta prueba se cae.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const i18n = path.resolve(aqui, "../src/i18n").split(path.sep).join("/");
const carpeta = mkdtempSync(path.join(tmpdir(), "i18n-tipos-"));
afterAll(() => rmSync(carpeta, { recursive: true, force: true }));

function errores(codigo: string): string[] {
  const archivo = path.join(carpeta, `muestra-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(archivo, codigo);
  const programa = ts.createProgram([archivo], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
    types: [],
  });
  return ts
    .getPreEmitDiagnostics(programa)
    .filter((d) => d.file?.fileName === archivo)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("tipos del catalogo", () => {
  it("un modulo completo compila", () => {
    expect(errores(`import type { ModuloEs, Traduccion } from "${i18n}/tipos";
      const es = { "x.a": "A", "x.b": { one: "1", other: "n" } } as const satisfies ModuloEs;
      export const en: Traduccion<typeof es> = { "x.a": "A!", "x.b": { other: "n" } };`)).toEqual([]);
  }, 60_000);

  it("falta una clave en ingles -> error de tipos", () => {
    const e = errores(`import type { ModuloEs, Traduccion } from "${i18n}/tipos";
      const es = { "x.a": "A", "x.b": "B" } as const satisfies ModuloEs;
      export const en: Traduccion<typeof es> = { "x.a": "A!" };`);
    expect(e.join("\n")).toMatch(/x\.b/);
  }, 60_000);

  it("sobra una clave en ingles -> error de tipos", () => {
    const e = errores(`import type { ModuloEs, Traduccion } from "${i18n}/tipos";
      const es = { "x.a": "A" } as const satisfies ModuloEs;
      export const en: Traduccion<typeof es> = { "x.a": "A!", "x.z": "Z" };`);
    expect(e.join("\n")).toMatch(/x\.z/);
  }, 60_000);

  it("t() con una clave que no existe -> error de tipos", () => {
    const ok = errores(`import { traducir } from "${i18n}/traducir";
      export const a = traducir("en", "comun.reintentar");`);
    expect(ok).toEqual([]);
    const e = errores(`import { traducir } from "${i18n}/traducir";
      export const a = traducir("en", "comun.reintentarr");`);
    expect(e.join("\n")).toMatch(/comun\.reintentarr/);
  }, 60_000);
});

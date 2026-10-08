// Regresion H56 / 3de32ee y L03 / 0edd978 del repo original (atiende-restaurantes / lostaquitosdepm): un archivo `.env` quedo VERSIONADO
// (con la anon key de Supabase dentro). Ninguna prueba ni CI fallaba si alguien lo volvia a trackear. Esta prueba falla si `git ls-files`
// incluye cualquier `.env`, `.env.*` o `*.env`, salvo la plantilla `.env.example`.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PERMITIDOS = new Set([".env.example"]);

/** Un archivo de secretos de entorno: `.env`, `.env.local`, `.env.production`, `prod.env`... (la plantilla `.env.example` es la unica permitida). */
function esArchivoEnvVersionado(ruta: string): boolean {
  const base = ruta.split("/").at(-1) ?? ruta;
  if (PERMITIDOS.has(base)) return false;
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

describe("H56 / 3de32ee y L03 / 0edd978: ningun archivo .env esta versionado (salvo .env.example)", () => {
  it("H56 / 3de32ee: git ls-files no contiene .env, .env.* ni *.env fuera de .env.example", () => {
    const versionados = execFileSync("git", ["ls-files", "-z"], { cwd: RAIZ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    expect(versionados.length).toBeGreaterThan(100);
    expect(versionados.filter(esArchivoEnvVersionado)).toEqual([]);
    // La plantilla si se versiona: es lo que documenta las variables sin valores reales.
    expect(versionados).toContain(".env.example");
  });

  it("L03 / 0edd978 (negativo y positivo del detector): marca los .env reales de cualquier carpeta y no marca falsos positivos", () => {
    for (const malo of [".env", "apps/web/.env", ".env.local", ".env.production", "apps/api/.env.development.local", "supabase/prod.env"]) {
      expect(esArchivoEnvVersionado(malo), malo).toBe(true);
    }
    for (const bueno of [".env.example", "apps/web/.env.example", "docs/env.md", "apps/api/src/env.ts", "packages/config/src/environment.ts", "docs/enviar.md", "scripts/load-env.sh"]) {
      expect(esArchivoEnvVersionado(bueno), bueno).toBe(false);
    }
  });
});

// Higiene: restos de editor/herramientas (`sed -i` de macOS deja `archivo-E`; los parches dejan `.orig`/`.rej`) no se versionan.
// Dos copias `-E` quedaron rastreadas en main y nadie las referenciaba.
function esResiduoVersionado(ruta: string): boolean {
  const base = ruta.split("/").at(-1) ?? ruta;
  return /-[Ee]$/.test(base) || /\.(orig|rej)$/.test(base);
}

describe("higiene: ningun archivo residual (-E, .orig, .rej) esta versionado", () => {
  it("git ls-files no contiene archivos terminados en -E/-e, .orig ni .rej", () => {
    const versionados = execFileSync("git", ["ls-files", "-z"], { cwd: RAIZ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
    expect(versionados.length).toBeGreaterThan(100);
    expect(versionados.filter(esResiduoVersionado)).toEqual([]);
  });

  it("(negativo y positivo del detector) marca los residuos y no marca archivos legitimos", () => {
    for (const malo of ["a/b/x.ts-E", "x.sql-E", "src/y.ts.orig", "z.patch.rej", "x.ts-e"]) expect(esResiduoVersionado(malo), malo).toBe(true);
    for (const bueno of ["README-ES.md", "src/Ejemplo.ts", "docs/SUBE.md", "a/original.ts", "rejilla.ts", "NODE-E2E.md"]) expect(esResiduoVersionado(bueno), bueno).toBe(false);
  });
});

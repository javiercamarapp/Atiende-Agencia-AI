import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard agregado tras la limpieza de auditoría del 19-sep-2026
// (`packages/mcp-servers/{billing,channel-manager,energy,expediente,locks,pms,
// pos,scheduling,shared}`): esas 9 carpetas llevaban desde el esqueleto inicial
// como reservas de una vertical futura, cada una con SOLO un `README.md` diciendo
// "aún no portado" -- ninguna tenía `package.json` (por eso `npm` nunca las
// registró como workspace real: ver `package-lock.json`, que nunca las lista),
// pero su sola presencia bajo `packages/mcp-servers/` sugería, a quien navegara
// el árbol del repo, que existían 10 servidores MCP cuando solo 1
// (`@atiende/mcp-cfdi`) tiene código real. Se retiraron porque ningún flujo real
// las importaba (`grep -rn "@atiende/mcp-" — solo mcp-cfdi aparece fuera de
// docs/comentarios de diseño).
//
// Este guard protege esa limpieza AL REVÉS de cómo se detectó el problema: no
// puede depender de que alguien recuerde borrar la carpeta la próxima vez, así
// que falla la suite si un paquete de workspace (uno que SÍ tiene
// `package.json`, es decir, uno que `npm install` sí registra) no tiene ningún
// archivo de código fuente. Deliberadamente NO exige nada de las carpetas SIN
// `package.json` -- esas nunca fueron paquetes de npm reales, y una carpeta de
// diseño/documentación pura (sin pretender ser un workspace) sigue siendo válida.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

interface WorkspacePackage {
  /** Ruta relativa al repo, p.ej. "packages/mcp-servers/cfdi". */
  relDir: string;
}

/** Expande los patrones simples `"<base>/*"` del `workspaces` de package.json
 *  raíz a la lista de directorios que SÍ tienen `package.json` -- los únicos
 *  que `npm install` trata como paquete real. No es un motor de glob genérico
 *  a propósito: los tres patrones de este repo ("apps/*", "packages/*",
 *  "packages/mcp-servers/*") son todos "<base>/*" literal. */
function listWorkspacePackages(): WorkspacePackage[] {
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const patterns = rootPkg.workspaces ?? [];
  const found: WorkspacePackage[] = [];

  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      throw new Error(
        `workspace-source-guard: patrón "${pattern}" en package.json no termina en "/*" -- este guard solo sabe expandir ese caso simple. Actualízalo si el repo agrega un patrón distinto.`,
      );
    }
    const base = pattern.slice(0, -"/*".length);
    const baseAbs = path.join(repoRoot, base);
    if (!existsSync(baseAbs)) continue;

    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relDir = path.join(base, entry.name);
      const pkgJsonPath = path.join(repoRoot, relDir, "package.json");
      if (existsSync(pkgJsonPath)) {
        found.push({ relDir });
      }
    }
  }

  return found;
}

/** ¿Hay al menos un archivo de código fuente bajo `dirAbs` (recursivo,
 *  ignorando node_modules/dist/build/coverage)? Cuenta cualquier archivo con
 *  extensión de `SOURCE_EXTENSIONS` -- deliberadamente NO exige que esté bajo
 *  `src/` (algún paquete podría tener un entry point en la raíz) ni excluye
 *  archivos `.spec.ts`/`.test.ts` (un paquete solo-de-tests sigue siendo
 *  código real, no el caso "solo README" que este guard ataca). */
function hasSourceFile(dirAbs: string): boolean {
  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        return true;
      }
    }
  }
  return false;
}

describe("workspace source guard (ningún paquete de workspace sin código fuente)", () => {
  const packages = listWorkspacePackages();

  it("encontró al menos un paquete de workspace real (sanity check del propio guard)", () => {
    // Si esto falla, el guard mismo se rompió (p. ej. el layout de
    // package.json cambió) -- no es una señal de que el repo esté vacío.
    expect(packages.length).toBeGreaterThan(0);
  });

  it.each(packages.map((p) => [p.relDir, p] as const))("%s tiene al menos un archivo de código fuente", (_relDir, pkg) => {
    const dirAbs = path.join(repoRoot, pkg.relDir);
    expect(statSync(dirAbs).isDirectory()).toBe(true);
    expect(
      hasSourceFile(dirAbs),
      `${pkg.relDir} tiene package.json (npm lo trata como workspace real) pero ningún archivo ${SOURCE_EXTENSIONS.join("/")} -- mismo patrón que las 9 carpetas solo-README retiradas de packages/mcp-servers/ el 19-sep-2026. Si es un paquete nuevo en construcción, agrégale código real antes de darlo por hecho, o quítale package.json hasta que lo tenga.`,
    ).toBe(true);
  });
});

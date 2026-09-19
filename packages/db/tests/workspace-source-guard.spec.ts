import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard agregado tras la limpieza de auditoría del 19-sep-2026
// (`packages/mcp-servers/{billing,channel-manager,energy,expediente,locks,pms,
// pos,scheduling,shared}`): esas 9 carpetas llevaban desde el esqueleto inicial
// como reservas de una vertical futura, cada una con SOLO un `README.md` diciendo
// "aún no portado" -- SIN `package.json` (por eso `npm` nunca las registró como
// workspace real: ver `package-lock.json`, que nunca las lista), pero su sola
// presencia bajo `packages/mcp-servers/` sugería, a quien navegara el árbol del
// repo, que existían 10 servidores MCP cuando solo 1 (`@atiende/mcp-cfdi`) tiene
// código real. Se retiraron porque ningún flujo real las importaba (`grep -rn
// "@atiende/mcp-" — solo mcp-cfdi aparece fuera de docs/comentarios de diseño).
//
// La regresión real que motivó este guard es "un directorio SIN package.json
// bajo un patrón de workspace, con solo un README.md" -- por eso este guard
// enumera TODOS los directorios que expanden los patrones de `workspaces` del
// package.json raíz (con o sin package.json propio), no solo los que ya tienen
// uno. Para cada directorio exige `package.json` + al menos un archivo de
// código fuente real, salvo los que están explícitamente permitidos en
// `ALLOWED_NON_PACKAGE_DIRS` (documentados abajo, con su razón). Volver a crear
// `packages/mcp-servers/locks/README.md` (sin `package.json`, no allowlisteado)
// vuelve a fallar este guard -- a diferencia de una versión anterior de este
// mismo archivo que solo miraba directorios CON `package.json` y por eso NO
// detectaba el patrón real (habría pasado en verde contra el árbol pre-limpieza).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

/** Directorios que expanden un patrón de `workspaces` pero deliberadamente NO
 *  son un paquete npm real, así que quedan exentos de exigir `package.json` +
 *  código fuente. Cada entrada lleva su razón -- añadir una entrada nueva aquí
 *  es una decisión explícita, no un escape genérico. */
const ALLOWED_NON_PACKAGE_DIRS: Record<string, string> = {
  "packages/config": "solo tsconfig.base.json compartido, nunca tuvo package.json ni pretende ser un workspace npm real.",
  "packages/mcp-servers": "contenedor de packages/mcp-servers/* (su propio patrón de workspace); el índice vive en su README.md, no en código.",
};

interface WorkspaceEntry {
  /** Ruta relativa al repo, p.ej. "packages/mcp-servers/cfdi". */
  relDir: string;
}

/** Expande los patrones simples `"<base>/*"` del `workspaces` de package.json
 *  raíz a TODOS los subdirectorios de <base>, tengan o no package.json --
 *  a propósito, para poder exigirlo donde falte. No es un motor de glob
 *  genérico a propósito: los tres patrones de este repo ("apps/*",
 *  "packages/*", "packages/mcp-servers/*") son todos "<base>/*" literal. */
function listWorkspaceDirs(): WorkspaceEntry[] {
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const patterns = rootPkg.workspaces ?? [];
  const found: WorkspaceEntry[] = [];
  const seen = new Set<string>();

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
      if (seen.has(relDir)) continue; // p.ej. packages/mcp-servers matchea "packages/*" una sola vez
      seen.add(relDir);
      found.push({ relDir });
    }
  }

  return found;
}

/** ¿Hay al menos un archivo de código fuente REAL bajo `dirAbs` (recursivo,
 *  ignorando node_modules/dist/build/coverage)? Cuenta archivos con extensión
 *  de `SOURCE_EXTENSIONS`, pero excluye `*.d.ts` (solo tipos, no implementación)
 *  y archivos `*.config.*` (config de herramienta, no código del paquete) --
 *  un paquete con `package.json` + `README.md` + `vitest.config.ts` no debe
 *  pasar como "con código fuente". Deliberadamente NO exige que esté bajo
 *  `src/` (algún paquete podría tener un entry point en la raíz) ni excluye
 *  `.spec.ts`/`.test.ts` (un paquete solo-de-tests sigue siendo código real). */
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
      const name = entry.name;
      if (name.endsWith(".d.ts")) continue;
      if (/\.config\.[cm]?[jt]s$/.test(name)) continue;
      if (SOURCE_EXTENSIONS.includes(path.extname(name))) {
        return true;
      }
    }
  }
  return false;
}

describe("workspace source guard (ningún directorio de workspace sin package.json + código fuente)", () => {
  const dirs = listWorkspaceDirs();

  it("encontró al menos un directorio de workspace (sanity check del propio guard)", () => {
    // Si esto falla, el guard mismo se rompió (p. ej. el layout de
    // package.json cambió) -- no es una señal de que el repo esté vacío.
    expect(dirs.length).toBeGreaterThan(0);
  });

  it.each(dirs.map((d) => [d.relDir, d] as const))(
    "%s tiene package.json y al menos un archivo de código fuente (o está en ALLOWED_NON_PACKAGE_DIRS)",
    (_relDir, entry) => {
      const dirAbs = path.join(repoRoot, entry.relDir);
      expect(statSync(dirAbs).isDirectory()).toBe(true);

      const allowReason = ALLOWED_NON_PACKAGE_DIRS[entry.relDir];
      if (allowReason) {
        // Directorio explícitamente exento -- documentado arriba, no un escape silencioso.
        expect(allowReason.length).toBeGreaterThan(0);
        return;
      }

      const pkgJsonPath = path.join(dirAbs, "package.json");
      expect(
        existsSync(pkgJsonPath),
        `${entry.relDir} no tiene package.json y no está en ALLOWED_NON_PACKAGE_DIRS -- mismo patrón que las 9 carpetas solo-README retiradas de packages/mcp-servers/ el 19-sep-2026 (una carpeta con solo README.md bajo un patrón de workspace). Si es documentación pura a propósito, agrégala a ALLOWED_NON_PACKAGE_DIRS con su razón; si es un paquete en construcción, dale package.json + código real.`,
      ).toBe(true);

      expect(
        hasSourceFile(dirAbs),
        `${entry.relDir} tiene package.json (npm lo trata como workspace real) pero ningún archivo de código fuente real (${SOURCE_EXTENSIONS.join("/")}, sin contar *.d.ts ni *.config.*) -- agrégale código real antes de darlo por hecho, o quítale package.json hasta que lo tenga.`,
      ).toBe(true);
    },
  );
});

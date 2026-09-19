// Guard contra el inventario de credenciales pudriéndose: recorre TODO el código
// fuente real de apps/ y packages/ (el mismo alcance que docs/CREDENCIALES.md)
// buscando lecturas de `process.env`/`import.meta.env`, y falla si encuentra una
// variable que no está registrada en `../src/integrations-status.ts`
// (`KNOWN_ENV_VARS`) ni en la lista corta de exclusiones de abajo.
//
// Detecta, en orden:
//   1. Acceso directo: `process.env.NAME` / `process.env["NAME"]` /
//      `import.meta.env.NAME` / `import.meta.env["NAME"]`.
//   2. `requireEnv("NAME")` (apps/api/src/env.ts::requireEnv).
//   3. `checkEnvCredentials(IDENT)` donde `IDENT` es un array `const IDENT = [...]`
//      declarado en el MISMO archivo (packages/mcp-servers/cfdi/src/adapters/*).
//   4. Acceso dinámico `process.env[identificador]` (no un string literal) — en
//      ese caso, como el nombre real no es estático, se listan como candidatos
//      TODOS los strings en mayúsculas-con-guion-bajo del propio archivo (cubre
//      packages/domain-rentas/src/mensajeria/canalMensajeria.ts, que arma la
//      variable a partir de una tabla `Record<canal, nombreDeVariable>`).
//
// Deliberadamente NO recorre `scripts/` (el inventario de credenciales, por
// instrucción explícita de la tarea que originó este guard, cubre solo apps/ y
// packages/ — scripts/verify-real-postgres-ci/run-gate.mjs lee PGHOST/PGPORT/
// PGUSER/PGPASSWORD para levantar un Postgres efímero de CI, config de la
// herramienta de CI, no de esta app).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_ENV_VARS } from "../src/integrations-status.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** Lista CORTA y explícita de nombres que el escaneo puede encontrar pero que NO
 *  son credenciales de este inventario — cada una con su razón real. */
const EXCLUSIONS: ReadonlySet<string> = new Set([
  // Vite lo expone automáticamente (base path del build) — no es una variable de
  // entorno que el proyecto configure, ni una credencial.
  "BASE_URL",
  // No aparece nunca en este repo hoy, pero es el ejemplo canónico de "variable de
  // plataforma que no es una credencial de integración" — se excluye a propósito
  // por si algún día se lee.
  "NODE_ENV",
  // Solo mencionada dentro de un COMENTARIO (packages/voice-gateway/src/providers/
  // elevenlabs-provider.ts) como ejemplo de "un script o entorno de desarrollo
  // podría leerla así" -- ningún código ejecutable de este repo hace
  // `process.env.ELEVENLABS_API_KEY` (verificado: el provider recibe la key vía
  // `apiKeyProvider` inyectado, pensado para Supabase Vault en producción). Ver
  // docs/CREDENCIALES.md, sección "Voz (ElevenLabs)".
  "ELEVENLABS_API_KEY",
]);

const SOURCE_ROOTS = ["apps/api/src", "apps/api/tests", "apps/worker/src", "apps/web/src", "packages"];
const FILE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
// Este propio archivo documenta los patrones que busca usando ejemplos como
// `process.env.NAME` dentro de comentarios -- se excluye a sí mismo del escaneo
// para no reportarse a sí mismo como un falso positivo (no lee ninguna variable
// de entorno real, solo las MENCIONA como ejemplo).
const SELF_PATH = path.resolve(HERE, "env-inventory-guard.spec.ts");

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (FILE_EXTENSIONS.has(path.extname(entry.name)) && path.resolve(full) !== SELF_PATH) files.push(full);
    }
  };
  walk(root);
  return files;
}

const DIRECT_ACCESS_RE = /(?:process|import\.meta)\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACKET_LITERAL_RE = /(?:process|import\.meta)\.env\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g;
const REQUIRE_ENV_RE = /requireEnv\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g;
const CHECK_ENV_CREDENTIALS_RE = /checkEnvCredentials\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
const DYNAMIC_BRACKET_RE = /process\.env\[\s*[A-Za-z_]/;
const UPPER_SNAKE_LITERAL_RE = /["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g;

/** Nombres candidatos de variable de entorno encontrados en el contenido de UN
 *  archivo (puede haber falsos positivos benignos, p.ej. un `process.env.X` dentro
 *  de un comentario -- por eso las exclusiones son parte del contrato de este
 *  guard, no un parche). */
function findEnvVarCandidates(content: string): Set<string> {
  const candidates = new Set<string>();

  for (const m of content.matchAll(DIRECT_ACCESS_RE)) candidates.add(m[1] as string);
  for (const m of content.matchAll(BRACKET_LITERAL_RE)) candidates.add(m[2] as string);
  for (const m of content.matchAll(REQUIRE_ENV_RE)) candidates.add(m[2] as string);

  for (const m of content.matchAll(CHECK_ENV_CREDENTIALS_RE)) {
    const ident = m[1] as string;
    const arrayRe = new RegExp(`const\\s+${ident}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`);
    const arrayMatch = content.match(arrayRe);
    if (!arrayMatch) continue;
    for (const strMatch of (arrayMatch[1] as string).matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/g)) {
      candidates.add(strMatch[1] as string);
    }
  }

  if (DYNAMIC_BRACKET_RE.test(content)) {
    for (const m of content.matchAll(UPPER_SNAKE_LITERAL_RE)) candidates.add(m[1] as string);
  }

  return candidates;
}

describe("inventario de credenciales — el código fuente no debe leer variables sin registrar", () => {
  it("toda variable de entorno leída en apps/ y packages/ está en KNOWN_ENV_VARS (integrations-status.ts) o en la lista de exclusiones de este archivo", () => {
    const unregistered = new Map<string, Set<string>>(); // variable -> archivos donde aparece

    for (const root of SOURCE_ROOTS) {
      const absoluteRoot = path.join(REPO_ROOT, root);
      let rootStat;
      try {
        rootStat = statSync(absoluteRoot);
      } catch {
        continue;
      }
      if (!rootStat.isDirectory()) continue;

      for (const file of listSourceFiles(absoluteRoot)) {
        const content = readFileSync(file, "utf8");
        const candidates = findEnvVarCandidates(content);
        for (const name of candidates) {
          if (KNOWN_ENV_VARS.has(name) || EXCLUSIONS.has(name)) continue;
          const relative = path.relative(REPO_ROOT, file);
          const files = unregistered.get(name) ?? new Set<string>();
          files.add(relative);
          unregistered.set(name, files);
        }
      }
    }

    const detalle = [...unregistered.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, files]) => `${name} (en: ${[...files].sort().join(", ")})`);

    // Mensaje de fallo accionable: qué variable falta registrar y en qué archivo(s)
    // se leyó -- no solo "el guard falló".
    expect(
      detalle,
      detalle.length > 0
        ? `Regístralas en INTEGRATIONS u OPERATIONAL_ENV_VARS de integrations-status.ts (y documenta la integración en ` +
            `docs/CREDENCIALES.md), o si de verdad no es una credencial de este inventario, agrégala a EXCLUSIONS de este ` +
            `archivo con la razón real.`
        : undefined,
    ).toEqual([]);
  });
});

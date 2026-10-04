// Equivalente de `layer-boundary.test.ts` del original (:60, :79, :98): la logica de dominio no se acopla al
// transporte. Ningun archivo de packages/domain-restaurantes/src importa Hono ni `apps/api`, ni usa Request/Response
// de fetch, ni Deno.serve ni http-security. Con control positivo (el detector SI marca cada token) y ancla de que la
// lista de archivos vigilados sigue viva.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const PROHIBIDOS: ReadonlyArray<{ readonly nombre: string; readonly patron: RegExp }> = [
  { nombre: "import de Hono", patron: /from\s+["']hono(?:\/[^"']*)?["']/ },
  { nombre: "import de apps/api", patron: /from\s+["'][^"']*(?:apps\/api|@atiende\/api)[^"']*["']/ },
  { nombre: "import de http-security", patron: /from\s+["'][^"']*http-security(?:\.ts)?["']/ },
  { nombre: "Deno.serve(...)", patron: /\bDeno\.serve\s*\(/ },
  { nombre: "new Response(...)", patron: /\bnew Response\s*\(/ },
  { nombre: "new Request(...)", patron: /\bnew Request\s*\(/ },
  { nombre: "anotacion de tipo Request", patron: /:\s*Request\b/ },
  { nombre: "anotacion de tipo Response", patron: /:\s*Response\b/ },
];

/** Quita comentarios y cadenas de plantilla de documentacion para no marcar texto que solo MENCIONA apps/api. */
function sinComentarios(fuente: string): string {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function violacionesDeFrontera(fuente: string): string[] {
  const limpio = sinComentarios(fuente);
  return PROHIBIDOS.filter(({ patron }) => patron.test(limpio)).map(({ nombre }) => nombre);
}

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    return statSync(ruta).isDirectory() ? archivosTs(ruta) : ruta.endsWith(".ts") ? [ruta] : [];
  });
}

describe("frontera de capas: el dominio de restaurantes no conoce el transporte", () => {
  const archivos = archivosTs(SRC);

  it("ancla: la lista de archivos vigilados no se encoge en silencio (un typo de ruta no la deja vacia)", () => {
    expect(archivos.length).toBeGreaterThan(60);
    for (const clave of ["orders.ts", "whatsapp/llm-turn-handler.ts", "agent-tools/registry.ts", "whatsapp/inbound.ts", "postgres-repository.ts"]) {
      expect(archivos.map((a) => relative(SRC, a)), clave).toContain(clave);
    }
  });

  it("ningun archivo de packages/domain-restaurantes/src importa Hono ni apps/api, ni usa Request/Response", () => {
    const violaciones = archivos.flatMap((a) => violacionesDeFrontera(readFileSync(a, "utf8")).map((v) => `${relative(SRC, a)}: ${v}`));
    expect(violaciones).toEqual([]);
  });

  it("control positivo: el detector marca cada token prohibido y no marca codigo de dominio puro ni comentarios", () => {
    const casos: ReadonlyArray<readonly [string, string]> = [
      ["import de Hono", 'import { Hono } from "hono";'],
      ["import de Hono", 'import { cors } from "hono/cors";'],
      ["import de apps/api", 'import { x } from "../../apps/api/src/app.ts";'],
      ["import de http-security", 'import { readJsonCapped } from "./http-security.ts";'],
      ["Deno.serve(...)", 'Deno.serve((req) => new Response("ok"));'],
      ["new Response(...)", 'function h() { return new Response("x"); }'],
      ["new Request(...)", 'const r = new Request("https://x");'],
      ["anotacion de tipo Request", "function h(req: Request) {}"],
      ["anotacion de tipo Response", "function h(): Response { return x; }"],
    ];
    for (const [nombre, fuente] of casos) expect(violacionesDeFrontera(fuente), fuente).toContain(nombre);
    expect(violacionesDeFrontera("export function total(a: number): number { return a * 2; }")).toEqual([]);
    expect(violacionesDeFrontera("// ver apps/api/src/app.ts y import { Hono } from \"hono\"\nexport const x = 1;")).toEqual([]);
  });
});

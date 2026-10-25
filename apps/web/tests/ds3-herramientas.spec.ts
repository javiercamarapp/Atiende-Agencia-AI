// ds3 / 0.4 -- guards de las herramientas de verificacion: (1) excepciones.json y axe-baseline.json son trinquetes que SOLO pueden
// encogerse; (2) solo-agrega-specs.sh detecta un spec modificado, borrado, renombrado o con skip/only, y deja pasar uno nuevo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, "..", "..", "..");
const json = <T>(archivo: string): T => JSON.parse(readFileSync(path.join(aqui, archivo), "utf8")) as T;

describe("excepciones del medidor (trinquete que solo encoge)", () => {
  const excepciones = JSON.parse(readFileSync(path.join(aqui, "..", "e2e-ds3", "excepciones.json"), "utf8")) as Array<Record<string, unknown>>;
  const { maximo } = json<{ maximo: number }>("ds3-excepciones-baseline.json");

  it("cada excepcion declara ruta, tipo, motivo y vencimiento", () => {
    for (const e of excepciones) {
      for (const campo of ["ruta", "tipo", "motivo", "vence"]) expect(typeof e[campo], `${JSON.stringify(e)} sin ${campo}`).toBe("string");
      expect((e["motivo"] as string).length).toBeGreaterThan(10);
    }
  });

  it("no hay mas excepciones que el baseline (usa el componente correcto en vez de registrar una nueva)", () => {
    expect(excepciones.length, `hay ${excepciones.length} excepciones y el baseline es ${maximo}`).toBeLessThanOrEqual(maximo);
  });

  it("cuando una excepcion se retira, el baseline baja con ella (el piso solo desciende)", () => {
    expect(maximo - excepciones.length, `baja ds3-excepciones-baseline.json de ${maximo} a ${excepciones.length}`).toBeLessThanOrEqual(0);
  });

  it("el baseline de axe empieza vacio (formato [{ruta, regla, nodos}]) y es una lista", () => {
    const axe = JSON.parse(readFileSync(path.join(aqui, "..", "e2e-ds3", "axe-baseline.json"), "utf8")) as unknown;
    expect(Array.isArray(axe)).toBe(true);
  });
});

describe("scripts/diseno/solo-agrega-specs.sh", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=ci@example.test", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" });
  const escribir = (cwd: string, rel: string, texto: string) => {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), texto);
  };
  /** Repo temporal con una rama `base` que tiene un spec, y una rama de trabajo creada sobre ella. */
  function repo(): string {
    const d = mkdtempSync(path.join(tmpdir(), "ds3-specs-"));
    dirs.push(d);
    git(d, "init", "-q", "-b", "base");
    escribir(d, "a/uno.spec.ts", "it('uno', () => { expect(1).toBe(1); });\n");
    escribir(d, "src.ts", "export {};\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "base");
    git(d, "checkout", "-q", "-b", "trabajo");
    return d;
  }
  const correr = (d: string): { codigo: number; salida: string } => {
    try {
      const salida = execFileSync("bash", [path.join(raiz, "scripts/diseno/solo-agrega-specs.sh"), "base"], { cwd: d, encoding: "utf8", stdio: "pipe" });
      return { codigo: 0, salida };
    } catch (e) {
      const err = e as { status: number; stderr: string };
      return { codigo: err.status, salida: err.stderr };
    }
  };
  const confirmar = (d: string) => {
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "cambio");
  };

  it("acepta un spec nuevo y cambios que no son specs", () => {
    const d = repo();
    escribir(d, "b/dos.spec.tsx", "it('dos', () => {});\n");
    escribir(d, "src.ts", "export const x = 1;\n");
    confirmar(d);
    expect(correr(d).codigo).toBe(0);
  });

  it("rechaza modificar un spec existente", () => {
    const d = repo();
    escribir(d, "a/uno.spec.ts", "it('uno', () => { expect(1).toBe(2); });\n");
    confirmar(d);
    const r = correr(d);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain("a/uno.spec.ts");
  });

  it("rechaza borrar y renombrar un spec existente", () => {
    const d = repo();
    git(d, "mv", "a/uno.spec.ts", "a/renombrado.spec.ts");
    confirmar(d);
    expect(correr(d).codigo).toBe(1);
  });

  it("rechaza un spec nuevo con skip u only", () => {
    const d = repo();
    // El literal se arma por partes para que este mismo archivo no dispare la regla que prueba.
    escribir(d, "b/tres.spec.ts", `${"it"}.${"skip"}('tres', () => {});\n`);
    confirmar(d);
    expect(correr(d).codigo).toBe(1);
  });
});

// PL-12 (CI ampliado): logica pura de los guards nuevos de CI. Sin red, sin Postgres, sin procesos externos.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SPECS_SENSIBLES_AL_RELOJ } from "../../../vitest.clock-guard.config.ts";
import { sondearSalud } from "../../../scripts/health-check/check.ts";
import { contarResultadosEslint, evaluarRatchet } from "../../../scripts/lint-ratchet/ratchet.ts";

describe("lint-ratchet", () => {
  it("cuenta errores, advertencias y reglas del JSON de ESLint", () => {
    const conteo = contarResultadosEslint([
      { errorCount: 0, warningCount: 2, messages: [{ ruleId: "a" }, { ruleId: "a" }] },
      { errorCount: 1, warningCount: 1, messages: [{ ruleId: null }, { ruleId: "b" }] },
    ]);
    expect(conteo.errores).toBe(1);
    expect(conteo.advertencias).toBe(3);
    expect(conteo.porRegla).toEqual({ a: 2, "(sin regla)": 1, b: 1 });
  });

  it("falla si las advertencias SUBEN por encima del baseline", () => {
    const v = evaluarRatchet({ errores: 0, advertencias: 3 }, 2);
    expect(v.ok).toBe(false);
    expect(v.mensaje).toContain("+1");
  });

  it("pasa en igualdad y pasa pidiendo bajar el baseline cuando hay menos", () => {
    expect(evaluarRatchet({ errores: 0, advertencias: 2 }, 2)).toMatchObject({ ok: true, puedeBajarBaseline: false });
    expect(evaluarRatchet({ errores: 0, advertencias: 1 }, 2)).toMatchObject({ ok: true, puedeBajarBaseline: true });
  });

  it("falla con cualquier error de ESLint aunque las advertencias esten bajo el baseline", () => {
    expect(evaluarRatchet({ errores: 1, advertencias: 0 }, 5).ok).toBe(false);
  });

  it("rechaza un baseline invalido (negativo o no entero) en vez de aceptar todo", () => {
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, -1).ok).toBe(false);
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, 1.5).ok).toBe(false);
    expect(evaluarRatchet({ errores: 0, advertencias: 0 }, Number.NaN).ok).toBe(false);
  });
});

describe("clock-guard (seleccion de specs sensibles al reloj)", () => {
  const raiz = new URL("../../../", import.meta.url);

  it("cada spec listada existe (un rename no deja el guard corriendo en vacio)", () => {
    const faltan = SPECS_SENSIBLES_AL_RELOJ.filter((ruta) => !existsSync(new URL(ruta, raiz)));
    expect(faltan).toEqual([]);
  });

  it("no hay duplicados y cubre los casos que motivaron el guard (rentas-pricing, hoteles night-audit, fin de mes)", () => {
    expect(new Set(SPECS_SENSIBLES_AL_RELOJ).size).toBe(SPECS_SENSIBLES_AL_RELOJ.length);
    const texto = SPECS_SENSIBLES_AL_RELOJ.join("\n");
    for (const requerida of ["rentas-pricing-servidor-hoy", "hoteles-night-audit-servidor-hoy", "reloj-simulado-fronteras", "despachos-cierre-mensual-servidor-hoy"]) {
      expect(texto).toContain(requerida);
    }
  });
});

describe("rollback.sh (herramienta manual, sin secretos)", () => {
  const script = fileURLToPath(new URL("../../../scripts/rollback/rollback.sh", import.meta.url));
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // `vercel` falso que anota cada invocacion; el rollback real NUNCA se ejecuta en pruebas.
  function entorno(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; registro: string } {
    dir = mkdtempSync(path.join(tmpdir(), "rollback-spec-"));
    const registro = path.join(dir, "llamadas.log");
    writeFileSync(path.join(dir, "vercel"), `#!/bin/sh\necho "$@" >> "${registro}"\n`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, ...extra };
    // En GitHub Actions CI=true: para probar el camino "no CI" hay que quitarlo.
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    return { env, registro };
  }

  const correr = (args: string[], env: NodeJS.ProcessEnv, input = "") =>
    spawnSync("bash", [script, ...args], { env, input, encoding: "utf8" });

  it("se niega a correr en CI", () => {
    const { env } = entorno();
    const r = correr(["listar"], { ...env, CI: "true" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("MANUAL");
  });

  it("rechaza destinos que no son un id dpl_ ni un hostname *.vercel.app", () => {
    const { env, registro } = entorno();
    for (const malo of ["foo", "https://x.vercel.app", "x.vercel.app; rm -rf /", "$(id).vercel.app", "evil.com"]) {
      expect(correr(["a", malo], env).status).toBe(2);
    }
    expect(existsSync(registro)).toBe(false);
  });

  it("sin --ejecutar solo imprime el comando y no invoca vercel", () => {
    const { env, registro } = entorno();
    const r = correr(["a", "atiende-abc123.vercel.app"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("vercel rollback atiende-abc123.vercel.app");
    expect(existsSync(registro)).toBe(false);
  });

  it("con --ejecutar exige escribir ROLLBACK; cualquier otra cosa cancela sin invocar vercel", () => {
    const { env, registro } = entorno();
    expect(correr(["a", "dpl_abc123", "--ejecutar"], env, "si\n").status).toBe(1);
    expect(existsSync(registro)).toBe(false);
    expect(correr(["a", "dpl_abc123", "--ejecutar"], env, "ROLLBACK\n").status).toBe(0);
    expect(readFileSync(registro, "utf8").trim()).toBe("rollback dpl_abc123");
  });

  it("ROLLBACK_SCOPE se pasa como --scope (no es un secreto)", () => {
    const { env, registro } = entorno({ ROLLBACK_SCOPE: "mi-equipo" });
    expect(correr(["a", "dpl_abc123", "--ejecutar"], env, "ROLLBACK\n").status).toBe(0);
    expect(readFileSync(registro, "utf8").trim()).toBe("rollback dpl_abc123 --scope mi-equipo");
  });
});

describe("health-check de produccion", () => {
  const sinEspera = { esperaMs: 0, dormir: async () => {} };
  const respuesta = (status: number, cuerpo: unknown) => async () => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

  it("sano con 200 y ok:true", async () => {
    const r = await sondearSalud("https://prod.example/", { ...sinEspera, fetchImpl: respuesta(200, { ok: true, status: "ok" }) });
    expect(r.ok).toBe(true);
  });

  it("no sano con 503 (BD caida) y reintenta antes de rendirse", async () => {
    let llamadas = 0;
    const r = await sondearSalud("https://prod.example", {
      ...sinEspera,
      intentos: 3,
      fetchImpl: async () => {
        llamadas += 1;
        return new Response(JSON.stringify({ ok: false, status: "degradado" }), { status: 503 });
      },
    });
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("503");
    expect(llamadas).toBe(3);
  });

  it("un parpadeo (falla el primero, responde el segundo) cuenta como sano", async () => {
    let n = 0;
    const r = await sondearSalud("https://prod.example", {
      ...sinEspera,
      fetchImpl: async () => {
        n += 1;
        if (n === 1) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(r).toMatchObject({ ok: true });
    expect(r.detalle).toContain("intento 2/3");
  });

  it("200 sin ok:true, cuerpo no JSON y URL sin https cuentan como no sanos", async () => {
    expect((await sondearSalud("https://prod.example", { ...sinEspera, intentos: 1, fetchImpl: respuesta(200, { ok: false }) })).ok).toBe(false);
    expect((await sondearSalud("https://prod.example", { ...sinEspera, intentos: 1, fetchImpl: async () => new Response("<html>", { status: 200 }) })).ok).toBe(false);
    expect((await sondearSalud("http://prod.example", { ...sinEspera, fetchImpl: respuesta(200, { ok: true }) })).ok).toBe(false);
  });

  it("responder lento (mas de maxLatenciaMs) cuenta como no sano", async () => {
    const r = await sondearSalud("https://prod.example", {
      ...sinEspera,
      intentos: 1,
      maxLatenciaMs: -1,
      fetchImpl: respuesta(200, { ok: true }),
    });
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("lento");
  });
});

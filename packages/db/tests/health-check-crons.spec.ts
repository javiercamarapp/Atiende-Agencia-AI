// Sondeo externo de la senal `crons` del /health (brief plataforma-pm-crons-y-vigilancia): servidor falso por fetch inyectado.
// ok => exit 0; crons != ok en DOS sondeos seguidos => exit 1 con un mensaje claro por estado; un solo dato malo no alarma;
// y el workflow deja un ::warning:: visible cuando falta PROD_BASE_URL (en vez de salir en verde silencioso).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main, sondearSalud } from "../../../scripts/health-check/check.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE = "https://prod.example";

/** Servidor falso: cada llamada a /health devuelve el siguiente cuerpo de la lista (el ultimo se repite). */
function servidor(cuerpos: ReadonlyArray<Record<string, unknown>>) {
  let n = 0;
  const esperas: number[] = [];
  return {
    llamadas: () => n,
    esperas,
    opciones: {
      intentos: 3,
      esperaMs: 0,
      esperaCronsMs: 6_000,
      dormir: async (ms: number) => {
        esperas.push(ms);
      },
      fetchImpl: async () => new Response(JSON.stringify(cuerpos[Math.min(n++, cuerpos.length - 1)]), { status: 200 }),
    },
  };
}
const SANO = { ok: true, status: "ok" };

describe("health-check: senal de crons", () => {
  it("crons:'ok' => sano en un solo sondeo (exit 0)", async () => {
    const s = servidor([{ ...SANO, crons: "ok" }]);
    const r = await sondearSalud(BASE, s.opciones);
    expect(r).toMatchObject({ ok: true, crons: "ok" });
    expect(s.llamadas()).toBe(1);
    let salida = "";
    const codigo = await main(["node", "check.ts", BASE], {}, servidor([{ ...SANO, crons: "ok" }]).opciones, { salida: (t) => (salida = t), error: () => undefined });
    expect(codigo).toBe(0);
    expect(salida).toMatch(/^SANO:/);
  });

  it("sin_latido en dos sondeos seguidos => no sano (exit 1) con un mensaje claro, esperando mas que el cache publico de 5 s entre sondeos", async () => {
    const s = servidor([{ ...SANO, crons: "sin_latido" }]);
    let salida = "";
    const codigo = await main(["node", "check.ts", BASE], {}, s.opciones, { salida: (t) => (salida = t), error: () => undefined });
    expect(codigo).toBe(1);
    expect(salida).toMatch(/^NO SANO: crons SIN LATIDO/);
    expect(salida).toContain("2 sondeos seguidos");
    expect(s.llamadas()).toBe(2);
    expect(s.esperas).toEqual([6_000]);
    expect(s.esperas[0]!).toBeGreaterThan(5_000);
  });

  it.each([
    ["atrasados", /ATRASADOS/],
    ["sin_medir", /SIN MEDIR/],
  ])("%s en dos sondeos seguidos => no sano con su propio mensaje", async (estado, mensaje) => {
    const r = await sondearSalud(BASE, servidor([{ ...SANO, crons: estado }]).opciones);
    expect(r.ok).toBe(false);
    expect(r.detalle).toMatch(mensaje);
  });

  it("un solo sondeo malo seguido de uno ok NO alarma (parpadeo)", async () => {
    const s = servidor([{ ...SANO, crons: "sin_latido" }, { ...SANO, crons: "ok" }]);
    const r = await sondearSalud(BASE, s.opciones);
    expect(r.ok).toBe(true);
    expect(r.detalle).toContain("crons ok en el segundo sondeo");
    expect(s.llamadas()).toBe(2);
  });

  it("un /health sin el campo crons (version anterior desplegada) no falla, pero lo anota", async () => {
    const r = await sondearSalud(BASE, servidor([SANO]).opciones);
    expect(r.ok).toBe(true);
    expect(r.detalle).toContain("no trae la senal de crons");
  });

  it("la API caida sigue fallando antes de mirar crons (503 => no sano)", async () => {
    const r = await sondearSalud(BASE, { intentos: 1, esperaMs: 0, dormir: async () => {}, fetchImpl: async () => new Response(JSON.stringify({ ok: false, status: "degradado", crons: "sin_medir" }), { status: 503 }) });
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("503");
  });

  it("sin URL: exit 2 (uso incorrecto) y nada se sondea", async () => {
    let errores = "";
    const codigo = await main(["node", "check.ts"], {}, { fetchImpl: async () => { throw new Error("no debe llamarse"); } }, { salida: () => undefined, error: (t) => (errores += t) });
    expect(codigo).toBe(2);
    expect(errores).toContain("Uso:");
  });
});

describe("prod-health.yml", () => {
  const yml = readFileSync(path.join(REPO, ".github", "workflows", "prod-health.yml"), "utf8");

  it("sin PROD_BASE_URL deja un ::warning:: visible y un aviso en el resumen (y sigue sin dar rojo)", () => {
    const rama = yml.slice(yml.indexOf('if [ -z "${PROD_BASE_URL:-}" ]'), yml.indexOf("salida=\"$(node"));
    expect(rama).toContain("::warning");
    expect(rama).toContain("GITHUB_STEP_SUMMARY");
    expect(rama).toContain("resultado=omitido");
    expect(rama).toContain("exit 0");
  });

  it("no cambia la frecuencia (cada 15 minutos) ni agrega disparadores", () => {
    expect(yml).toContain('cron: "*/15 * * * *"');
    expect(yml.match(/^\s+- cron:/gm)).toHaveLength(1);
    const disparadores = yml.slice(yml.indexOf("\non:"), yml.indexOf("\nconcurrency:"));
    expect(disparadores).not.toMatch(/pull_request|push:/);
  });
});

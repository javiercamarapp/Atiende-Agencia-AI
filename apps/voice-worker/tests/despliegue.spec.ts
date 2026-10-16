// Despliegue en Fly.io: fly.toml (region, una maquina siempre encendida, health check del latido) y `scripts/voz/desplegar-worker.sh` contra un `fly` FALSO
// (no hay cuenta: nunca se ejecuto contra Fly). Se afirma el ORDEN de las llamadas y que ningun valor secreto aparece en argumentos ni en la salida.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MENSAJE_IDS } from "@atiende/voice-core";

const RAIZ = join(import.meta.dirname, "../../..");
const SCRIPT = join(RAIZ, "scripts/voz/desplegar-worker.sh");
const FLY_TOML = readFileSync(join(RAIZ, "apps/voice-worker/fly.toml"), "utf8");
const DOCKERFILE = readFileSync(join(RAIZ, "apps/voice-worker/Dockerfile"), "utf8");

describe("fly.toml", () => {
  it("region Dallas, sin servicio HTTP publico (no se detiene ni escala: una sola maquina siempre encendida) y reinicio siempre", () => {
    expect(FLY_TOML).toMatch(/^primary_region = "dfw"$/m);
    expect(FLY_TOML).not.toMatch(/^\[http_service\]/m);
    expect(FLY_TOML).not.toMatch(/^\[\[services\]\]/m);
    expect(FLY_TOML).not.toMatch(/auto_stop_machines|min_machines_running/);
    expect(FLY_TOML).toMatch(/\[\[restart\]\]\s+policy = "always"/);
  });
  it("maquina minima (shared-cpu-1x, 1 GB) y puerto/ruta de salud iguales a los del worker", () => {
    expect(FLY_TOML).toMatch(/size = "shared-cpu-1x"/);
    expect(FLY_TOML).toMatch(/memory = "1gb"/);
    expect(FLY_TOML).toMatch(/PORT = "8080"/);
    expect(FLY_TOML).toMatch(/\[checks\.salud\][\s\S]*type = "http"[\s\S]*port = 8080[\s\S]*path = "\/salud"/);
    expect(DOCKERFILE).toContain("EXPOSE 8080");
    expect(DOCKERFILE).toContain("/salud");
  });
  it("los audios pregrabados viajan en la imagen y la receta no lleva secretos", () => {
    expect(DOCKERFILE).toMatch(/COPY --from=bundle \/repo\/apps\/voice-worker\/assets \.\/assets/);
    const sinComentarios = FLY_TOML.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(sinComentarios).not.toMatch(/SECRET|API_KEY|TOKEN/i);
    expect(DOCKERFILE).not.toMatch(/API_KEY=|SECRET=/);
  });
});

function entorno(extra: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "voz-desplegar-"));
  const assets = join(dir, "assets");
  mkdirSync(assets);
  for (const id of MENSAJE_IDS) writeFileSync(join(assets, `${id}.wav`), "RIFF....WAVE");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const registro = join(dir, "fly.log");
  const stdinLog = join(dir, "stdin.log");
  writeFileSync(join(bin, "fly"), `#!/usr/bin/env bash\necho "fly $*" >> "${registro}"\nif [ "$1" = "secrets" ]; then cat >> "${stdinLog}"; fi\nif [ "$1" = "apps" ] && [ "$2" = "create" ]; then touch "${dir}/app-creada"; fi
if [ "$1" = "status" ] && [ -n "\${FLY_FALSO_SIN_APP:-}" ] && [ ! -f "${dir}/app-creada" ]; then exit 1; fi\nexit 0\n`);
  chmodSync(join(bin, "fly"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: dir,
    VOZ_ASSETS_DIR: assets,
    LIVEKIT_URL: "wss://x.livekit.invalid",
    LIVEKIT_API_KEY: "VALOR-LK-KEY",
    LIVEKIT_API_SECRET: "VALOR-LK-SECRET",
    ATIENDE_API_URL: "https://api.invalid",
    INTERNAL_SECRET: "VALOR-INTERNO",
    GEMINI_API_KEY: "VALOR-GEMINI",
    VOICE_DNIS_MAP: JSON.stringify({ "+52 999 111 0001": { orgSlug: "o", organizationId: "x", propertyId: "y", branchSlug: "b", secretoEnv: "VOICE_SECRET_FCO" } }),
    VOICE_SECRET_FCO: "VALOR-SUCURSAL",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { env, registro, stdinLog, correr: (...args: string[]) => spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8", cwd: RAIZ }) };
}
const leer = (ruta: string): string => {
  try {
    return readFileSync(ruta, "utf8");
  } catch {
    return "";
  }
};

describe("scripts/voz/desplegar-worker.sh", () => {
  it("la lista de pregrabados del script es EXACTAMENTE la de MENSAJE_IDS", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const m = /MENSAJES=\(([^)]*)\)/.exec(script);
    expect(m?.[1]?.trim().split(/\s+/)).toEqual([...MENSAJE_IDS]);
  });

  it("por omision es un ENSAYO: valida y lista nombres de secretos, no llama a fly y no imprime ningun valor", () => {
    const t = entorno();
    const r = t.correr();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ENSAYO");
    expect(r.stdout).toContain("VOICE_SECRET_FCO");
    expect(r.stdout + r.stderr).not.toMatch(/VALOR-/);
    expect(leer(t.registro)).toBe("");
  });

  it("falta una variable: sale con error y nombra SOLO la variable (tambien el secreto de sucursal que nombra VOICE_DNIS_MAP)", () => {
    const t = entorno({ GEMINI_API_KEY: undefined, VOICE_SECRET_FCO: undefined });
    const r = t.correr("--ejecutar");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("GEMINI_API_KEY");
    expect(r.stderr).toContain("VOICE_SECRET_FCO (secreto de sucursal)");
    expect(r.stderr).not.toMatch(/VALOR-/);
    expect(leer(t.registro)).toBe("");
  });

  it("VOICE_DNIS_MAP invalido: error claro sin llamar a fly", () => {
    const t = entorno({ VOICE_DNIS_MAP: "{no es json" });
    const r = t.correr("--ejecutar");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("VOICE_DNIS_MAP");
    expect(leer(t.registro)).toBe("");
  });

  it("sin los 15 pregrabados no despliega (el worker no contestaria) y dice cuales faltan", () => {
    const t = entorno();
    writeFileSync(join(t.env.VOZ_ASSETS_DIR!, "handoff.wav"), "");
    const r = t.correr("--ejecutar");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("handoff.wav");
    expect(leer(t.registro)).toBe("");
  });

  it("--ejecutar: crea la app si no existe, sube los secretos por ENTRADA ESTANDAR (nunca por argumentos), despliega con una sola maquina y escala a 1, en ese orden", () => {
    const t = entorno({ FLY_FALSO_SIN_APP: "1", OPENROUTER_API_KEY: "VALOR-OPENROUTER", VOICE_TOPE_MENSUAL_USD: "50" });
    const r = t.correr("--ejecutar");
    expect(r.status).toBe(0);
    const llamadas = leer(t.registro).trim().split("\n");
    expect(llamadas.map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["fly status -a", "fly apps create", "fly secrets import", "fly deploy --config", "fly scale count", "fly status -a"]);
    expect(llamadas[0]).toContain("atiende-voice-worker");
    const deploy = llamadas.find((l) => l.startsWith("fly deploy"))!;
    expect(deploy).toContain("--ha=false");
    expect(deploy).toContain("--config apps/voice-worker/fly.toml");
    expect(deploy).toContain("--dockerfile apps/voice-worker/Dockerfile");
    expect(deploy).toContain("--ignorefile apps/voice-worker/Dockerfile.dockerignore");
    // Ningun valor en argumentos ni en la salida; los nombres y valores viajaron por stdin.
    expect(leer(t.registro)).not.toMatch(/VALOR-/);
    expect(r.stdout + r.stderr).not.toMatch(/VALOR-/);
    const stdin = leer(t.stdinLog);
    for (const n of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "ATIENDE_API_URL", "INTERNAL_SECRET", "GEMINI_API_KEY", "VOICE_DNIS_MAP", "VOICE_SECRET_FCO", "OPENROUTER_API_KEY", "VOICE_TOPE_MENSUAL_USD"]) expect(stdin).toContain(`${n}=`);
    expect(stdin).toContain('VOICE_SECRET_FCO="VALOR-SUCURSAL"');
    expect(llamadas.find((l) => l.startsWith("fly secrets"))).toContain("--stage");
  });

  it("si la app ya existe no la vuelve a crear; sin `fly` instalado falla con instrucciones", () => {
    const t = entorno();
    expect(t.correr("--ejecutar").status).toBe(0);
    expect(leer(t.registro)).not.toContain("apps create");
    const sinFly = entorno({ FLY_BIN: "fly-no-existe" });
    const r = sinFly.correr("--ejecutar");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fly");
  });

  it("un argumento desconocido se rechaza", () => {
    expect(entorno().correr("--borrar-todo").status).toBe(2);
  });
});

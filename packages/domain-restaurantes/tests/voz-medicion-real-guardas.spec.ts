// Guardas de seguridad del arnes de voz con modelo real (scripts/voz-medicion-real/guardas.ts) y del analizador. No llama a ningun proveedor ni gasta saldo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AbortoDeSeguridad, dirQaDentroDelRepo, elegirTelefonoLibre, esTelefonoFicticio, excedeTope, gastoPropioUsd, hostsDePool, hostEsLoopback, parseCorte, redactar, soloHost, sumarCosto, telefonoFicticio, validarEntorno,
  TopeExcedido, urlEsLoopback, validarAislamiento,
} from "../../../scripts/voz-medicion-real/guardas.ts";

const pool = (host: string) => ({ options: { host }, query: async () => ({ rows: [] }) });
const stackOk = () => ({ api: "http://127.0.0.1:8787", pool: pool("localhost"), metaSimulado: true });

describe("aislamiento: API, base y Meta", () => {
  it("reconoce loopback y rechaza lo demas", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.5", "/var/run/postgresql"]) expect(hostEsLoopback(h), h).toBe(true);
    for (const h of ["db.supabase.co", "10.0.0.5", "0.0.0.0", "127.0.0.1.evil.com", "", null, undefined]) expect(hostEsLoopback(h as string), String(h)).toBe(false);
    expect(urlEsLoopback("http://localhost:3000/x")).toBe(true);
    expect(urlEsLoopback("https://api.atiende.example")).toBe(false);
    expect(urlEsLoopback("no es url")).toBe(false);
  });

  it("acepta un stack local con Meta simulado", () => {
    expect(() => validarAislamiento(stackOk(), {})).not.toThrow();
  });

  it("aborta si la API no es loopback", () => {
    expect(() => validarAislamiento({ ...stackOk(), api: "https://api.ejemplo.com" }, {})).toThrow(AbortoDeSeguridad);
    expect(() => validarAislamiento({ ...stackOk(), api: undefined }, {})).toThrow(/API/);
  });

  it("aborta si la base no es local (opciones, cadena de conexion o PGHOST)", () => {
    expect(() => validarAislamiento({ ...stackOk(), pool: pool("db.proyecto.supabase.co") }, {})).toThrow(/base/);
    expect(() => validarAislamiento({ ...stackOk(), pool: { options: { connectionString: "postgres://u:p@db.remota.net:5432/x" }, query: () => 0 } }, {})).toThrow(/base/);
    expect(() => validarAislamiento({ ...stackOk(), pool: { options: { connectionString: "postgres://u:p@127.0.0.1:5432/x" }, query: () => 0 } }, {})).not.toThrow();
    expect(() => validarAislamiento({ ...stackOk(), pool: { options: {}, query: () => 0 } }, { PGHOST: "10.1.2.3" })).toThrow(/PGHOST/); // lo atrapa ya la revision del entorno
    expect(() => validarAislamiento({ ...stackOk(), pool: { options: {}, query: () => 0 } }, { PGHOST: "localhost" })).not.toThrow();
    expect(() => validarAislamiento({ ...stackOk(), pool: undefined }, {})).toThrow(/base/);
    expect(hostsDePool({ options: {}, query: () => 0 }, {})).toEqual(["localhost"]);
  });

  it("valida AMBOS: en pg la cadena de conexion sobrescribe a host, asi que host local + cadena remota (o al reves) aborta", () => {
    const con = (options: object) => ({ ...stackOk(), pool: { options, query: () => 0 } });
    expect(() => validarAislamiento(con({ host: "localhost", connectionString: "postgres://u:p@db.remota.net:5432/x" }), {})).toThrow('host "db.remota.net"');
    expect(() => validarAislamiento(con({ host: "db.remota.net", connectionString: "postgres://u:p@127.0.0.1:5432/x" }), {})).toThrow('host "db.remota.net"');
    expect(() => validarAislamiento(con({ host: "localhost", connectionString: "postgres://u:p@127.0.0.1:5432/x" }), {})).not.toThrow();
    expect(() => validarAislamiento(con({ connectionString: "postgres://u:p@/x?host=db.remota.net" }), {})).toThrow('host "db.remota.net"');
    expect(() => validarAislamiento(con({ connectionString: "postgres://u:p@/x?host=/var/run/postgresql" }), {})).not.toThrow();
    expect(() => validarAislamiento(con({ connectionString: "esto no es una url" }), {})).toThrow(/base/);
    expect(hostsDePool(con({ host: "a", connectionString: "postgres://u:p@b/x" }).pool, {})).toEqual(["a", "b"]);
  });

  it("un valor que empieza con // NO es un socket unix ni loopback", () => {
    expect(hostEsLoopback("//evil.com")).toBe(false);
    expect(hostEsLoopback("//127.0.0.1")).toBe(false);
    expect(hostEsLoopback("/var/run/postgresql")).toBe(true);
    expect(() => validarEntorno({ DATABASE_URL: "//evil.com/db" })).toThrow(/DATABASE_URL/);
    expect(() => validarAislamiento({ ...stackOk(), pool: pool("//evil.com") }, {})).toThrow(/base/);
  });

  it("los mensajes de aborto muestran solo el host, nunca la URL (ni usuario, clave o token)", () => {
    const api = "https://usuario:clave-secreta@api.ejemplo.com/ruta?token=abc123";
    let msg = "";
    try { validarAislamiento({ ...stackOk(), api }, {}); } catch (x) { msg = (x as Error).message; }
    expect(msg).toContain("api.ejemplo.com");
    expect(msg).not.toMatch(/clave-secreta|abc123|usuario|ruta/);
    let msg2 = "";
    try { validarEntorno({ SUPABASE_URL: "https://u:pw-secreto@x.supabase.co/?k=tok" }); } catch (x) { msg2 = (x as Error).message; }
    expect(msg2).toContain("SUPABASE_URL");
    expect(msg2).not.toMatch(/pw-secreto|tok/);
    expect(soloHost("https://u:p@h.example.com/x")).toBe("h.example.com");
    expect(soloHost("no url")).toBe("(no es una URL)");
  });

  it("revisa variables de Meta con sufijos amplios y las de servicios que el API heredaria", () => {
    for (const k of ["META_API_ENDPOINT", "WHATSAPP_ORIGIN", "GRAPH_API_URI", "FACEBOOK_GRAPH_DOMAIN", "SUPABASE_URL", "DATABASE_URL", "STRIPE_API_BASE", "REDIS_HOST"]) {
      expect(() => validarEntorno({ [k]: "https://externo.example.com" }), k).toThrow(k);
      expect(() => validarEntorno({ [k]: "http://127.0.0.1:9" }), k).not.toThrow();
    }
    expect(() => validarEntorno({ OPENROUTER_BASE_URL: "https://openrouter.ai/api" })).not.toThrow(); // el modelo real si se llama
    expect(() => validarEntorno({ STRIPE_SECRET_KEY: "x", PATH: "/usr/bin" })).not.toThrow();
  });

  it("aborta si el Meta simulado no esta activo o una variable de Meta apunta fuera", () => {
    expect(() => validarAislamiento({ api: "http://127.0.0.1:1", pool: pool("localhost") }, {})).toThrow(/Meta simulado/);
    expect(() => validarAislamiento({ ...stackOk(), metaSimulado: false }, {})).toThrow(/Meta simulado/);
    expect(() => validarAislamiento({ api: "http://127.0.0.1:1", pool: pool("localhost"), metaUrl: "http://localhost:9000" }, {})).not.toThrow();
    expect(() => validarAislamiento(stackOk(), { META_GRAPH_BASE_URL: "https://graph.example.com" })).toThrow(/META_GRAPH_BASE_URL/);
    expect(() => validarAislamiento(stackOk(), { META_GRAPH_BASE_URL: "http://127.0.0.1:9000" })).not.toThrow();
  });
});

describe("VOZ_QA_DIR dentro del repo", () => {
  const raiz = mkdtempSync(join(tmpdir(), "voz-repo-"));
  const fuera = mkdtempSync(join(tmpdir(), "voz-fuera-"));
  mkdirSync(join(raiz, "qa"));

  it("acepta un directorio dentro del repo y devuelve la ruta real", () => {
    expect(dirQaDentroDelRepo(join(raiz, "qa"), raiz)).toContain("qa");
  });
  it("rechaza vacio, inexistente, fuera del repo, la propia raiz y un enlace simbolico que escapa", () => {
    expect(() => dirQaDentroDelRepo(undefined, raiz)).toThrow(AbortoDeSeguridad);
    expect(() => dirQaDentroDelRepo(join(raiz, "no-existe"), raiz)).toThrow(/no existe/);
    expect(() => dirQaDentroDelRepo(fuera, raiz)).toThrow(/dentro del repo/);
    expect(() => dirQaDentroDelRepo(raiz, raiz)).toThrow(/dentro del repo/);
    symlinkSync(fuera, join(raiz, "escape"));
    expect(() => dirQaDentroDelRepo(join(raiz, "escape"), raiz)).toThrow(/dentro del repo/);
  });
});

describe("tope de gasto", () => {
  it("VOZ_CORTE_USD: omision 1.5; solo numeros finitos mayores que 0", () => {
    expect(parseCorte(undefined)).toBe(1.5);
    expect(parseCorte("")).toBe(1.5);
    expect(parseCorte("0.25")).toBe(0.25);
    for (const malo of ["abc", "0", "-1", "NaN", "Infinity", "1e999"]) expect(() => parseCorte(malo), malo).toThrow(AbortoDeSeguridad);
  });
  it("falla CERRADO ante un gasto NaN/Infinity/indefinido (no se apaga el tope)", () => {
    for (const malo of [Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) expect(excedeTope(malo, 1), String(malo)).toBe(true);
    expect(excedeTope(0.5, 1)).toBe(false);
    expect(excedeTope(gastoPropioUsd({ cerradoUsd: 0.1, llamadaEnCursoUsd: Number.NaN, clienteJuezUsd: 0 }), 1)).toBe(true);
    // un costo que llega sin numero (callback con m indefinido) vuelve NaN la suma y el tope corta
    expect(sumarCosto(0.2, 0.3)).toBeCloseTo(0.5);
    expect(Number.isNaN(sumarCosto(0.2, undefined))).toBe(true);
    expect(Number.isNaN(sumarCosto(0.2, "0.3"))).toBe(true);
    expect(Number.isNaN(sumarCosto(Number.NaN, 0.3))).toBe(true);
    expect(excedeTope(sumarCosto(0.2, undefined), 1)).toBe(true);
  });
  it("cuenta propia: lo cerrado + la llamada en curso + cliente/juez; corta al alcanzarlo", () => {
    const g = gastoPropioUsd({ cerradoUsd: 0.4, llamadaEnCursoUsd: 0.3, clienteJuezUsd: 0.2 });
    expect(g).toBeCloseTo(0.9);
    expect(excedeTope(g, 1)).toBe(false);
    expect(excedeTope(g, g)).toBe(true);
    expect(excedeTope(g, g + 0.01)).toBe(false);
    const e = new TopeExcedido(1.2, 1);
    expect(e.gastoUsd).toBe(1.2);
    expect(e).toBeInstanceOf(Error);
  });
});

describe("telefonos ficticios", () => {
  it("todos caen en 521 999 555 01xx y ninguno parece real", () => {
    for (let i = 0; i < 250; i += 1) {
      const t = telefonoFicticio(i);
      expect(esTelefonoFicticio(t), t).toBe(true);
      expect(t).toMatch(/^52199955501\d{2}$/);
    }
    expect(esTelefonoFicticio("5219991234567")).toBe(false);
  });
  it("elige el primero libre y aborta si los 100 estan ocupados", async () => {
    const ocupados = new Set([telefonoFicticio(5).slice(-10), telefonoFicticio(6).slice(-10)]);
    expect(await elegirTelefonoLibre(async (p) => (ocupados.has(p) ? 1 : 0), 5)).toBe(telefonoFicticio(7));
    await expect(elegirTelefonoLibre(async () => 1, 0)).rejects.toThrow(AbortoDeSeguridad);
  });
});

describe("redaccion de errores", () => {
  it("oculta claves, tokens y sk-*", () => {
    const r = redactar("fallo key=abc123 Bearer: xyz y sk-or-v1-AbC_123 al final");
    expect(r).not.toMatch(/abc123|xyz|AbC_123/);
    expect(r).toContain("sk-***");
  });
});

describe("ejecutar.ts usa las guardas", () => {
  const src = readFileSync(join(__dirname, "../../../scripts/voz-medicion-real/ejecutar.ts"), "utf8");
  it("las invoca y ya no usa telefonos aleatorios ni el id de organizacion fijo", () => {
    for (const n of ["dirQaDentroDelRepo(", "validarAislamiento(", "validarEntorno(", "sumarCosto(", "parseCorte(", "elegirTelefonoLibre(", "verificarTope()", "redactar("]) expect(src, n).toContain(n);
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(src).not.toMatch(/Number\(process\.env\.VOZ_CORTE_USD/);
  });
  it("verifica el tope en cada turno y en cada generacion del cliente", () => {
    expect(src).toMatch(/const hablar = async[^\n]*\n\s*verificarTope\(\)/);
    expect(src).toMatch(/const generar = async[^\n]*\n\s*verificarTope\(\)/);
  });
});

describe("analizar.py", () => {
  const registro = (id: string, extra: Record<string, unknown> = {}) => ({
    id, titulo: `t ${id}`, veredicto: "PASA", hard: [], juez: "PASA", infra: [], msTurno: [100], msPrimeraFrase: [50], conHerramienta: [false], toolLatMs: [1],
    palabrasAgente: [5], llmUsd: 0.01, modelo: "m", sinZdr: false, totalEscenarios: 3, ...extra,
  });
  const analizar = (reps: unknown[][], etq = "main") => {
    const d = mkdtempSync(join(tmpdir(), "voz-an-"));
    reps.forEach((r, i) => writeFileSync(join(d, `voz-real-${etq}-rep${i + 1}.json`), JSON.stringify(r)));
    try {
      return { out: execFileSync("python3", ["-I", join(__dirname, "../../../scripts/voz-medicion-real/analizar.py"), d, etq], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
    } catch (x) {
      const e = x as { status: number; stdout: string; stderr: string };
      return { out: `${e.stdout}${e.stderr}`, code: e.status };
    }
  };

  it("las llamadas con caida/vacio del LLM NO cuentan como acierto y se reportan aparte", () => {
    const { out } = analizar([[registro("A"), registro("B", { infra: ["v2_llm_caida:x"], invalida: true, veredicto: "INVALIDA" }), registro("C", { infra: ["vacia"] })]]);
    expect(out).toContain("1/1 = 100.0 %"); // solo A es valida
    expect(out).toMatch(/2 llamadas INVALIDAS/);
    expect(out).toContain("B, C");
  });
  it("avisa cuando hay menos escenarios que los esperados", () => {
    const { out } = analizar([[registro("A"), registro("B")]]);
    expect(out).toMatch(/INCOMPLETA: 2\/3/);
  });
  it("las excepciones del arnes tambien son invalidas y no cuentan como fallo del agente", () => {
    const { out } = analizar([[registro("A"), { id: "B", titulo: "t", veredicto: "INVALIDA", invalida: true, excepcion: true, causa: "arnes", motivo: "x", modelo: "m", totalEscenarios: 3 }]]);
    expect(out).toContain("1/1 = 100.0 %");
    expect(out).toMatch(/Excepciones del arnes \(INVALIDAS/);
  });
  it("cuenta solo registros con hard presente y no divide entre cero", () => {
    const { out } = analizar([[registro("A"), { id: "B", titulo: "t", veredicto: "FALLA", excepcion: true, causa: "arnes", motivo: "x", modelo: "m", totalEscenarios: 3 }]]);
    expect(out).toContain("Solo checks deterministas: 1/1");
    const vacio = analizar([[registro("A", { infra: ["caida"] })]]);
    expect(vacio.code).not.toBe(0);
    expect(vacio.out).toMatch(/No hay llamadas validas/);
  });
  it("marca las corridas NO oficiales (sin ZDR) y muestra el modelo", () => {
    const { out } = analizar([[registro("A", { sinZdr: true, oficial: false, modelo: "barato/x" })]]);
    expect(out).toMatch(/NO OFICIALES/);
    expect(out).toContain("barato/x");
  });
  it("un JSON corrupto aborta con mensaje claro", () => {
    const d = mkdtempSync(join(tmpdir(), "voz-an-"));
    writeFileSync(join(d, "voz-real-main-rep1.json"), "{no es json");
    expect(() => execFileSync("python3", ["-I", join(__dirname, "../../../scripts/voz-medicion-real/analizar.py"), d], { stdio: "pipe" })).toThrow();
  });
});

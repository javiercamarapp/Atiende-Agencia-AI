// Nucleo del banco de voz (scripts/voz-banco): corredor, topes, aislamiento, cliente simulado y esquema del corpus. Sin red, sin llaves, sin gasto.
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crearAdaptadorFalso } from "../../../scripts/voz-banco/adaptadores/falso.ts";
import type { GuionFalso } from "../../../scripts/voz-banco/adaptadores/falso.ts";
import { exigirAislamiento } from "../../../scripts/voz-banco/aislamiento.ts";
import { ClienteSimulado, semillaDe } from "../../../scripts/voz-banco/cliente-simulado.ts";
import { cargarCorpusPrivado, cargarEjemplos, rutaCorpusPrivado, validarEscenario, validarLista } from "../../../scripts/voz-banco/corpus.ts";
import { correrLlamada } from "../../../scripts/voz-banco/correr-llamada.ts";
import { crearAdaptador, listarAdaptadores } from "../../../scripts/voz-banco/registro.ts";
import { AbortoDeSeguridad, TopeDeLlamada, TopeExcedido, TopeGasto, corteDeEntorno } from "../../../scripts/voz-banco/topes.ts";
import type { EjecutarTool, ModoCompuerta } from "../../../scripts/voz-banco/tipos.ts";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));
const APERTURA = { instruccion: "prueba", voiceId: "falso", herramientas: [] } as const;
const [EJ1, EJ2] = cargarEjemplos();

function servidor() {
  const llamadas: string[] = [];
  const ejecutar: EjecutarTool = async (l) => {
    llamadas.push(l.nombre);
    if (l.nombre === "cotizar_pedido") return { quote: { total: 126 }, quote_hash: "abc".padEnd(32, "0") };
    if (l.nombre === "crear_pedido") return { order: { id: "o1" } };
    return { ok: true };
  };
  return { llamadas, ejecutar };
}

/** Guion del agente "apresurado": cotiza, y en el SIGUIENTE turno confirma y crea sin importar lo que el cliente dijo. */
const guionApresurado: GuionFalso = (turno) =>
  turno === 0
    ? { herramientas: [{ nombre: "cotizar_pedido" }], diceDespues: "Son tres tacos, el total es 126 pesos. Confirma?" }
    : { herramientas: [{ nombre: "confirmar_resumen" }, { nombre: "crear_pedido" }], diceDespues: "Listo." };

const correr = (opts: { guion?: GuionFalso; modo?: ModoCompuerta; tope?: TopeGasto; srv?: ReturnType<typeof servidor>; rep?: number; cliente?: "texto" | "stt-final" }) =>
  correrLlamada({
    adaptador: crearAdaptadorFalso(opts.guion), escenario: EJ1!, rep: opts.rep ?? 1, modoCliente: opts.cliente ?? "stt-final", modoCompuerta: opts.modo ?? "on",
    tope: opts.tope ?? new TopeGasto(5, 1), apertura: APERTURA, ejecutor: (opts.srv ?? servidor()).ejecutar,
  });

describe("corredor de punta a punta con el adaptador falso", () => {
  it("corre un escenario completo y entrega el esquema del resultado", async () => {
    const r = await correr({});
    expect(r).toMatchObject({ escenario: "EJ-001", arquitectura: "falso", modo: "M0-stt-final", cortada: null });
    expect(r.turnos).toHaveLength(2);
    expect(r.turnos[0]!.agente).toMatch(/^Entendido:/);
    expect(r.semilla).toBe(semillaDe("EJ-001", 1));
  });

  it("compuerta on: el agente apresurado intenta crear y NO se crea nada; off: se crea un pedido indebido", async () => {
    const on = servidor();
    const rOn = await correr({ guion: guionApresurado, modo: "on", srv: on, cliente: "texto" });
    // (cliente sin ruido) el «Si, correcto» del guion SI es una afirmacion pura y el total se leyo: es el camino feliz, crear corre una vez y no es «sin confirmar»
    expect(on.llamadas.filter((n) => n === "crear_pedido")).toHaveLength(1);
    expect(rOn.intentosCrearSinConfirmar).toBe(0);

    // mismo agente, pero ahora el cliente NO afirma: pregunta otra cosa
    const noAfirma = { ...EJ1!, turnos: ["Buenas tardes, quiero tres tacos de pastor para recoger", "Y cuanto tardan?"] };
    const srvOn = servidor();
    const bloqueado = await correrLlamada({ adaptador: crearAdaptadorFalso(guionApresurado), escenario: noAfirma, rep: 1, modoCliente: "texto", modoCompuerta: "on", tope: new TopeGasto(5, 1), apertura: APERTURA, ejecutor: srvOn.ejecutar });
    expect(srvOn.llamadas).not.toContain("crear_pedido");
    expect(bloqueado.intentosCrearSinConfirmar).toBe(1);
    expect(bloqueado.crearIndebidosEjecutados).toBe(0);

    const srvOff = servidor();
    const indebido = await correrLlamada({ adaptador: crearAdaptadorFalso(guionApresurado), escenario: noAfirma, rep: 1, modoCliente: "texto", modoCompuerta: "off", tope: new TopeGasto(5, 1), apertura: APERTURA, ejecutor: srvOff.ejecutar });
    expect(srvOff.llamadas).toContain("crear_pedido");
    expect(indebido.crearIndebidosEjecutados).toBe(1);
  });

  it("modo texto no degrada lo que oye el agente; stt-final es determinista y pareado entre repeticiones iguales", async () => {
    const a = await correr({ rep: 3 });
    const b = await correr({ rep: 3 });
    expect(a.turnos.map((t) => t.oido)).toEqual(b.turnos.map((t) => t.oido));
  });
});

describe("topes de gasto (fallan cerrado)", () => {
  it("la corrida se corta al llegar al tope", async () => {
    const tope = new TopeGasto(0.0005, 1); // 500 micro-USD
    await expect(correr({ guion: () => ({ dice: "hola", costoMicroUsd: 600 }), tope })).rejects.toBeInstanceOf(TopeExcedido);
  });

  it.each([[Number.NaN], [-5], [undefined], ["2"], [Number.POSITIVE_INFINITY]])("un costo no valido (%s) corta en vez de apagar el tope", async (costo) => {
    await expect(correr({ guion: () => ({ dice: "hola", costoMicroUsd: costo }) })).rejects.toBeInstanceOf(TopeExcedido);
  });

  it("un costo valido por debajo del tope NO corta", async () => {
    const tope = new TopeGasto(5, 1);
    await correr({ guion: () => ({ dice: "hola", costoMicroUsd: 100 }), tope });
    expect(tope.gastoUsd).toBeCloseTo(0.0002, 8);
  });

  it("el tope por llamada cierra ESA llamada (tope_llamada) y la siguiente arranca de cero", async () => {
    const tope = new TopeGasto(5, 0.0001); // 100 micro-USD por llamada
    const r1 = await correr({ guion: () => ({ dice: "caro", costoMicroUsd: 150 }), tope });
    expect(r1.cortada).toBe("tope_llamada");
    expect(r1.turnos.length).toBeLessThan(EJ1!.turnos.length + 1);
    const r2 = await correr({ guion: () => ({ dice: "barato", costoMicroUsd: 10 }), tope });
    expect(r2.cortada).toBeNull();
    expect(tope.gastoUsd).toBeGreaterThan(0.00015);
  });

  it("no acepta topes invalidos ni un VOZ_CORTE_USD por encima del maximo del banco (25)", () => {
    for (const malo of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new TopeGasto(malo, 1)).toThrow(AbortoDeSeguridad);
    expect(() => new TopeGasto(1, 0)).toThrow(AbortoDeSeguridad);
    expect(corteDeEntorno({})).toBe(1.5);
    expect(corteDeEntorno({ VOZ_CORTE_USD: "10" })).toBe(10);
    expect(() => corteDeEntorno({ VOZ_CORTE_USD: "26" })).toThrow(AbortoDeSeguridad);
    expect(() => corteDeEntorno({ VOZ_CORTE_USD: "NaN" })).toThrow(AbortoDeSeguridad);
    expect(new TopeDeLlamada(1, 1).name).toBe("TopeDeLlamada");
  });
});

describe("aislamiento (guardas de #696)", () => {
  const pool = (host: string) => ({ options: { host }, query: async () => ({ rows: [] }) });
  const ok = () => ({ api: "http://127.0.0.1:8787", pool: pool("localhost"), metaSimulado: true, stop: async () => undefined });

  it("acepta un stack local con Meta simulado", async () => {
    await expect(exigirAislamiento(ok(), {})).resolves.toBeUndefined();
  });

  it("aborta y DETIENE el stack si la API, la base o el Meta no son locales/simulados", async () => {
    for (const malo of [
      { ...ok(), api: "https://api.ejemplo.com" },
      { ...ok(), pool: pool("db.remota.example") },
      { ...ok(), metaSimulado: false },
    ]) {
      let detenido = false;
      await expect(exigirAislamiento({ ...malo, stop: async () => { detenido = true; } }, {})).rejects.toBeInstanceOf(AbortoDeSeguridad);
      expect(detenido).toBe(true);
    }
  });

  it("aborta si una variable heredada apunta fuera de loopback", async () => {
    await expect(exigirAislamiento(ok(), { META_GRAPH_URL: "https://graph.ejemplo.com" })).rejects.toBeInstanceOf(AbortoDeSeguridad);
  });
});

describe("cliente simulado M0", () => {
  const todos = async (c: ClienteSimulado) => { const xs = []; for (let t = await c.siguiente(); t !== null; t = await c.siguiente()) xs.push(t); return xs; };
  const LINEA = "quiero trescientos cuarenta y cinco tacos, doce cincuenta, para Ana Prueba";
  const esc = { ...EJ1!, turnos: [LINEA, LINEA, LINEA, LINEA] };

  it("texto: la linea llega tal cual; stt-final: llega degradada y los cambios quedan registrados", async () => {
    const t = await todos(new ClienteSimulado(esc, { modo: "texto", rep: 1 }));
    expect(t.every((x) => x.tipo === "texto" && x.oido === LINEA && x.cambios.length === 0)).toBe(true);
    const s = await todos(new ClienteSimulado(esc, { modo: "stt-final", rep: 1, nivelRuido: 2 }));
    expect(s.some((x) => x.tipo === "stt-final" && x.oido !== LINEA && x.cambios.length > 0)).toBe(true);
  });

  it("pareado: misma (escenario, rep, semilla) = mismo ruido, sin importar cuantos turnos se consuman antes", async () => {
    const a = await todos(new ClienteSimulado(esc, { modo: "stt-final", rep: 2 }));
    const b = await todos(new ClienteSimulado(esc, { modo: "stt-final", rep: 2 }));
    expect(a).toEqual(b);
    const c = await todos(new ClienteSimulado(esc, { modo: "stt-final", rep: 3 }));
    expect(c).not.toEqual(a);
  });

  it("los eventos pasan como eventos, interrumpe entrega la linea con la marca y cortada la deja a media frase", async () => {
    const e = { ...EJ1!, turnos: ["hola", { k: "ruido" as const }, { k: "interrumpe" as const, dice: "no, espere un momento" }, { k: "cortada" as const, dice: "quiero tres tacos de pastor para recoger" }] };
    const t = await todos(new ClienteSimulado(e, { modo: "stt-final", rep: 1 }));
    expect(t[1]).toEqual({ tipo: "evento", evento: { k: "ruido" } });
    expect(t[2]).toMatchObject({ interrumpe: true });
    expect(t[3]!.tipo === "evento" ? "" : t[3]!.oido.endsWith("...")).toBe(true);
  });

  it("acepta un generador inyectado (cliente adaptativo) sin llamar a ningun proveedor", async () => {
    const c = new ClienteSimulado(EJ1!, { modo: "texto", rep: 1, generador: async (ints) => `  ${ints[0]}  !  ` });
    const t = await c.siguiente();
    expect(t).toMatchObject({ dicho: `${EJ1!.turnos[0]} !` });
  });
});

describe("registro y adaptador falso", () => {
  it("solo hay el doble registrado; un id desconocido falla con mensaje claro; el preflight no necesita red ni llaves", async () => {
    expect(listarAdaptadores()).toEqual(["falso"]);
    expect(() => crearAdaptador("gemini-live:x")).toThrow(/desconocido/);
    expect(await crearAdaptador("falso").preflight()).toMatchObject({ ok: true });
  });
});

describe("esquema del corpus de voz y corpus privado", () => {
  it("los 3 escenarios de ejemplo del repo son validos", () => {
    expect(cargarEjemplos().map((e) => e.id)).toEqual(["EJ-001", "EJ-002", "EJ-003"]);
  });

  it("el validador rechaza formas rotas sin citar el contenido", () => {
    const base = JSON.parse(JSON.stringify(EJ2)) as Record<string, unknown>;
    expect(validarEscenario(base)).toEqual([]);
    expect(validarEscenario({ ...base, sucursal: "T9" })).toEqual(["sucursal: debe ser T1, T3 o T7"]);
    expect(validarEscenario({ ...base, reloj: "NUNCA" })).toEqual(["reloj: clave desconocida"]);
    expect(validarEscenario({ ...base, turnos: [] })[0]).toMatch(/turnos/);
    expect(validarEscenario({ ...base, checks: [{ t: "inventado" }] })).toEqual(["checks[0]: tipo desconocido"]);
    expect(validarEscenario({ ...base, checks: [{ t: "texto", re: "(" }] })).toEqual(["checks[0]: re no compila"]);
    expect(validarEscenario("no es objeto")).toEqual(["no es un objeto"]);
    const { errores } = validarLista([base, base]);
    expect(errores[0]!.problemas).toEqual(["id repetido"]);
  });

  it("el corpus privado se exige por variable de entorno, con ruta absoluta y FUERA del repo", () => {
    expect(() => rutaCorpusPrivado({}, RAIZ)).toThrow(/PM_CORPUS_SIM/);
    expect(() => rutaCorpusPrivado({ PM_CORPUS_SIM: "relativa/ruta" }, RAIZ)).toThrow(/absoluta/);
    expect(() => rutaCorpusPrivado({ PM_CORPUS_SIM: join(RAIZ, "scripts", "voz-banco") }, RAIZ)).toThrow(/DENTRO del repo/);
    const fuera = mkdtempSync(join(tmpdir(), "corpus-"));
    expect(() => rutaCorpusPrivado({ PM_CORPUS_SIM: fuera }, RAIZ)).toThrow(/escenarios-voz\.json/);
    writeFileSync(join(fuera, "escenarios-voz.json"), JSON.stringify({ escenarios: [EJ1, { ...EJ2, extra: 1 }, { id: "x" }] }));
    const { validos, errores } = cargarCorpusPrivado({ PM_CORPUS_SIM: fuera }, RAIZ);
    expect(validos).toHaveLength(2);
    expect(errores).toHaveLength(1);
    expect(JSON.stringify(errores)).not.toContain(EJ1!.titulo);
  });

  it("el repo NO contiene texto del corpus privado (ids SIM-V-*, ni el archivo)", () => {
    const marca = ["SIM", "V", "0"].join("-");
    const recorre = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? recorre(p) : [p]; });
    const archivos = [...recorre(join(RAIZ, "scripts", "voz-banco")), ...recorre(join(RAIZ, "scripts", "voz-medicion-real"))];
    expect(archivos.some((a) => a.endsWith("escenarios-voz.json"))).toBe(false);
    for (const a of archivos) expect(readFileSync(a, "utf8"), a).not.toContain(marca);
  });

  // Solo si el corpus privado esta disponible en esta maquina (CI: se omite). Lo valida sin copiarlo ni imprimirlo.
  it.skipIf(!process.env["PM_CORPUS_SIM"])("el corpus privado completo cumple el esquema (82 escenarios)", () => {
    const { validos, errores } = cargarCorpusPrivado(process.env, RAIZ);
    expect(errores.map((e) => `${e.id}: ${e.problemas.join("; ")}`)).toEqual([]);
    expect(validos).toHaveLength(82);
  });
});


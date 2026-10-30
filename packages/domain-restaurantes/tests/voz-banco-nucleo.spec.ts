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
import { cargarCorpusPrivado, cargarEjemplos, categoriasPii, rutaCorpusPrivado, validarEscenario, validarLista } from "../../../scripts/voz-banco/corpus.ts";
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
});


describe("topes: fallan cerrado ante costos ausentes o tardios (P1-4, P1-5)", () => {
  it("un adaptador que NUNCA llama h.costo no se toma por gratis: la corrida corta", async () => {
    const tope = new TopeGasto(5, 1);
    await expect(correr({ guion: () => ({ dice: "hola", sinReporteDeCosto: true }), tope })).rejects.toBeInstanceOf(TopeExcedido);
  });

  it("un reporte de costo EXPLICITO en 0 si es valido (el falso lo manda por omision)", async () => {
    const tope = new TopeGasto(5, 1);
    await expect(correr({ tope })).resolves.toMatchObject({ cortada: null });
    expect(tope.gastoUsd).toBe(0);
  });

  it("si el adaptador dice haber gastado mas de lo que reporto por h.costo, el gasto pasa a NaN y corta", async () => {
    const base = crearAdaptadorFalso(() => ({ dice: "hola" }));
    const mentiroso = { ...base, costoMicroUsd: () => ({ total: 5_000, real: false, porComponente: {} }) };
    // el total que declara el adaptador cambia durante la llamada (gasto no reportado)
    let n = 0;
    const adaptador = { ...mentiroso, costoMicroUsd: () => ({ total: (n += 1) === 1 ? 0 : 5_000, real: false, porComponente: {} }) };
    await expect(
      correrLlamada({ adaptador, escenario: EJ1!, rep: 1, modoCliente: "texto", modoCompuerta: "on", tope: new TopeGasto(5, 1), apertura: APERTURA, ejecutor: servidor().ejecutar }),
    ).rejects.toBeInstanceOf(TopeExcedido);
  });

  it("un costo tardio tras cerrarLlamada() se pliega al acumulado al iniciar la siguiente (no se pierde)", () => {
    const t = new TopeGasto(5, 1);
    t.iniciarLlamada();
    t.registrarMicroUsd(100);
    t.cerrarLlamada();
    t.registrarMicroUsd(50); // llega tarde
    expect(t.gastoUsd).toBeCloseTo(150e-6, 10);
    t.iniciarLlamada();
    expect(t.gastoUsd).toBeCloseTo(150e-6, 10);
    t.registrarMicroUsd(25);
    t.cerrarLlamada();
    expect(t.gastoUsd).toBeCloseTo(175e-6, 10);
  });

  it("un costo tardio NaN tras cerrar tambien se arrastra y corta, aunque se inicie otra llamada", () => {
    const t = new TopeGasto(5, 1);
    t.iniciarLlamada();
    t.cerrarLlamada();
    t.registrarMicroUsd(Number.NaN);
    expect(() => t.verificar()).toThrow(TopeExcedido);
    t.iniciarLlamada();
    expect(() => t.verificar()).toThrow(TopeExcedido);
  });

  it("un TopeGasto no admite llamadas concurrentes y una falla no lo deja «en curso»", async () => {
    const t = new TopeGasto(5, 1);
    t.iniciarLlamada();
    expect(() => t.iniciarLlamada()).toThrow(AbortoDeSeguridad);
    t.cerrarLlamada();
    const roto = { ...crearAdaptadorFalso(), crearAbrirSesion: () => async () => { throw new Error("no abre"); } };
    await expect(correrLlamada({ adaptador: roto, escenario: EJ1!, rep: 1, modoCliente: "texto", modoCompuerta: "on", tope: t, apertura: APERTURA, ejecutor: servidor().ejecutar })).rejects.toThrow("no abre");
    expect(() => t.iniciarLlamada()).not.toThrow();
  });

  it("el constructor tampoco se salta el maximo del banco", () => {
    expect(() => new TopeGasto(30, 1)).toThrow(AbortoDeSeguridad);
    expect(() => new TopeGasto(30, 1, 50)).not.toThrow();
    expect(() => new TopeGasto(1, 1, Number.NaN)).toThrow(AbortoDeSeguridad);
  });
});

describe("aislamiento obligatorio con adaptadores reales (P2)", () => {
  const pool = (host: string) => ({ options: { host }, query: async () => ({ rows: [] }) });
  const stack = (extra: Record<string, unknown> = {}) => ({ api: "http://127.0.0.1:8787", pool: pool("localhost"), metaSimulado: true, stop: async () => undefined, ...extra });
  function realFalso() {
    const abiertas = { n: 0 };
    const base = crearAdaptadorFalso();
    const adaptador = { ...base, id: "gemini-live:prueba", crearAbrirSesion: (c: Parameters<typeof base.crearAbrirSesion>[0]) => { abiertas.n += 1; return base.crearAbrirSesion(c); } };
    return { adaptador, abiertas };
  }
  const opciones = (adaptador: ReturnType<typeof realFalso>["adaptador"], extra: Record<string, unknown> = {}) => ({
    adaptador, escenario: EJ1!, rep: 1, modoCliente: "texto" as const, modoCompuerta: "on" as const, tope: new TopeGasto(5, 1), apertura: APERTURA, ejecutor: servidor().ejecutar, ...extra,
  });

  it("sin `aislamiento` un adaptador distinto del falso NO abre sesion", async () => {
    const { adaptador, abiertas } = realFalso();
    await expect(correrLlamada(opciones(adaptador))).rejects.toBeInstanceOf(AbortoDeSeguridad);
    expect(abiertas.n).toBe(0);
  });

  it("con un stack no local aborta, detiene el stack y no abre sesion", async () => {
    const { adaptador, abiertas } = realFalso();
    let detenido = false;
    await expect(correrLlamada(opciones(adaptador, { aislamiento: { stack: stack({ api: "https://api.ejemplo.com", stop: async () => { detenido = true; } }), env: {} } }))).rejects.toBeInstanceOf(AbortoDeSeguridad);
    expect(detenido).toBe(true);
    expect(abiertas.n).toBe(0);
  });

  it("con aislamiento local verificado corre", async () => {
    const { adaptador, abiertas } = realFalso();
    await expect(correrLlamada(opciones(adaptador, { aislamiento: { stack: stack(), env: {} } }))).resolves.toMatchObject({ arquitectura: "gemini-live:prueba" });
    expect(abiertas.n).toBe(1);
  });

  it("el doble falso corre sin aislamiento (no toca red ni llaves)", async () => {
    await expect(correr({})).resolves.toBeDefined();
  });
});

describe("resultado de la llamada y corpus (P1-6, P2)", () => {
  it("el esquema ya trae los campos de latencia L1 y de pedido esperado/correcto en BD (null = sin medir)", async () => {
    const r = await correr({});
    expect(r).toMatchObject({ latenciaPrimerAudioMs: null, pedidoEsperado: null, pedidoFinalCorrectoEnBd: null });
  });

  describe("PII sintetica: el validador la rechaza SIN citar el texto", () => {
    const base = JSON.parse(JSON.stringify(EJ2)) as Record<string, unknown>;
    const con = (campo: string, valor: unknown) => ({ ...base, [campo]: valor });
    const malos: [string, string][] = [
      ["telefono", "mi numero es 9991234567 gracias"],
      ["telefono", "llamame al 999 123 4567"],
      ["telefono", "999-123-45-67"],
      ["telefono", "(999) 123-4567"],
      ["telefono", "+52 999 123 4567"],
      ["telefono", "521 999 123 4567"],
      ["telefono", "+5219991234567"],
      ["correo", "es ana.perez@ejemplo.com ok"],
      ["correo", "ana perez arroba ejemplo punto com"],
      ["credencial", "https://usuario:clave123@host.ejemplo/ruta"],
      ["credencial", "https://api.ejemplo.com/v1?api_key=abcdef123"],
      ["credencial", "sk-abcdefghijklmnop1234"],
      ["tarjeta", "mi tarjeta 4111 1111 1111 1111"],
      ["tarjeta", "4111111111111111"],
    ];

    it.each(malos)("detecta %s: %s", (cat, texto) => {
      expect(categoriasPii(texto)).toContain(cat);
      for (const campo of ["titulo", "fuente", "debe", "noDebe"]) {
        const e = validarEscenario(con(campo, texto));
        expect(e.some((m) => m.startsWith(`${campo}: contiene ${cat}`)), `${campo}`).toBe(true);
        expect(e.join(" ")).not.toContain(texto);
      }
      const e2 = validarEscenario(con("turnos", ["hola", texto]));
      expect(e2).toContain(`turnos[1]: contiene ${cat} (el corpus debe ser sintetico)`);
      expect(e2.join(" ")).not.toContain(texto);
      const e3 = validarEscenario(con("turnos", [{ k: "interrumpe", dice: texto }]));
      expect(e3.some((m) => m.includes(`contiene ${cat}`))).toBe(true);
    });

    it.each(["quiero 328 pesos de tacos", "doce cincuenta cada uno", "son 3 ordenes de 6 piezas, total 1250 pesos", "a las 14:30 del 13 de marzo", "codigo 12345", "folio 20260310 numero 4412"])("no marca texto sin PII: %s", (t) => {
      expect(categoriasPii(t)).toEqual([]);
    });

    it("los ejemplos del repo no tienen PII", () => {
      for (const e of cargarEjemplos()) expect(validarEscenario(e)).toEqual([]);
    });
  });

  it("un id invalido no sale tal cual en los errores", () => {
    const base = JSON.parse(JSON.stringify(EJ2)) as Record<string, unknown>;
    const { errores } = validarLista([{ ...base, id: "9991234567 ana@ejemplo.com texto del corpus" }]);
    expect(errores[0]!.id).toBe("(id invalido)");
    expect(JSON.stringify(errores)).not.toContain("ana@ejemplo.com");
  });

  it("un JSON ilegible del corpus privado da un mensaje fijo, sin fragmento del archivo", () => {
    const fuera = mkdtempSync(join(tmpdir(), "corpus-"));
    writeFileSync(join(fuera, "escenarios-voz.json"), '{"escenarios": [ {"titulo": "FRAGMENTO_SECRETO_DEL_CORPUS" ');
    let mensaje = "";
    try { cargarCorpusPrivado({ PM_CORPUS_SIM: fuera }, RAIZ); } catch (x) { mensaje = (x as Error).message; expect(x).toBeInstanceOf(AbortoDeSeguridad); }
    expect(mensaje).toMatch(/JSON ilegible/);
    expect(mensaje).not.toContain("FRAGMENTO_SECRETO");
  });
});

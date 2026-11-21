// Prueba DIFERENCIAL de la compuerta del banco contra la sesion REAL de la cascada v2 (`crearProveedorCascadaV2`, con STT/TTS/LLM falsos): el mismo guion de eventos se corre contra la
// sesion de produccion y contra el decorador del banco (`CompuertaPedidos`), y se comparan las decisiones de cada herramienta, una por una. Si la sesion v2 cambia como alimenta el
// estado (afirmacion, total oido, huella, interrupciones), esta prueba rompe en vez de depender de que alguien relea ~60 lineas de replica.
// Los guiones incluyen el flujo REAL de produccion: cotizar + confirmar en T1 y SOLO crear tras el «si» de T2.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "../../voice-core/src/index.ts";
import type { AperturaLlamada } from "../../voice-core/src/index.ts";
import { SttFalso, TtsFalso, llmFalso, manejadoresFalsos, turnoMicrotareas } from "../../voice-core/tests/cascada-v2/dobles.ts";
import type { TurnoLlm } from "../../voice-core/tests/cascada-v2/dobles.ts";
import { CompuertaPedidos, REGLA_PEDIDOS_PM } from "../../../scripts/voz-banco/compuerta-pedidos.ts";
import { TrazaHerramientas } from "../../../scripts/voz-banco/traza-herramientas.ts";

const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [], vocabulario: [] };
const HASH = (n: string) => n.padEnd(32, "0");

interface Herr {
  readonly n: "buscar_producto" | "cotizar_pedido" | "confirmar_resumen" | "crear_pedido";
  readonly args?: Record<string, unknown>;
}
interface Vuelta {
  readonly dice?: string;
  readonly herr?: readonly Herr[];
  /** Esta vuelta se queda colgada (el LLM sigue «generando») hasta que el cliente interrumpe en el turno siguiente. */
  readonly cuelga?: true;
}
interface Turno {
  readonly cliente: string;
  readonly vueltas: readonly Vuelta[];
  /** El cliente le habla ENCIMA al agente (barge-in): el audio del turno anterior aun suena. */
  readonly interrumpe?: true;
}
interface Guion {
  readonly nombre: string;
  /** Cotizaciones en el orden en que se piden: huella y total. */
  readonly cotizaciones: readonly { hash: string; total: number }[];
  readonly turnos: readonly Turno[];
}

const q: Herr = { n: "cotizar_pedido" };
const c: Herr = { n: "confirmar_resumen" };
const p: Herr = { n: "crear_pedido" };
const LEE = "Son tres tacos de pastor, el total es 328 pesos. ¿Confirma?";
const T1 = (...vueltas: Vuelta[]): Turno => ({ cliente: "quiero tres tacos de pastor", vueltas });

const GUIONES: readonly Guion[] = [
  { nombre: "01 camino feliz: cotiza y confirma en T1, lee el total, «si» y crea en T2", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: LEE }), { cliente: "sí", vueltas: [{ herr: [p] }, { dice: "Listo, quedó registrado." }] }] },
  { nombre: "02 el agente nunca dijo el total", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: "Anotado, ¿confirma?" }), { cliente: "sí", vueltas: [{ herr: [p] }, { dice: "Pedido hecho." }] }] },
  { nombre: "03 dijo un total distinto al cotizado", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: "Son 280 pesos en total. ¿Confirma?" }), { cliente: "sí", vueltas: [{ herr: [p] }, { dice: "Hecho." }] }] },
  { nombre: "04 el cliente pregunta en vez de afirmar", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "y cuánto tardan en llegar", vueltas: [{ herr: [c, p] }, { dice: "Unos veinte minutos." }] }] },
  { nombre: "05 rechazo («cancela») y un «si» despues", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "mejor no, cancela", vueltas: [{ dice: "Listo, cancelado el pedido de 328 pesos." }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "06 relectura del total tras una pregunta intermedia reabre la compuerta", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "y llevan cebolla", vueltas: [{ dice: "Sí, llevan cebolla. El total sigue en 328 pesos, ¿confirma?" }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "07 pregunta intermedia SIN releer el total cierra la compuerta", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "y llevan cebolla", vueltas: [{ dice: "Sí, llevan cebolla." }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "08 huella nueva en el turno del «si» (resumen que el cliente nunca oyo)", cotizaciones: [{ hash: "h1", total: 328 }, { hash: "h2", total: 310 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "sí", vueltas: [{ herr: [q, c, p] }, { dice: "Hecho." }] }] },
  { nombre: "09 re-cotizar el MISMO carrito en el turno del «si» conserva la huella", cotizaciones: [{ hash: "h1", total: 328 }, { hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "sí", vueltas: [{ herr: [q, c, p] }, { dice: "Hecho." }] }] },
  { nombre: "10 cotizar, confirmar y crear en el mismo turno", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c, p] }, { dice: LEE })] },
  { nombre: "11 barge-in sobre la lectura (el audio aun suena) y luego «si»", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "sí", interrumpe: true, vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "12 barge-in a media generacion (el LLM sigue escribiendo) y luego «si»", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q] }, { cuelga: true }), { cliente: "sí", interrumpe: true, vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "13 crear con un quote_hash que no es el que el cliente oyo", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: LEE }), { cliente: "sí", vueltas: [{ herr: [{ n: "crear_pedido", args: { quote_hash: HASH("hviejo") } }] }, { dice: "Hecho." }] }] },
  { nombre: "14 «si» ambiguo con una peticion nueva", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: LEE }), { cliente: "mmm sí pero con doble queso", vueltas: [{ herr: [p] }, { dice: "Anotado el doble queso." }] }] },
  { nombre: "15 total nuevo leido tras cambiar el pedido: el «si» siguiente vale", cotizaciones: [{ hash: "h1", total: 328 }, { hash: "h2", total: 436 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "cámbialo a cuatro tacos", vueltas: [{ herr: [q] }, { dice: "Ahora son cuatro tacos, el total es 436 pesos. ¿Confirma?" }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "16 total VIEJO leido tras cambiar el pedido: no vale", cotizaciones: [{ hash: "h1", total: 328 }, { hash: "h2", total: 436 }], turnos: [T1({ herr: [q] }, { dice: LEE }), { cliente: "cámbialo a cuatro tacos", vueltas: [{ herr: [q] }, { dice: "Son cuatro tacos, el total es 328 pesos. ¿Confirma?" }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Hecho." }] }] },
  { nombre: "17 un segundo «si» no crea un segundo pedido", cotizaciones: [{ hash: "h1", total: 328 }], turnos: [T1({ herr: [q, c] }, { dice: LEE }), { cliente: "sí", vueltas: [{ herr: [p] }, { dice: "Listo." }] }, { cliente: "sí", vueltas: [{ herr: [c, p] }, { dice: "Ya quedó." }] }] },
];

type Decision = readonly [id: string, resultado: string];
interface Corrida {
  readonly decisiones: Decision[];
  readonly pedidos: number;
  readonly alServidor: string[];
}

/** Servidor falso compartido por las dos corridas: mismas huellas y totales, y cuenta lo que de verdad llega a ejecutarse. */
function servidor(g: Guion) {
  const s = { pedidos: 0, cot: 0, alServidor: [] as string[] };
  const ejecutar = async (nombre: string): Promise<unknown> => {
    s.alServidor.push(nombre);
    if (nombre === "cotizar_pedido") {
      const x = g.cotizaciones[Math.min(s.cot, g.cotizaciones.length - 1)]!;
      s.cot += 1;
      return { quote: { total: x.total }, quote_hash: HASH(x.hash) };
    }
    if (nombre === "crear_pedido") { s.pedidos += 1; return { order: { id: `o${s.pedidos}` } }; }
    return { ok: true };
  };
  return { s, ejecutar };
}

const clasifica = (salida: unknown): string => {
  if (salida && typeof salida === "object" && "error" in salida) return String((salida as { error: unknown }).error);
  return "ok";
};
const idDe = (t: number, v: number, i: number): string => `t${t}v${v}h${i}`;
const conHash = (h: Herr): Record<string, unknown> => ({ ...(h.args ?? {}) });

/** Corre el guion contra la sesion REAL de la cascada v2. */
async function contraProduccion(g: Guion): Promise<Corrida> {
  const srv = servidor(g);
  let reloj = 1_700_000_000_000;
  // Un TurnoLlm por vuelta, en el orden en que la sesion los pide.
  const pasos: TurnoLlm[] = [];
  g.turnos.forEach((t, ti) => t.vueltas.forEach((v, vi) => {
    pasos.push(async (pet, dice) => {
      if (v.cuelga) {
        await new Promise<void>((_ok, mal) => pet.senal?.addEventListener("abort", () => mal(new Error("abortado"))));
      }
      if (v.dice) dice(v.dice);
      return { texto: v.dice ?? "", toolCalls: (v.herr ?? []).map((h, i) => ({ id: idDe(ti, vi, i), nombre: h.n, argsJson: JSON.stringify(conHash(h)) })) };
    });
  }));
  const llm = llmFalso(pasos);
  const stt = new SttFalso();
  const m = manejadoresFalsos({ ejecutarTool: (l) => srv.ejecutar(l.nombre) });
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts: new TtsFalso(), ahora: () => reloj, confirmacionAntesDeCrear: REGLA_PEDIDOS_PM });
  await prov.abrirSesion(APERTURA, m.h);
  for (const [i, t] of g.turnos.entries()) {
    if (!t.interrumpe) reloj += 20_000; // el audio del turno anterior ya termino de sonar
    stt.eventos!.turnoFinal(t.cliente);
    if (g.turnos[i]!.vueltas.some((v) => v.cuelga)) await turnoMicrotareas(80);
    else await prov.inactivo();
  }
  await prov.inactivo();
  const ultima = llm.peticiones.at(-1)!;
  const tools = new Map(ultima.mensajes.filter((x) => x.role === "tool").map((x) => [(x as { toolCallId: string }).toolCallId, clasifica(JSON.parse((x as { content: string }).content))] as const));
  const decisiones: Decision[] = [];
  g.turnos.forEach((t, ti) => t.vueltas.forEach((v, vi) => (v.herr ?? []).forEach((_h, i) => { const id = idDe(ti, vi, i); decisiones.push([id, tools.get(id) ?? "sin_respuesta"]); })));
  return { decisiones, pedidos: srv.s.pedidos, alServidor: srv.s.alServidor };
}

/** Corre el MISMO guion contra el decorador del banco, alimentandolo como lo hace el corredor. */
async function contraBanco(g: Guion, modo: "on" | "off" = "on"): Promise<Corrida & { traza: TrazaHerramientas }> {
  const srv = servidor(g);
  const comp = new CompuertaPedidos(modo);
  const traza = new TrazaHerramientas(undefined, comp);
  const ejecutar = traza.decorar(comp.decorar(async (l) => srv.ejecutar(l.nombre)));
  const decisiones: Decision[] = [];
  for (const [ti, t] of g.turnos.entries()) {
    if (t.interrumpe) comp.alInterrumpir();
    traza.alTurnoCliente(t.cliente);
    comp.alTurnoCliente(t.cliente);
    let colgado = false;
    for (const [vi, v] of t.vueltas.entries()) {
      if (v.cuelga) { colgado = true; break; } // el LLM sigue escribiendo: nada se dice ni se ejecuta mas en este turno
      if (v.dice) comp.alAgenteDijo(v.dice);
      for (const [i, h] of (v.herr ?? []).entries()) {
        const salida = await ejecutar({ id: idDe(ti, vi, i), nombre: h.n, args: conHash(h) });
        decisiones.push([idDe(ti, vi, i), clasifica(salida)]);
      }
    }
    if (!colgado) comp.alAgenteTermino();
  }
  return { decisiones, pedidos: srv.s.pedidos, alServidor: srv.s.alServidor, traza };
}

describe("diferencial: el decorador del banco decide IGUAL que la sesion real de la cascada v2", () => {
  it("hay al menos 12 guiones, con rechazo, relectura, barge-in, huella nueva, «si» ambiguo y total viejo", () => {
    expect(GUIONES.length).toBeGreaterThanOrEqual(12);
    const nombres = GUIONES.map((g) => g.nombre).join(" | ");
    for (const clave of ["rechazo", "relectura", "barge-in", "huella nueva", "ambiguo", "VIEJO"]) expect(nombres).toContain(clave);
  });

  it.each(GUIONES.map((g) => [g.nombre, g] as const))("%s", async (_n, g) => {
    const prod = await contraProduccion(g);
    const banco = await contraBanco(g);
    expect(banco.decisiones).toEqual(prod.decisiones);
    expect(banco.pedidos).toBe(prod.pedidos);
    expect(banco.alServidor).toEqual(prod.alServidor);
    // En modo on ningun crear indebido llega a ejecutarse.
    expect(banco.traza.crearIndebidosEjecutados).toBe(0);
    // Mismo guion en modo off: todo `crear` que `on` bloqueo se cuenta como intento sin confirmar (misma regla, otra consecuencia).
    const off = await contraBanco(g, "off");
    const bloqueadosOn = banco.traza.registros.filter((x) => x.nombre === "crear_pedido" && x.bloqueadaPorCompuerta).length;
    expect(off.traza.intentosCrearSinConfirmar).toBeGreaterThanOrEqual(bloqueadosOn);
    expect(off.traza.crearIndebidosEjecutados).toBeGreaterThanOrEqual(bloqueadosOn > 0 ? 1 : 0);
  });

  it("sanidad del arnes: el camino feliz crea UN pedido y los guiones bloqueados no crean ninguno (la comparacion no es vacia)", async () => {
    expect((await contraProduccion(GUIONES[0]!)).pedidos).toBe(1);
    for (const i of [1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13]) expect((await contraProduccion(GUIONES[i]!)).pedidos, GUIONES[i]!.nombre).toBe(0);
    expect((await contraProduccion(GUIONES[16]!)).pedidos).toBe(1);
  });
});

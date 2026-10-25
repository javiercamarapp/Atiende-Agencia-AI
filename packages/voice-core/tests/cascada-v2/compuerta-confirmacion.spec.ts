// Compuerta confirmar -> crear de la cascada v2 contra un SERVIDOR SIMULADO que imita el cierre de restaurantes (order-flow): `confirmar_resumen` solo procede en un turno
// POSTERIOR al de la cotizacion y `crear_pedido` exige estar confirmado. Defecto reproducido (VOZ-MEDICION-1): con la compuerta de produccion, el «si» del cliente llegaba,
// el modelo llamaba confirmar_resumen (armaba la espera) y crear_pedido quedaba bloqueado: pedia otro «si» y casi nunca se creaba el pedido.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "../../src/index.ts";
import type { AperturaLlamada } from "../../src/index.ts";
import { SttFalso, TtsFalso, llmFalso, manejadoresFalsos } from "./dobles.ts";
import type { TurnoLlm } from "./dobles.ts";

const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [], vocabulario: [] };
let reloj = 1_700_000_000_000;
const AHORA = () => reloj;
const REGLA = { confirmar: "confirmar_resumen", crear: "crear_pedido", cotizar: "cotizar_pedido" };

type Llamada = { id: string; nombre: string; argsJson: string };
const tc = (id: string, nombre: string): Llamada => ({ id, nombre, argsJson: "{}" });
/** Respuesta del modelo: texto opcional (se dice en voz alta) y herramientas. */
const paso = (texto: string, ...tools: Llamada[]): TurnoLlm => async (_p, dice) => {
  if (texto) dice(texto);
  return { texto, toolCalls: tools };
};

/** Servidor simulado del cierre. `laxo` = confirmar_resumen NO revisa el turno (prueba que la compuerta sola sostiene la garantia). */
function servidor(opts: { laxo?: boolean } = {}) {
  const s = { turno: 0, hashActual: "", quotedTurn: -1, confirmado: false, pedidos: 0, registro: [] as string[], cambioAlCotizar: false, n: 0 };
  const ejecutar = async (nombre: string): Promise<unknown> => {
    s.registro.push(nombre);
    if (nombre === "cotizar_pedido") {
      // Cotizar el MISMO carrito conserva huella y turno (como el servidor real); uno distinto es cotizacion nueva.
      if (s.cambioAlCotizar || s.hashActual === "") {
        s.n += 1;
        s.hashActual = `h${s.n}`.padEnd(32, "0");
        s.quotedTurn = s.turno;
        s.confirmado = false;
        s.cambioAlCotizar = false;
      }
      return { total: 328, quote_hash: s.hashActual };
    }
    if (nombre === "confirmar_resumen") {
      if (s.hashActual === "") return { error: "sin_cotizacion" };
      if (!opts.laxo && s.quotedTurn === s.turno) return { error: "confirmacion_mismo_turno" };
      s.confirmado = true;
      return { confirmado: true, quote_hash: s.hashActual };
    }
    if (nombre === "crear_pedido") {
      if (!s.confirmado) return { error: "sin_confirmacion" };
      s.pedidos += 1;
      s.confirmado = false;
      s.hashActual = "";
      return { creado: true, order_id: `p${s.pedidos}` };
    }
    return { ok: true };
  };
  return { s, ejecutar };
}

async function armar(guion: TurnoLlm[], opts: { laxo?: boolean; regla?: typeof REGLA | { confirmar: string; crear: string } } = {}) {
  reloj = 1_700_000_000_000;
  const srv = servidor(opts.laxo === undefined ? {} : { laxo: opts.laxo });
  const llm = llmFalso(guion);
  const stt = new SttFalso();
  const tts = new TtsFalso();
  const m = manejadoresFalsos({ ejecutarTool: (l) => srv.ejecutar(l.nombre) });
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, ahora: AHORA, confirmacionAntesDeCrear: opts.regla ?? REGLA });
  const sesion = await prov.abrirSesion(APERTURA, m.h);
  /** `esperar` = el audio del agente ya termino de sonar cuando el cliente contesta (lo normal); falso = el cliente le habla encima. */
  const cliente = async (texto: string, esperar = true) => {
    if (esperar) reloj += 20_000;
    srv.s.turno += 1;
    stt.eventos!.turnoFinal(texto);
    await prov.inactivo();
  };
  const resultadosTool = (peticion: number) => (llm.peticiones[peticion]?.mensajes ?? []).filter((x) => x.role === "tool").map((x) => JSON.parse((x as { content: string }).content) as Record<string, unknown>);
  return { srv, llm, cliente, sesion, stt, resultadosTool, eventos: m.eventos };
}

const RESUMEN = "Son seis de bistec, a domicilio, en efectivo, trescientos veintiocho pesos. ¿Es correcto?";
const cotizaYLee = [paso("", tc("q", "cotizar_pedido")), paso(RESUMEN)];

describe("compuerta confirmar -> crear: un solo «si» crea el pedido", () => {
  it("«si» unico: confirmar_resumen y crear_pedido en la MISMA respuesta del turno del «si» -> UN pedido, sin pedir otro «si»", async () => {
    const { srv, cliente, llm } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Listo, su pedido quedó registrado.")]);
    await cliente("seis de bistec a domicilio");
    expect(srv.s.pedidos).toBe(0);
    await cliente("sí");
    expect(srv.s.pedidos).toBe(1);
    expect(srv.s.registro).toEqual(["cotizar_pedido", "confirmar_resumen", "crear_pedido"]);
    expect(llm.peticiones).toHaveLength(4);
  });

  it("«si» unico con confirmar y crear en vueltas SEPARADAS del mismo turno -> UN pedido", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen")), paso("", tc("p", "crear_pedido")), paso("Listo, quedó registrado.")]);
    await cliente("seis de bistec a domicilio");
    await cliente("sí");
    expect(srv.s.pedidos).toBe(1);
  });

  it("con ruido de STT («eh... si, si, este... si») sigue siendo UN pedido (la compuerta no interpreta el texto)", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Listo.")]);
    await cliente("eh seis de bistec a domicilio este en efectivo");
    await cliente("eh... si, si, este... si");
    expect(srv.s.pedidos).toBe(1);
  });

  it("el modelo que re-cotiza el MISMO carrito en el turno del «si» no obliga a un segundo «si» (huella conservada)", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("q2", "cotizar_pedido"), tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Listo.")]);
    await cliente("seis de bistec a domicilio");
    await cliente("sí");
    expect(srv.s.pedidos).toBe(1);
  });
});

describe("compuerta confirmar -> crear: sin «si» no hay pedido", () => {
  it("el modelo cotiza, confirma y crea en el MISMO turno del cliente (sin «si»): ningun pedido, y el mensaje de la compuerta lo guia a pedir UN solo «si»", async () => {
    const { srv, cliente, resultadosTool } = await armar(
      [paso("", tc("q", "cotizar_pedido"), tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso(RESUMEN)],
      {},
    );
    await cliente("seis de bistec a domicilio");
    expect(srv.s.pedidos).toBe(0);
    const bloqueo = resultadosTool(1).find((r) => r["error"] === "espera_confirmacion_del_cliente");
    expect(bloqueo).toBeDefined();
    expect(String(bloqueo!["mensaje"])).toMatch(/UN solo «si»/);
    expect(String(bloqueo!["mensaje"])).toMatch(/cuando el cliente diga que si, llame crear_pedido/i);
  });

  it("aunque el servidor fuera laxo con confirmar_resumen, la compuerta sola impide crear en el turno de la cotizacion", async () => {
    const { srv, cliente } = await armar([paso("", tc("q", "cotizar_pedido"), tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso(RESUMEN)], { laxo: true });
    await cliente("seis de bistec a domicilio");
    expect(srv.s.pedidos).toBe(0);
  });

  it("«si pero...»: el modelo re-cotiza con el cambio y trata de crear -> NO se crea (resumen nuevo sin leer); tras leerlo y un «si» nuevo, si", async () => {
    const guion = [
      ...cotizaYLee,
      async (_p: unknown, dice: (d: string) => void) => {
        srv.s.cambioAlCotizar = true; // el cliente cambio el pedido: la cotizacion nueva tiene otra huella
        void dice;
        return { texto: "", toolCalls: [tc("q2", "cotizar_pedido"), tc("c", "confirmar_resumen"), tc("p", "crear_pedido")] };
      },
      paso("Con ese cambio son trescientos diez pesos. ¿Es correcto?"),
      paso("", tc("c2", "confirmar_resumen"), tc("p2", "crear_pedido")),
      paso("Listo."),
    ] as TurnoLlm[];
    const { srv, cliente } = await armar(guion, { laxo: true });
    await cliente("seis de bistec a domicilio");
    await cliente("sí pero sin cebolla");
    expect(srv.s.pedidos).toBe(0);
    await cliente("sí");
    expect(srv.s.pedidos).toBe(1);
  });

  it("si confirmar_resumen es RECHAZADO por el servidor en el turno del «si», crear_pedido no corre", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Un momento, ¿es correcto el resumen?")]);
    srv.s.n = 0;
    await cliente("seis de bistec a domicilio");
    srv.s.quotedTurn = 2; // el servidor considera que la cotizacion es de este turno: rechaza la confirmacion
    await cliente("sí");
    expect(srv.s.pedidos).toBe(0);
  });

  it("si el cliente le habla encima a la lectura del resumen («si» antes de que termine), no cuenta como respuesta al resumen: no se crea hasta leerlo de nuevo", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso(RESUMEN)]);
    await cliente("seis de bistec a domicilio");
    await cliente("sí", false); // le habla ENCIMA al resumen: el audio aun suena (reloj fijo)
    expect(srv.s.pedidos).toBe(0);
  });
});

describe("compuerta confirmar -> crear: idempotencia", () => {
  it("doble «si»: el segundo no crea otro pedido (el resumen ya se uso; la compuerta lo frena antes que el servidor)", async () => {
    const { srv, cliente } = await armar([
      ...cotizaYLee,
      paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")),
      paso("Listo, quedó registrado."),
      paso("", tc("c2", "confirmar_resumen"), tc("p2", "crear_pedido")),
      paso("Su pedido ya quedó registrado."),
    ]);
    await cliente("seis de bistec a domicilio");
    await cliente("sí");
    await cliente("sí, sí");
    expect(srv.s.pedidos).toBe(1);
  });

  it("sin `cotizar` en la regla se conserva el comportamiento anterior (crear espera a otro turno del cliente)", async () => {
    const { srv, cliente } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("¿Le parece bien?")], { regla: { confirmar: "confirmar_resumen", crear: "crear_pedido" } });
    await cliente("seis de bistec a domicilio");
    await cliente("sí");
    expect(srv.s.pedidos).toBe(0);
  });
});

describe("el modelo guionado como el de produccion (VOZ-MEDICION-1)", () => {
  it("reproduccion del defecto: «si» -> confirmar -> crear (bloqueado) -> el modelo pide otro «si»: con el arreglo YA no ocurre", async () => {
    const { srv, cliente, eventos } = await armar([...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Listo, su pedido quedó registrado.")]);
    await cliente("seis de bistec a domicilio");
    await cliente("sí");
    expect(srv.s.pedidos).toBe(1);
    expect(eventos.filter((e) => e.startsWith("agente:")).some((e) => /otro|de nuevo|confirm.*otra vez/i.test(e))).toBe(false);
  });
});

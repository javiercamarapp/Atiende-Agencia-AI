// Cierre honesto de la cascada v2 (E2E LiveKit del 6/7-nov-2026):
//   - tras el «si» al resumen leido, el agente ESCALABA (falla_sistema) sin haber creado el pedido;
//   - decia «queda registrado» antes de que crear_pedido respondiera (o sin llamarlo).
// Reglas: con la compuerta abierta (resumen leido + afirmacion pura) la escalacion no corre: se fuerza confirmar/crear. Una escalacion por «falla_sistema» justo despues de
// que la compuerta frenara crear_pedido (no es falla: el cliente no ha dicho «si») tampoco corre. Y una frase que afirma el registro no se dice hasta que crear_pedido tuvo exito.
import { describe, expect, it } from "vitest";
import { crearProveedorCascadaV2 } from "../../src/index.ts";
import type { AperturaLlamada } from "../../src/index.ts";
import { SttFalso, TtsFalso, llmFalso, manejadoresFalsos } from "./dobles.ts";
import type { TurnoLlm } from "./dobles.ts";

const APERTURA: AperturaLlamada = { instruccion: "Eres el agente.", voiceId: "Kore", herramientas: [], vocabulario: [] };
/** Clasificador de prueba (en produccion el worker pasa `afirmaPedidoRegistrado` de restaurantes). */
const afirmaRegistro = (f: string): boolean => /\b(qued[oó]|queda|est[aá]) (ya )?(registrado|confirmado)\b/i.test(f) && !/\?/.test(f);
const REGLA = { confirmar: "confirmar_resumen", crear: "crear_pedido", cotizar: "cotizar_pedido", escalar: "escalar_a_humano", afirmaRegistro };

type Llamada = { id: string; nombre: string; argsJson: string };
const tc = (id: string, nombre: string, args: Record<string, unknown> = {}): Llamada => ({ id, nombre, argsJson: JSON.stringify(args) });
const paso = (texto: string, ...tools: Llamada[]): TurnoLlm => async (_p, dice) => {
  if (texto) dice(texto);
  return { texto, toolCalls: tools };
};

let reloj = 1_700_000_000_000;
function servidor() {
  const s = { turno: 0, hash: "", quotedTurn: -1, confirmado: false, pedidos: 0, escalaciones: 0, registro: [] as string[], frasesAlCrear: -1 };
  return s;
}

async function armar(guion: TurnoLlm[], o: { crearFalla?: boolean } = {}) {
  reloj = 1_700_000_000_000;
  const s = servidor();
  const tts = new TtsFalso();
  const ejecutar = async (nombre: string): Promise<unknown> => {
    s.registro.push(nombre);
    if (nombre === "cotizar_pedido") {
      if (s.hash === "") {
        s.hash = "h1".padEnd(32, "0");
        s.quotedTurn = s.turno;
      }
      return { quote: { total: 328 }, quote_hash: s.hash };
    }
    if (nombre === "confirmar_resumen") {
      if (s.quotedTurn === s.turno) return { error: "confirmacion_mismo_turno" };
      s.confirmado = true;
      return { confirmado: true, quote_hash: s.hash };
    }
    if (nombre === "crear_pedido") {
      s.frasesAlCrear = tts.frases.length;
      if (o.crearFalla) return { error: "falla_temporal" };
      if (!s.confirmado) return { error: "sin_confirmacion" };
      s.pedidos += 1;
      return { creado: true, order_id: "p1" };
    }
    if (nombre === "escalar_a_humano") {
      s.escalaciones += 1;
      return { ok: true, mensaje_al_cliente: "Ya avisé al gerente." };
    }
    return { ok: true };
  };
  const llm = llmFalso(guion);
  const stt = new SttFalso();
  const m = manejadoresFalsos({ ejecutarTool: (l) => ejecutar(l.nombre) });
  const logs: string[] = [];
  const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, ahora: () => reloj, confirmacionAntesDeCrear: REGLA, log: (l) => logs.push(l.evento) });
  await prov.abrirSesion(APERTURA, m.h);
  const cliente = async (texto: string) => {
    reloj += 20_000;
    s.turno += 1;
    stt.eventos!.turnoFinal(texto);
    await prov.inactivo();
  };
  return { s, tts, llm, cliente, logs };
}

const RESUMEN = "Son seis de bistec para recoger, en efectivo, trescientos veintiocho pesos. ¿Es correcto?";
const cotizaYLee = [paso("", tc("q", "cotizar_pedido", { payment_method: "efectivo" })), paso(RESUMEN)];

describe("tras el «si» al resumen leido, el pedido se crea antes de cualquier escalacion", () => {
  it("el modelo escala en vez de crear: la escalacion NO corre, se fuerzan confirmar y crear, y el pedido queda creado", async () => {
    const { s, cliente, logs } = await armar([
      ...cotizaYLee,
      paso("", tc("e", "escalar_a_humano", { motivo: "falla_sistema" })),
      paso("", tc("c", "confirmar_resumen")),
      paso("", tc("p", "crear_pedido")),
      paso("Listo, su pedido quedó registrado."),
    ]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.pedidos).toBe(1);
    expect(s.escalaciones).toBe(0);
    expect(s.registro).toEqual(["cotizar_pedido", "confirmar_resumen", "crear_pedido"]);
    expect(logs).toContain("v2_escalar_sin_crear");
  });

  it("si crear_pedido FALLA, la escalacion si corre (es la salida honesta)", async () => {
    const { s, cliente } = await armar(
      [...cotizaYLee, paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Permítame avisar al gerente.", tc("e", "escalar_a_humano", { motivo: "falla_sistema" })), paso("Ya avisé al gerente.")],
      { crearFalla: true },
    );
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.pedidos).toBe(0);
    expect(s.escalaciones).toBe(1);
  });

  it("la compuerta frena crear (el cliente no dijo un «si» limpio) y el modelo escala por falla_sistema: NO se escala (no es falla del sistema)", async () => {
    const { s, cliente, logs } = await armar([
      ...cotizaYLee,
      paso("", tc("p", "crear_pedido")),
      paso("", tc("e", "escalar_a_humano", { motivo: "falla_sistema" })),
      paso("¿Me confirma su pedido con un sí o un no?"),
    ]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("pues creo que sí pero agréguele una coca");
    expect(s.pedidos).toBe(0);
    expect(s.escalaciones).toBe(0);
    expect(logs).toContain("v2_escalar_sin_crear");
  });
});

describe("«queda registrado» solo despues de que crear_pedido tuvo exito", () => {
  it("la frase que afirma el registro, escrita ANTES de la herramienta en la misma respuesta, suena DESPUES de crear", async () => {
    const { s, tts, cliente } = await armar([...cotizaYLee, paso("Listo, su pedido quedó registrado.", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Lo esperamos en cuarenta minutos.")]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.pedidos).toBe(1);
    const antes = tts.frases.slice(0, s.frasesAlCrear).join(" ");
    expect(antes).not.toMatch(/registrado/);
    expect(tts.frases.join(" ")).toMatch(/quedó registrado/);
  });

  it("sin crear_pedido (o si falla) la frase de registro NUNCA suena ni queda en el historial", async () => {
    const { s, tts, cliente, llm, logs } = await armar([...cotizaYLee, paso("Su pedido quedó registrado. Gracias."), paso("Claro.")]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("pues creo que sí pero agréguele una coca");
    expect(s.pedidos).toBe(0);
    expect(tts.frases.join(" ")).not.toMatch(/registrado/);
    expect(logs).toContain("v2_registro_sin_crear");
    await cliente("¿cuánto es?");
    expect(JSON.stringify(llm.peticiones.at(-1)!.mensajes)).not.toMatch(/registrado/);
  });
});

describe("afirma el registro sin llamar crear, con el «si» al resumen leido", () => {
  it("se fuerza el registro real y la frase suena solo despues de crear", async () => {
    const { s, tts, cliente } = await armar([...cotizaYLee, paso("Listo, su pedido quedó registrado."), paso("", tc("c", "confirmar_resumen")), paso("", tc("p", "crear_pedido")), paso("Lo esperamos.")]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.pedidos).toBe(1);
    expect(tts.frases.slice(0, s.frasesAlCrear).join(" ")).not.toMatch(/registrado/);
    expect(tts.frases.join(" ")).toMatch(/registrado/);
  });
});

// Revision #752 (P1-3, P2-3, P2-4).
describe("revision #752: la retencion de «queda registrado» en voz", () => {
  // El clasificador de la vertical exige sujeto «pedido»; el de voz de la plataforma atrapa tambien «Listo, queda registrado.» y «ya quedó» con un pedido en juego.
  const SOLO_VERTICAL = { ...REGLA, afirmaRegistro: (f: string) => /\bpedido\b.*\bregistrado\b/i.test(f) };
  async function armarCon(regla: typeof REGLA, guion: TurnoLlm[], salidaCrear: unknown = { creado: true, order_id: "p1" }) {
    const tts = new TtsFalso();
    const registro: string[] = [];
    let frasesAlCrear = -1;
    let turno = 0;
    let quotedTurn = -1;
    let n = 0;
    const ejecutar = async (nombre: string): Promise<unknown> => {
      registro.push(nombre);
      if (nombre === "cotizar_pedido") {
        quotedTurn = turno;
        n += 1;
        return { quote: { total: 328 }, quote_hash: `h${n}`.padEnd(32, "0") };
      }
      if (nombre === "confirmar_resumen") return quotedTurn === turno ? { error: "confirmacion_mismo_turno" } : { confirmado: true };
      if (nombre === "crear_pedido") {
        frasesAlCrear = tts.frases.length;
        return salidaCrear;
      }
      return { ok: true };
    };
    const llm = llmFalso(guion);
    const stt = new SttFalso();
    const m = manejadoresFalsos({ ejecutarTool: (l) => ejecutar(l.nombre) });
    const logs: string[] = [];
    const prov = crearProveedorCascadaV2({ deepgramApiKey: null, llm, stt, tts, ahora: () => reloj, confirmacionAntesDeCrear: regla, log: (l) => logs.push(l.evento) });
    await prov.abrirSesion(APERTURA, m.h);
    const cliente = async (texto: string) => {
      reloj += 20_000;
      turno += 1;
      stt.eventos!.turnoFinal(texto);
      await prov.inactivo();
    };
    return { tts, llm, cliente, logs, registro, alCrear: () => frasesAlCrear };
  }

  it("«Listo, queda registrado.» (sin la palabra pedido, en su propia oracion) NO suena antes de crear_pedido", async () => {
    const t = await armarCon(SOLO_VERTICAL, [...cotizaYLee, paso("Perfecto. Listo, queda registrado.", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Lo esperamos.")]);
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("sí");
    expect(t.tts.frases.slice(0, t.alCrear()).join(" ")).not.toMatch(/queda registrado/);
  });

  it("«Ya quedó.» con un pedido en juego y sin crear: no suena ni queda en el historial", async () => {
    const t = await armarCon(SOLO_VERTICAL, [...cotizaYLee, paso("Ya quedó. Gracias."), paso("Claro.")]);
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("pues creo que sí pero agréguele una coca");
    expect(t.tts.frases.join(" ")).not.toMatch(/ya quedó/i);
    await t.cliente("¿cuánto es?");
    expect(JSON.stringify(t.llm.peticiones.at(-1)!.mensajes)).not.toMatch(/ya quedó/i);
  });

  it("lo retenido con markdown o salto de linea («**Listo**, su pedido quedó registrado.\\n») tampoco queda en el historial", async () => {
    const t = await armarCon(REGLA, [...cotizaYLee, paso("**Listo**, su pedido\nquedó registrado. Gracias."), paso("Claro.")]);
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("pues creo que sí pero agréguele una coca");
    await t.cliente("¿cuánto es?");
    expect(JSON.stringify(t.llm.peticiones.at(-1)!.mensajes)).not.toMatch(/registrado/);
  });

  it("si la vuelta tras crear trae su propio anuncio de registro, lo retenido NO se dice: el registro se anuncia una sola vez", async () => {
    const t = await armarCon(REGLA, [...cotizaYLee, paso("Listo, su pedido quedó registrado.", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("Su pedido quedó registrado con el folio 12. Lo esperamos.")]);
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("sí");
    expect(t.tts.frases.join(" ").match(/registrado/g)).toHaveLength(1);
    await t.cliente("gracias");
    const historial = JSON.stringify(t.llm.peticiones.at(-1)!.mensajes);
    expect(historial.match(/registrado/g)).toHaveLength(1);
  });

  it("pedido grande / por aprobar: «quedó registrado» NO se libera (la sucursal aun no lo aprueba) y no se pide otro «sí»", async () => {
    const t = await armarCon(REGLA, [...cotizaYLee, paso("Listo, su pedido quedó registrado.", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")), paso("")], { pedido_grande: true, por_aprobar: true, mensaje_al_cliente: "La sucursal lo confirma y le avisa." });
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("sí");
    expect(t.registro).toContain("crear_pedido");
    expect(t.tts.frases.join(" ")).not.toMatch(/registrado/);
    expect(t.tts.frases.join(" ")).not.toMatch(/me lo confirma con un sí/);
  });

  it("un SEGUNDO pedido en la misma llamada vuelve a retener «quedó registrado» hasta su propio crear_pedido", async () => {
    const t = await armarCon(REGLA, [
      ...cotizaYLee,
      paso("", tc("c", "confirmar_resumen"), tc("p", "crear_pedido")),
      paso("Listo, su pedido quedó registrado."),
      paso("", tc("q2", "cotizar_pedido", { payment_method: "efectivo" })),
      paso("Son dos de pastor, ochenta pesos. Su pedido quedó registrado."),
      paso("Claro."),
    ]);
    await t.cliente("seis de bistec para recoger, pago en efectivo");
    await t.cliente("sí");
    const antes = t.tts.frases.length;
    await t.cliente("y aparte otro pedido de dos de pastor");
    expect(t.tts.frases.slice(antes).join(" ")).not.toMatch(/registrado/);
  });
});

describe("revision #752 P2-4: la escalacion bloqueada tras el «si» respeta el motivo", () => {
  it.each(["alergia_salud", "privacidad_arco", "cliente_lo_pide", "queja", "urgencia"])("motivo %s: la escalacion SI corre aunque la compuerta este abierta", async (motivo) => {
    const { s, cliente } = await armar([...cotizaYLee, paso("", tc("e", "escalar_a_humano", { motivo })), paso("Le paso con una persona.")]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.escalaciones).toBe(1);
    expect(s.pedidos).toBe(0);
  });

  it.each([[undefined], ["falla_sistema"], ["no_entiende"]])("motivo %j: se bloquea y se registra primero el pedido", async (motivo) => {
    const { s, cliente } = await armar([
      ...cotizaYLee,
      paso("", tc("e", "escalar_a_humano", motivo === undefined ? {} : { motivo })),
      paso("", tc("c", "confirmar_resumen")),
      paso("", tc("p", "crear_pedido")),
      paso("Listo, su pedido quedó registrado."),
    ]);
    await cliente("seis de bistec para recoger, pago en efectivo");
    await cliente("sí");
    expect(s.escalaciones).toBe(0);
    expect(s.pedidos).toBe(1);
  });
});

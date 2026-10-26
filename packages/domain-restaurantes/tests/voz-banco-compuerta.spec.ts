// Compuerta de pedidos del banco de voz (scripts/voz-banco/compuerta-pedidos.ts) y traza de herramientas. Sin red ni proveedores: un "servidor" simulado devuelve cotizaciones con
// huella y total, y se maneja la compuerta como lo haria el corredor (turno del cliente -> lo que el agente dice -> herramientas). La decision es la funcion de produccion
// `ejecutarHerramientas`, asi que lo que se verifica aqui es que el decorador la alimenta bien y bloquea igual que la cascada v2.
import { describe, expect, it } from "vitest";
import { CompuertaPedidos, conCompuerta } from "../../../scripts/voz-banco/compuerta-pedidos.ts";
import type { ContextoTool, EjecutarTool, ModoCompuerta } from "../../../scripts/voz-banco/tipos.ts";
import { TrazaHerramientas } from "../../../scripts/voz-banco/traza-herramientas.ts";

function servidor(opts: { hashes?: string[] } = {}) {
  const s = { llamadas: [] as { nombre: string; turno: number | undefined }[], pedidos: 0, cotizaciones: 0 };
  const ejecutar: EjecutarTool = async (l, ctx?: ContextoTool) => {
    s.llamadas.push({ nombre: l.nombre, turno: ctx?.turno });
    if (l.nombre === "cotizar_pedido") {
      const h = opts.hashes?.[s.cotizaciones] ?? "h1";
      s.cotizaciones += 1;
      return { quote: { total: 328 }, quote_hash: h.padEnd(32, "0") };
    }
    if (l.nombre === "confirmar_resumen") return { ok: true };
    if (l.nombre === "crear_pedido") { s.pedidos += 1; return { order: { id: `o${s.pedidos}` } }; }
    return { ok: true };
  };
  return { s, ejecutar };
}

/** Banco de pruebas minimo del corredor: traza (externa) + compuerta (interna) + servidor. */
function montar(modo: ModoCompuerta, opts: { hashes?: string[] } = {}) {
  const srv = servidor(opts);
  const { ejecutar, compuerta } = conCompuerta(srv.ejecutar, { modo });
  const traza = new TrazaHerramientas();
  const modelo = traza.decorar(ejecutar);
  let n = 0;
  const llamar = (nombre: string, args: Record<string, unknown> = {}) => modelo({ id: `t${(n += 1)}`, nombre, args });
  const cliente = (texto: string) => { traza.alTurnoCliente(texto); compuerta.alTurnoCliente(texto); };
  const agente = (texto: string) => { compuerta.alAgenteDijo(texto); compuerta.alAgenteTermino(); };
  return { ...srv, compuerta, traza, llamar, cliente, agente };
}

const BLOQUEO = { error: "espera_confirmacion_del_cliente" };

describe("compuerta de pedidos (modo on): bloquea igual que la cascada v2", () => {
  it("camino feliz: total oido + afirmacion pura + confirmar en el turno -> crear corre UNA vez", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos de pastor para recoger");
    await m.llamar("cotizar_pedido");
    m.agente("Son tres tacos, el total es 328 pesos. Confirma con un si?");
    m.cliente("si");
    await m.llamar("confirmar_resumen");
    const r = await m.llamar("crear_pedido");
    expect(r).toEqual({ order: { id: "o1" } });
    expect(m.s.pedidos).toBe(1);
    expect(m.traza.intentosCrearSinConfirmar).toBe(0);
  });

  it("sin afirmacion del cliente (hace una pregunta) crear NO corre, aunque el modelo pida confirmar y crear juntos", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.agente("El total es 328 pesos. Confirma?");
    m.cliente("y cuanto tardan?");
    await m.llamar("confirmar_resumen");
    const r = await m.llamar("crear_pedido");
    expect(r).toMatchObject(BLOQUEO);
    expect(m.s.pedidos).toBe(0);
    expect(m.s.llamadas.map((l) => l.nombre)).not.toContain("crear_pedido");
    expect(m.traza.intentosCrearSinConfirmar).toBe(1);
    expect(m.traza.crearIndebidosEjecutados).toBe(0);
  });

  it("si el agente nunca dijo el TOTAL, un «si» no abre la compuerta (el resumen no se leyo)", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.agente("Perfecto, ya lo tengo anotado. Confirma?"); // sin cifra
    m.cliente("si");
    await m.llamar("confirmar_resumen");
    const r = await m.llamar("crear_pedido");
    expect(r).toMatchObject(BLOQUEO);
    expect(m.s.pedidos).toBe(0);
  });

  it("un total distinto al cotizado tampoco cuenta como leido", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido"); // total 328
    m.agente("Son 280 pesos en total. Confirma?");
    m.cliente("si");
    await m.llamar("confirmar_resumen");
    expect(await m.llamar("crear_pedido")).toMatchObject(BLOQUEO);
  });

  it("huella vigente: una cotizacion NUEVA tras oir el resumen invalida el «si» anterior", async () => {
    const m = montar("on", { hashes: ["ha", "hb"] });
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.agente("El total es 328 pesos. Confirma?");
    m.cliente("si");
    await m.llamar("cotizar_pedido"); // el modelo re-cotiza en el turno del «si»: huella nueva que el cliente nunca oyo
    await m.llamar("confirmar_resumen");
    expect(await m.llamar("crear_pedido")).toMatchObject(BLOQUEO);
    expect(m.s.pedidos).toBe(0);
  });

  it("interrumpir al agente a media lectura deja el resumen sin leer", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.compuerta.alAgenteDijo("El total es 328 pesos");
    m.compuerta.alInterrumpir(); // barge-in antes de terminar
    m.compuerta.alAgenteTermino(); // el proveedor igual avisa el fin del turno interrumpido
    m.cliente("si");
    await m.llamar("confirmar_resumen");
    expect(await m.llamar("crear_pedido")).toMatchObject(BLOQUEO);
  });

  it("tras un rechazo («cancela») el resumen leido deja de ser vigente", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.agente("El total es 328 pesos. Confirma?");
    m.cliente("mejor no, cancela");
    m.agente("Listo, cancelado el pedido de 328 pesos.");
    m.cliente("si");
    await m.llamar("confirmar_resumen");
    expect(await m.llamar("crear_pedido")).toMatchObject(BLOQUEO);
  });

  it("dos herramientas pedidas A LA VEZ (confirmar y crear) se ejecutan de a una y en orden", async () => {
    const m = montar("on");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.agente("El total es 328 pesos. Confirma?");
    m.cliente("si");
    const [a, b] = await Promise.all([m.llamar("confirmar_resumen"), m.llamar("crear_pedido")]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ order: { id: "o1" } });
    expect(m.s.llamadas.map((l) => l.nombre).slice(-2)).toEqual(["confirmar_resumen", "crear_pedido"]);
  });
});

describe("compuerta como factor experimental", () => {
  async function confirmarYCrearJuntos(modo: ModoCompuerta) {
    const m = montar(modo);
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    await m.llamar("confirmar_resumen"); // en el MISMO turno del cliente que cotizo
    const r = await m.llamar("crear_pedido");
    return { m, r };
  }

  it("off: deja pasar ambos y la traza cuenta el crear sin confirmar como pedido indebido", async () => {
    const { m, r } = await confirmarYCrearJuntos("off");
    expect(r).toEqual({ order: { id: "o1" } });
    expect(m.traza.intentosCrearSinConfirmar).toBe(1);
    expect(m.traza.crearIndebidosEjecutados).toBe(1);
  });

  it("on: el mismo intento se cuenta pero NO llega a ejecutarse", async () => {
    const { m, r } = await confirmarYCrearJuntos("on");
    expect(r).toMatchObject(BLOQUEO);
    expect(m.traza.intentosCrearSinConfirmar).toBe(1);
    expect(m.traza.crearIndebidosEjecutados).toBe(0);
    expect(m.traza.registros.find((x) => x.nombre === "crear_pedido")).toMatchObject({ bloqueadaPorCompuerta: true, ok: false, sinConfirmar: true });
  });

  it("servidor: no bloquea localmente y entrega el numero de turno al ejecutor (para x-atiende-call-turn)", async () => {
    const m = montar("servidor");
    m.cliente("quiero tres tacos");
    await m.llamar("cotizar_pedido");
    m.cliente("si");
    await m.llamar("crear_pedido");
    expect(m.s.llamadas).toEqual([{ nombre: "cotizar_pedido", turno: 1 }, { nombre: "crear_pedido", turno: 2 }]);
  });

  it("una herramienta que lanza se vuelve un error corto, sin romper al proveedor", async () => {
    const { ejecutar } = conCompuerta(async () => { throw new Error("boom con datos"); }, { modo: "on" });
    expect(await ejecutar({ id: "x", nombre: "buscar_producto", args: {} })).toEqual({ error: "herramienta_fallo" });
  });

  it("CompuertaPedidos expone el estado y no cambia con turnos vacios", () => {
    const c = new CompuertaPedidos("on");
    c.alTurnoCliente("   ");
    expect(c.turno).toBe(0);
  });
});

// T02: corredor proveedor-agnostico de UNA llamada en modo M0 (texto / STT-final con ruido). Recibe un `AdaptadorBanco`, un ejecutor de herramientas y un tope; no conoce ningun
// proveedor ni red. El adaptador solo recibe manejadores ya "envueltos": traza (externa) -> compuerta (interna) -> ejecutor real. Producto: `ResultadoLlamada` (esquema de BANCO 5, subconjunto).
import type { AperturaLlamada, ManejadoresSesion } from "../../packages/voice-core/src/llamada/sesion.ts";
import type { Escenario } from "../voz-medicion-real/escenarios.ts";
import { ClienteSimulado } from "./cliente-simulado.ts";
import { CompuertaPedidos } from "./compuerta-pedidos.ts";
import type { ReglaPedidos } from "./compuerta-pedidos.ts";
import { TopeDeLlamada, TopeExcedido } from "./topes.ts";
import type { TopeGasto } from "./topes.ts";
import { TrazaHerramientas } from "./traza-herramientas.ts";
import type { AdaptadorBanco, EjecutarTool, ModoCompuerta, ResultadoLlamada } from "./tipos.ts";

export interface OpcionesCorrida {
  readonly adaptador: AdaptadorBanco;
  readonly escenario: Escenario;
  readonly rep: number;
  readonly modoCliente: "texto" | "stt-final";
  readonly modoCompuerta: ModoCompuerta;
  readonly ejecutor: EjecutarTool;
  readonly apertura: AperturaLlamada;
  readonly tope: TopeGasto;
  readonly nivelRuido?: number;
  readonly regla?: ReglaPedidos;
  readonly timeoutTurnoMs?: number;
}

export async function correrLlamada(o: OpcionesCorrida): Promise<ResultadoLlamada> {
  const cliente = new ClienteSimulado(o.escenario, { modo: o.modoCliente, rep: o.rep, ...(o.nivelRuido === undefined ? {} : { nivelRuido: o.nivelRuido }) });
  const compuerta = new CompuertaPedidos(o.modoCompuerta, o.regla);
  const traza = new TrazaHerramientas(o.regla);
  const ejecutarTool = traza.decorar(compuerta.decorar(o.ejecutor));
  const turnos: { dicho: string; oido: string; cambios: readonly string[]; agente: string }[] = [];
  let dichoAgente = "";
  let finTurno: (() => void) | null = null;
  let caida: ((e: Error) => void) | null = null;

  const manejadores: ManejadoresSesion = {
    agenteDijo: (t) => { dichoAgente += `${dichoAgente ? " " : ""}${t}`; compuerta.alAgenteDijo(t); },
    agenteTermino: () => { compuerta.alAgenteTermino(); finTurno?.(); },
    interrumpido: () => compuerta.alInterrumpir(),
    ejecutarTool: (l) => ejecutarTool(l) as Promise<unknown>,
    costo: (micro) => o.tope.registrarMicroUsd(micro),
    caido: (razon) => caida?.(new Error(`proveedor caido: ${String(razon).slice(0, 40)}`)),
  };

  o.tope.iniciarLlamada();
  const sesion = await o.adaptador.crearAbrirSesion({ ruido: o.modoCliente === "stt-final", hzEntrada: 16_000, hzSalida: 24_000 })(o.apertura, manejadores);
  let cortada: ResultadoLlamada["cortada"] = null;
  try {
    for (let t = await cliente.siguiente(); t !== null; t = await cliente.siguiente()) {
      o.tope.verificar();
      if (t.tipo === "evento") { turnos.push({ dicho: `(${t.evento.k})`, oido: "", cambios: [], agente: "" }); continue; }
      // El barge-in corta la generacion ANTERIOR: se avisa antes de abrir el turno nuevo.
      if (t.interrumpe) { sesion.interrumpir(); compuerta.alInterrumpir(); }
      traza.alTurnoCliente(t.oido);
      compuerta.alTurnoCliente(t.oido);
      dichoAgente = "";
      let plazo: ReturnType<typeof setTimeout> | undefined;
      const espera = new Promise<void>((ok, mal) => {
        finTurno = ok;
        caida = mal;
        plazo = setTimeout(() => mal(new Error("el agente no termino el turno a tiempo")), o.timeoutTurnoMs ?? 10_000);
      });
      try {
        sesion.enviarTexto(t.oido);
        await espera;
      } finally {
        clearTimeout(plazo);
      }
      cliente.registrarAgente(dichoAgente || "(silencio del agente)");
      turnos.push({ dicho: t.dicho, oido: t.oido, cambios: t.cambios, agente: dichoAgente });
      o.tope.verificar();
    }
  } catch (x) {
    if (x instanceof TopeDeLlamada) cortada = "tope_llamada";
    else {
      o.tope.cerrarLlamada();
      await sesion.cerrar().catch(() => undefined);
      throw x; // TopeExcedido (corrida) y las demas fallas suben tal cual
    }
  }
  await sesion.cerrar().catch(() => undefined);
  o.tope.cerrarLlamada();
  // El gasto cerrado puede haber dejado la corrida en el tope (o en NaN): se verifica de inmediato.
  o.tope.verificar();
  return {
    escenario: o.escenario.id,
    arquitectura: o.adaptador.id,
    modo: o.modoCliente === "texto" ? "M0-texto" : "M0-stt-final",
    semilla: cliente.semilla,
    turnos,
    herramientas: traza.registros,
    intentosCrearSinConfirmar: traza.intentosCrearSinConfirmar,
    crearIndebidosEjecutados: traza.crearIndebidosEjecutados,
    costo: o.adaptador.costoMicroUsd(),
    cortada,
  };
}

export { TopeExcedido };

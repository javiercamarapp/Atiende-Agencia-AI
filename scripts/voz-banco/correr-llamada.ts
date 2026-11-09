// T02: corredor proveedor-agnostico de UNA llamada en modo M0 (texto / STT-final con ruido). Recibe un `AdaptadorBanco`, un ejecutor de herramientas y un tope; no conoce ningun
// proveedor ni red. El adaptador solo recibe manejadores ya "envueltos": traza (externa) -> compuerta (interna) -> ejecutor real. Producto: `ResultadoLlamada` (esquema de BANCO 5, subconjunto).
import type { AperturaLlamada, ManejadoresSesion } from "../../packages/voice-core/src/llamada/sesion.ts";
import type { Escenario } from "../voz-medicion-real/escenarios.ts";
import { redactar } from "../voz-medicion-real/guardas.ts";
import { exigirAislamiento } from "./aislamiento.ts";
import { ClienteSimulado } from "./cliente-simulado.ts";
import { CompuertaPedidos } from "./compuerta-pedidos.ts";
import type { ReglaPedidos } from "./compuerta-pedidos.ts";
import { AbortoDeSeguridad, TopeDeLlamada, TopeExcedido } from "./topes.ts";
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
  /**
   * Stack local + entorno para `exigirAislamiento`. OBLIGATORIO con cualquier adaptador distinto del doble `falso`: sin esto (o si el stack/entorno no es local) la corrida aborta ANTES de abrir
   * la primera sesion. El doble no toca red ni llaves, por eso es el unico que puede correr sin aislamiento.
   */
  readonly aislamiento?: { readonly stack: unknown; readonly env: Record<string, string | undefined> };
}

/** Los unicos adaptadores sin red ni llaves: pueden correr sin aislamiento. */
const ADAPTADORES_LOCALES = new Set(["falso"]);

export async function correrLlamada(o: OpcionesCorrida): Promise<ResultadoLlamada> {
  // Aislamiento ANTES de cualquier otra cosa (incluido el cliente simulado y la sesion): un adaptador real sin stack local verificado no corre.
  if (!ADAPTADORES_LOCALES.has(o.adaptador.id)) {
    if (!o.aislamiento) throw new AbortoDeSeguridad("un adaptador distinto del falso exige `aislamiento` (stack local y entorno verificados) antes de abrir sesion");
    await exigirAislamiento(o.aislamiento.stack, o.aislamiento.env);
  }
  const cliente = new ClienteSimulado(o.escenario, { modo: o.modoCliente, rep: o.rep, ...(o.nivelRuido === undefined ? {} : { nivelRuido: o.nivelRuido }) });
  const compuerta = new CompuertaPedidos(o.modoCompuerta, o.regla);
  const traza = new TrazaHerramientas(o.regla, compuerta);
  const ejecutarTool = traza.decorar(compuerta.decorar(o.ejecutor));
  const turnos: { dicho: string; oido: string; cambios: readonly string[]; agente: string }[] = [];
  let dichoAgente = "";
  let finTurno: (() => void) | null = null;
  let caida: ((e: Error) => void) | null = null;
  /** Cuantas veces el adaptador reporto costo (aunque fuera 0): un turno sin ningun reporte NO se da por gratis, corta (falla cerrado). */
  let reportesCosto = 0;

  const manejadores: ManejadoresSesion = {
    agenteDijo: (t) => { dichoAgente += `${dichoAgente ? " " : ""}${t}`; compuerta.alAgenteDijo(t); },
    agenteTermino: () => { compuerta.alAgenteTermino(); finTurno?.(); },
    interrumpido: () => compuerta.alInterrumpir(),
    ejecutarTool: (l) => ejecutarTool(l) as Promise<unknown>,
    costo: (micro) => { reportesCosto += 1; o.tope.registrarMicroUsd(micro); },
    caido: (razon) => caida?.(new Error(`proveedor caido: ${redactar(String(razon)).slice(0, 40)}`)),
  };

  const costoInicial = o.adaptador.costoMicroUsd().total;
  const gastoInicialUsd = o.tope.gastoUsd;
  /** Cruza lo que el adaptador dice haber gastado con lo que llego por `h.costo`; si el adaptador gasto mas de lo reportado (o no es un numero), el gasto pasa a NaN y la corrida corta. */
  const cruzarCosto = (): void => {
    const total = o.adaptador.costoMicroUsd().total;
    const gastoAdaptadorUsd = (total - costoInicial) / 1e6;
    if (!Number.isFinite(gastoAdaptadorUsd) || gastoAdaptadorUsd < 0 || gastoAdaptadorUsd > o.tope.gastoUsd - gastoInicialUsd + 1e-9) o.tope.registrarMicroUsd(Number.NaN);
  };

  o.tope.iniciarLlamada();
  let sesion: Awaited<ReturnType<ReturnType<AdaptadorBanco["crearAbrirSesion"]>>> | null = null;
  let cortada: ResultadoLlamada["cortada"] = null;
  try {
    sesion = await o.adaptador.crearAbrirSesion({ ruido: o.modoCliente === "stt-final", hzEntrada: 16_000, hzSalida: 24_000 })(o.apertura, manejadores);
    try {
      for (let t = await cliente.siguiente(); t !== null; t = await cliente.siguiente()) {
        o.tope.verificar();
        if (t.tipo === "evento") { turnos.push({ dicho: `(${t.evento.k})`, oido: "", cambios: [], agente: "" }); continue; }
        // El barge-in corta la generacion ANTERIOR: se avisa antes de abrir el turno nuevo.
        if (t.interrumpe) { sesion.interrumpir(); compuerta.alInterrumpir(); }
        traza.alTurnoCliente(t.oido);
        compuerta.alTurnoCliente(t.oido);
        dichoAgente = "";
        const reportesAntes = reportesCosto;
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
        if (reportesCosto === reportesAntes) o.tope.registrarMicroUsd(undefined); // sin reporte de costo en el turno: falla CERRADO
        cruzarCosto();
        o.tope.verificar();
      }
    } catch (x) {
      if (x instanceof TopeDeLlamada) cortada = "tope_llamada";
      else throw x; // TopeExcedido (corrida) y las demas fallas suben tal cual
    }
    await sesion.cerrar().catch(() => undefined);
    sesion = null;
  } finally {
    // Siempre se cierra la sesion y la llamada (sin dejarla «en curso»); un costo tardio se sigue contando (ver `TopeGasto`).
    if (sesion) await sesion.cerrar().catch(() => undefined);
    o.tope.cerrarLlamada();
  }
  // El gasto cerrado puede haber dejado la corrida en el tope (o en NaN): se verifica de inmediato.
  cruzarCosto();
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
    // Campos del esquema §5 que aun no se miden en M0: van en null (no 0) para no confundir «sin medir» con «cero».
    latenciaPrimerAudioMs: null,
    pedidoEsperado: null,
    pedidoFinalCorrectoEnBd: null,
  };
}

export { TopeExcedido };

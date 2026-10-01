// Runner del arnes de evaluacion del Copiloto. Corre N modelos x M casos x K repeticiones con el MISMO motor de
// produccion (runDataChatTurn), el MISMO catalogo cerrado de cada vertical y el alcance fijado por el servidor.
//  - Acepta cualquier lista de modelos (ids de OpenRouter) y una fabrica de `complete` (OpenRouter real o guion).
//  - Tope de gasto DURO en USD (presupuesto.ts): al agotarse aborta y reporta los casos NO corridos.
//  - Orden caso-mayor: para cada caso corren todos los modelos (con concurrencia acotada), asi un corte por tope deja
//    una cobertura comparable entre modelos.
//  - Un modelo sin ruta EE.UU./ZDR (404 "no endpoints") se DESCARTA tras N fallas seguidas, no se relaja la politica.
//  - 401/402/403 (llave, saldo, bloqueo) abortan toda la corrida: el siguiente modelo fallaria igual.
import { OpenRouterError } from "../../gateway/providers/openrouter.js";
import { runDataChatTurn } from "../engine.js";
import type { DataChatCatalog, DataChatCompletion, DataChatScope, DataChatTool } from "../types.js";
import { evaluarCaso, observarLlamada, reglasEspanol, type ContextoGrader } from "./graders.js";
import type { JuezEspanol, NotaJuez } from "./juez-espanol.js";
import { PresupuestoDuro, TopeDeGastoError } from "./presupuesto.js";
import type { ModeloCandidato } from "./candidatos.js";
import { REPARTO_CATEGORIAS, CATEGORIAS_CASO, type CasoEval, type EvaluacionCaso, type LlamadaObservada, type ResultadoCapturado, type ResultadoGrader, type SalidaTurno } from "./types.js";

export interface MundoVertical {
  readonly vertical: string;
  readonly scope: DataChatScope;
  readonly now: Date;
  /** Abre un catalogo ligado a los datos (Postgres sembrado o repeticion congelada). `cerrar` libera la sesion. */
  abrir(): Promise<{ readonly catalog: DataChatCatalog; cerrar(): Promise<void> }>;
}

export type FabricaCompletion = (modelo: ModeloCandidato, caso: CasoEval, rep: number) => DataChatCompletion;

export type FaseCorrida = "ci" | "humo" | "piloto" | "barrido" | "cfo";

export interface OpcionesCorrida {
  readonly fase: FaseCorrida;
  readonly modelos: readonly ModeloCandidato[];
  readonly casos: readonly CasoEval[];
  readonly mundos: Readonly<Record<string, MundoVertical>>;
  readonly k: number;
  readonly presupuesto: PresupuestoDuro;
  readonly fabrica: FabricaCompletion;
  readonly juez?: JuezEspanol;
  /** Modelos corriendo a la vez por caso (por defecto 6). */
  readonly concurrencia?: number;
  /** Fallas de ruta seguidas que descartan a un modelo (por defecto 3). */
  readonly maxFallasRuta?: number;
  readonly alProgreso?: (p: { readonly hechos: number; readonly total: number; readonly gastoUsd: number; readonly modelo: string; readonly casoId: string }) => void;
}

export type EstadoRegistro = "evaluado" | "error_proveedor" | "sin_ruta" | "no_corrido";

export interface ResumenSalida {
  readonly status: string;
  readonly text: string;
  readonly textoModelo: string;
  readonly toolsUsed: readonly string[];
  readonly llamadas: readonly { readonly name: string; readonly argumentsJson: string; readonly errorArgs: string | null }[];
  readonly latenciaMs: number;
  readonly latenciaLlmMs: number;
  readonly costoUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly rondas: number;
}

export interface RegistroTurno {
  readonly casoId: string;
  readonly vertical: string;
  readonly categoria: string;
  readonly modelo: string;
  readonly rep: number;
  readonly estado: EstadoRegistro;
  readonly detalle?: string;
  readonly evaluacion?: EvaluacionCaso;
  readonly salida?: ResumenSalida;
  readonly espanolReglas?: ResultadoGrader;
  readonly juez?: NotaJuez;
}

export interface ResultadoCorrida {
  readonly fase: FaseCorrida;
  readonly k: number;
  readonly maxUsd: number;
  readonly gastoUsd: number;
  readonly gastoPorModelo: Readonly<Record<string, number>>;
  readonly modelos: readonly string[];
  readonly casosPlaneados: number;
  readonly registros: readonly RegistroTurno[];
  readonly noCorridos: readonly { readonly modelo: string; readonly casoId: string; readonly rep: number; readonly motivo: string }[];
  readonly descartados: readonly { readonly modelo: string; readonly motivo: string }[];
  readonly abortada: null | "tope_de_gasto" | "cuenta";
  readonly detalleAborto?: string;
}

class AbortoCuenta extends Error {}

// ---------------------------------------------------------------------------------------------

function capturarCatalogo(catalog: DataChatCatalog, sink: ResultadoCapturado[]): DataChatCatalog {
  const tools: DataChatTool[] = catalog.tools.map((t) => ({
    ...t,
    async run(ctx, args) {
      const result = await t.run(ctx, args);
      sink.push({ tool: t.name, result });
      return result;
    },
  }));
  return { ...catalog, tools };
}

export function contextoGrader(catalog: DataChatCatalog, mundo: Pick<MundoVertical, "now" | "scope">): ContextoGrader {
  const params: Record<string, DataChatTool["params"]> = {};
  for (const t of catalog.tools) params[t.name] = t.params;
  return { now: mundo.now, timezone: mundo.scope.timezone, params };
}

interface TurnoBruto {
  readonly salida: SalidaTurno;
  readonly evaluacion: EvaluacionCaso;
  readonly errorLlm: unknown | null;
}

export async function correrTurno(caso: CasoEval, mundo: MundoVertical, completeBase: DataChatCompletion): Promise<TurnoBruto> {
  const { catalog, cerrar } = await mundo.abrir();
  try {
    const resultados: ResultadoCapturado[] = [];
    const envuelto = capturarCatalogo(catalog, resultados);
    const ctx = contextoGrader(catalog, mundo);
    const llamadas: LlamadaObservada[] = [];
    let textoModelo = "";
    let llmMs = 0;
    let costo = 0;
    let tIn = 0;
    let tOut = 0;
    let rondas = 0;
    let errorLlm: unknown = null;

    const complete: DataChatCompletion = async (req) => {
      const t0 = Date.now();
      rondas += 1;
      try {
        const r = await completeBase(req);
        llmMs += Date.now() - t0;
        costo += r.costUsd ?? 0;
        tIn += r.tokensIn ?? 0;
        tOut += r.tokensOut ?? 0;
        for (const c of r.toolCalls ?? []) llamadas.push(observarLlamada(ctx.params[c.name], c.name, c.argumentsJson));
        textoModelo = (r.toolCalls?.length ?? 0) === 0 ? (r.text ?? "") : textoModelo;
        return r;
      } catch (err) {
        llmMs += Date.now() - t0;
        throw err;
      }
    };

    const t0 = Date.now();
    const answer = await runDataChatTurn({
      catalog: envuelto,
      scope: mundo.scope,
      question: caso.pregunta,
      history: caso.historial,
      complete,
      now: mundo.now,
      onError: (where, err) => {
        if (where === "llm") errorLlm = err;
      },
    });
    const latenciaMs = Date.now() - t0;

    const salida: SalidaTurno = {
      status: answer.status,
      text: answer.text,
      toolsUsed: answer.toolsUsed,
      blocks: answer.blocks.map((b) => ({ tool: b.tool, columns: b.columns, rows: b.rows, chart: b.chart })),
      sources: answer.sources,
      llamadas,
      textoModelo,
      resultados,
      latenciaMs,
      latenciaLlmMs: llmMs,
      costoUsd: costo,
      tokensIn: tIn,
      tokensOut: tOut,
      rondas,
    };
    return { salida, evaluacion: evaluarCaso(caso, salida, ctx), errorLlm };
  } finally {
    await cerrar().catch(() => undefined);
  }
}

function resumir(s: SalidaTurno): ResumenSalida {
  return {
    status: s.status,
    text: s.text,
    textoModelo: s.textoModelo,
    toolsUsed: s.toolsUsed,
    llamadas: s.llamadas.map((l) => ({ name: l.name, argumentsJson: l.argumentsJson.slice(0, 300), errorArgs: l.errorArgs })),
    latenciaMs: s.latenciaMs,
    latenciaLlmMs: s.latenciaLlmMs,
    costoUsd: s.costoUsd,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    rondas: s.rondas,
  };
}

/** Clasifica el error del proveedor capturado por el motor. Lanza si hay que abortar toda la corrida. */
function clasificarError(err: unknown): { estado: "sin_ruta" | "error_proveedor"; detalle: string } {
  if (err instanceof TopeDeGastoError) throw err;
  if (err instanceof OpenRouterError) {
    if (err.status === 401 || err.status === 402 || err.status === 403) throw new AbortoCuenta(`OpenRouter ${err.status}: llave invalida, sin saldo o bloqueo de cuenta`);
    if (err.status === 400 || err.status === 404 || err.status === 422) return { estado: "sin_ruta", detalle: String(err.message).slice(0, 200) };
    return { estado: "error_proveedor", detalle: String(err.message).slice(0, 200) };
  }
  return { estado: "error_proveedor", detalle: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
}

class Semaforo {
  private libres: number;
  private cola: (() => void)[] = [];
  constructor(n: number) {
    this.libres = Math.max(1, n);
  }
  async adquirir(): Promise<void> {
    if (this.libres > 0) {
      this.libres -= 1;
      return;
    }
    await new Promise<void>((res) => this.cola.push(res));
  }
  liberar(): void {
    const s = this.cola.shift();
    if (s) s();
    else this.libres += 1;
  }
}

export async function correrEval(o: OpcionesCorrida): Promise<ResultadoCorrida> {
  const registros: RegistroTurno[] = [];
  const noCorridos: { modelo: string; casoId: string; rep: number; motivo: string }[] = [];
  const descartados = new Map<string, string>();
  const fallasRuta = new Map<string, number>();
  const maxFallas = o.maxFallasRuta ?? 3;
  const sem = new Semaforo(o.concurrencia ?? 6);
  const total = o.casos.length * o.modelos.length * o.k;
  let hechos = 0;
  let abortada: ResultadoCorrida["abortada"] = null;
  let detalleAborto: string | undefined;

  const turno = async (caso: CasoEval, modelo: ModeloCandidato, rep: number): Promise<void> => {
    const mundo = o.mundos[caso.vertical];
    if (!mundo) {
      registros.push({ casoId: caso.id, vertical: caso.vertical, categoria: caso.categoria, modelo: modelo.id, rep, estado: "no_corrido", detalle: `sin mundo para la vertical ${caso.vertical}` });
      return;
    }
    await sem.adquirir();
    try {
      if (abortada) {
        noCorridos.push({ modelo: modelo.id, casoId: caso.id, rep, motivo: abortada });
        return;
      }
      const motivoDescarte = descartados.get(modelo.id);
      if (motivoDescarte) {
        noCorridos.push({ modelo: modelo.id, casoId: caso.id, rep, motivo: `modelo descartado: ${motivoDescarte}` });
        return;
      }
      const base = o.fabrica(modelo, caso, rep);
      const conTope: DataChatCompletion = async (req) => {
        const reserva = o.presupuesto.reservar(modelo.id);
        try {
          const r = await base(req);
          reserva.liberar(r.costUsd);
          return r;
        } catch (err) {
          reserva.liberar(0);
          throw err;
        }
      };
      let bruto: TurnoBruto;
      try {
        bruto = await correrTurno(caso, mundo, conTope);
      } catch (err) {
        registros.push({ casoId: caso.id, vertical: caso.vertical, categoria: caso.categoria, modelo: modelo.id, rep, estado: "error_proveedor", detalle: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return;
      }
      if (bruto.errorLlm !== null) {
        try {
          const c = clasificarError(bruto.errorLlm);
          registros.push({ casoId: caso.id, vertical: caso.vertical, categoria: caso.categoria, modelo: modelo.id, rep, estado: c.estado, detalle: c.detalle });
          if (c.estado === "sin_ruta") {
            const n = (fallasRuta.get(modelo.id) ?? 0) + 1;
            fallasRuta.set(modelo.id, n);
            if (n >= maxFallas) descartados.set(modelo.id, `sin ruta EE.UU./ZDR tras ${n} intentos (${c.detalle})`);
          } else fallasRuta.set(modelo.id, 0);
        } catch (err) {
          if (err instanceof TopeDeGastoError) {
            abortada = "tope_de_gasto";
            detalleAborto = err.message;
            noCorridos.push({ modelo: modelo.id, casoId: caso.id, rep, motivo: "tope_de_gasto" });
          } else if (err instanceof AbortoCuenta) {
            abortada = "cuenta";
            detalleAborto = err.message;
            noCorridos.push({ modelo: modelo.id, casoId: caso.id, rep, motivo: "cuenta" });
          } else throw err;
        }
        return;
      }
      fallasRuta.set(modelo.id, 0);
      const reglas = reglasEspanol(bruto.salida.text);
      let juez: NotaJuez | undefined;
      if (o.juez && bruto.salida.text.trim() && bruto.salida.status === "ok") {
        try {
          juez = await o.juez.juzgar({ pregunta: caso.pregunta, texto: bruto.salida.text });
        } catch (err) {
          if (err instanceof TopeDeGastoError) {
            abortada = "tope_de_gasto";
            detalleAborto = err.message;
          }
        }
      }
      registros.push({
        casoId: caso.id,
        vertical: caso.vertical,
        categoria: caso.categoria,
        modelo: modelo.id,
        rep,
        estado: "evaluado",
        evaluacion: bruto.evaluacion,
        salida: resumir(bruto.salida),
        espanolReglas: reglas,
        ...(juez ? { juez } : {}),
      });
    } finally {
      hechos += 1;
      o.alProgreso?.({ hechos, total, gastoUsd: o.presupuesto.gastoUsd, modelo: modelo.id, casoId: caso.id });
      sem.liberar();
    }
  };

  for (const caso of o.casos) {
    const tareas: Promise<void>[] = [];
    for (const modelo of o.modelos) for (let rep = 1; rep <= o.k; rep += 1) tareas.push(turno(caso, modelo, rep));
    await Promise.all(tareas);
    if (abortada) {
      // Los casos restantes quedan como no corridos (sin lanzar nada).
      const idx = o.casos.indexOf(caso);
      for (const c of o.casos.slice(idx + 1)) for (const m of o.modelos) for (let rep = 1; rep <= o.k; rep += 1) noCorridos.push({ modelo: m.id, casoId: c.id, rep, motivo: abortada });
      break;
    }
  }

  const gastoPorModelo: Record<string, number> = {};
  for (const m of o.modelos) gastoPorModelo[m.id] = o.presupuesto.gastoDe(m.id);
  return {
    fase: o.fase,
    k: o.k,
    maxUsd: o.presupuesto.maxUsd,
    gastoUsd: o.presupuesto.gastoUsd,
    gastoPorModelo,
    modelos: o.modelos.map((m) => m.id),
    casosPlaneados: o.casos.length,
    registros,
    noCorridos,
    descartados: [...descartados].map(([modelo, motivo]) => ({ modelo, motivo })),
    abortada,
    ...(detalleAborto ? { detalleAborto } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Seleccion del PILOTO: N casos por vertical respetando el reparto por categoria del plan.
// ---------------------------------------------------------------------------------------------

export function seleccionarPiloto(casos: readonly CasoEval[], porVertical: number): CasoEval[] {
  const out: CasoEval[] = [];
  const verticales = [...new Set(casos.map((c) => c.vertical))];
  for (const v of verticales) {
    const deV = casos.filter((c) => c.vertical === v);
    const cuota = new Map<string, number>();
    let asignados = 0;
    for (const cat of CATEGORIAS_CASO) {
      const n = Math.min(deV.filter((c) => c.categoria === cat).length, Math.floor((REPARTO_CATEGORIAS[cat] / 100) * porVertical));
      cuota.set(cat, n);
      asignados += n;
    }
    // reparte el resto por orden de peso hasta llegar a N (o agotar casos)
    const porPeso = [...CATEGORIAS_CASO].sort((a, b) => REPARTO_CATEGORIAS[b] - REPARTO_CATEGORIAS[a]);
    let guardia = 0;
    while (asignados < Math.min(porVertical, deV.length) && guardia < 1000) {
      guardia += 1;
      for (const cat of porPeso) {
        if (asignados >= Math.min(porVertical, deV.length)) break;
        const disponibles = deV.filter((c) => c.categoria === cat).length;
        if ((cuota.get(cat) ?? 0) < disponibles) {
          cuota.set(cat, (cuota.get(cat) ?? 0) + 1);
          asignados += 1;
        }
      }
    }
    for (const cat of CATEGORIAS_CASO) out.push(...deV.filter((c) => c.categoria === cat).slice(0, cuota.get(cat) ?? 0));
  }
  return out;
}

// Ejecucion de las herramientas pedidas por el LLM en un turno de la cascada v2: MISMA regla que la sesion de Gemini Live (`gemini-live-sesion.ts`):
// en SERIE y en el orden pedido (una cotizacion y un crear_pedido pedidos juntos nunca corren a la vez), salvo la racha INICIAL de herramientas de solo lectura
// declaradas en `enParalelo` (buscar cliente / sucursal / producto, sin estado compartido), que corre en paralelo conservando el orden de las respuestas.
// Dos guardas propias del streaming:
//  - `continuar`: se consulta ANTES de cada herramienta en serie. Si el cliente interrumpio ("no, espere") a media confirmar_resumen, lo que sigue NO corre
//    (respuesta `interrumpido_por_el_cliente`): un crear_pedido nunca se ejecuta sobre un resumen que el cliente acaba de rechazar.
//  - `confirmacionAntesDeCrear`: Anthropic en OpenRouter no admite `parallel_tool_calls` (con require_parameters daria 404), asi que el cliente impide que el modelo
//    confirme y cree sin que el cliente haya dicho «si»: tras `confirmar`, un `crear` posterior espera la respuesta del cliente (`espera_confirmacion_del_cliente`).
//    Con `cotizar` configurado la regla es de MAQUINA DE ESTADOS del lado del CLIENTE (este codigo): el servidor NO garantiza el turno del «si» en voz (en voz `flow.turn` es null
//    y `assertCanConfirm` solo compara turnos cuando ambos existen), asi que la seguridad la da esto: `huellaOida` (el resumen con su TOTAL ya se le leyo al cliente, fijada solo
//    cuando el agente termina de hablar sin ser interrumpido), `afirmacion` (el turno del cliente es una afirmacion pura) y `confirmar` con exito en este turno. Con las tres,
//    `crear` corre sin pedir un segundo «si». Sin ellas (resumen no leido o cambiado, `confirmar` rechazado, turno sin afirmacion) `crear` NO corre, ni siquiera si el modelo
//    la llama sin pasar por `confirmar` (p. ej. el servidor ya quedo `confirmado` en un turno anterior y el cliente ahora dice «no, espera»).
import type { ToolCallLlmVoz } from "../cascada-openrouter.ts";
import type { ToolCallPedida } from "../sesion.ts";

export interface ResultadoHerramienta {
  readonly llamada: ToolCallLlmVoz;
  readonly salida: unknown;
}

export interface OpcionesHerramientas {
  readonly enParalelo?: ReadonlySet<string>;
  readonly confirmacionAntesDeCrear?: { readonly confirmar: string; readonly crear: string; readonly cotizar?: string };
  /** Falso = el turno ya no esta vigente (el cliente interrumpio o la llamada cerro): no se inicia ninguna herramienta mas. */
  readonly continuar?: () => boolean;
  /** Estado de la regla a nivel de SESION: `pendiente` = el modelo ya confirmo el resumen y espera la respuesta del cliente. Se enciende al ejecutar `confirmar` y la sesion lo apaga
   * cuando el cliente habla de nuevo; mientras este encendido ningun `crear` corre, ni en la misma respuesta ni en una vuelta posterior del MISMO turno. */
  readonly esperandoAlCliente?: EstadoEspera;
  /** Registro de eventos de la compuerta (sin PII: solo nombres de herramienta y motivos). */
  readonly log?: (evento: string, campos?: Record<string, unknown>) => void;
}

/** Estado de la regla a nivel de sesion. `huellaOida` = huella (`quote_hash`) de la cotizacion cuyo resumen ya se le leyo al cliente en un turno anterior; la sesion la fija al
 * terminar un turno en que el agente hablo tras cotizar. `huellaCotizada` / `cotizoEnTurno` son del turno en curso (la sesion los limpia al empezar cada turno). */
export interface EstadoEspera {
  pendiente: boolean;
  /** El turno del cliente en curso ES una afirmacion («si», «ok», «correcto»...; ver `esAfirmacion`). La sesion lo fija al empezar cada turno; sin `true` el resumen no cuenta como confirmado. */
  afirmacion?: boolean;
  /** Total de la ultima cotizacion del turno (para comprobar que el agente lo dijo). */
  totalCotizado?: number | null;
  /** Lo que el agente dijo en voz alta DESDE la cotizacion vigente (la sesion lo acumula; `alCotizar` lo vacia cuando la huella cambia). */
  habladoTrasCotizar?: string;
  /** Total de la cotizacion cuyo resumen se dio por leido (`huellaOida`). */
  totalOido?: number | null;
  /** Ultima cotizacion del llamado (persiste entre turnos; la huella y el total del resumen vigente). Si tras una pregunta intermedia el agente RELEE el total, el resumen vuelve a contar como leido. */
  huellaUltima?: string | null;
  totalUltimo?: number | null;
  huellaOida?: string | null;
  huellaCotizada?: string | null;
  cotizoEnTurno?: boolean;
}

function huellaDe(salida: unknown): string | null {
  if (salida && typeof salida === "object" && !Array.isArray(salida)) {
    const h = (salida as Record<string, unknown>)["quote_hash"];
    if (typeof h === "string" && h.trim() !== "") return h.trim().toLowerCase();
  }
  return null;
}

function totalDe(salida: unknown): number | null {
  if (salida && typeof salida === "object" && !Array.isArray(salida)) {
    const o = salida as Record<string, unknown>;
    // Forma REAL de la ruta de voz: `{ quote: OrderQuote (con total), quote_hash }`; tambien se acepta el total en el nivel superior.
    const fuentes: Record<string, unknown>[] = [o];
    if (o["quote"] && typeof o["quote"] === "object" && !Array.isArray(o["quote"])) fuentes.unshift(o["quote"] as Record<string, unknown>);
    for (const f of fuentes) {
      for (const k of ["total", "total_mxn", "total_a_pagar"]) {
        const v = f[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
        if (typeof v === "string" && /^\s*\$?\s*[\d,]+(\.\d+)?\s*$/.test(v)) return Number(v.replace(/[$,\s]/g, ""));
      }
    }
  }
  return null;
}

function conError(salida: unknown): boolean {
  if (salida === null || salida === undefined) return true;
  if (typeof salida !== "object" || Array.isArray(salida)) return false;
  const o = salida as Record<string, unknown>;
  return ("error" in o && o["error"] !== undefined && o["error"] !== null && o["error"] !== false) || o["ok"] === false;
}

export const MENSAJE_ESPERA_CONFIRMACION =
  "Todavia no se puede crear el pedido: el cliente aun no contesto al resumen. Lea el resumen completo (pedido, entrega, pago y total) UNA vez, pida UN solo «si» y termine su respuesta sin llamar crear_pedido. " +
  "Cuando el cliente diga que si, llame crear_pedido (no le pida otro «si» ni vuelva a leer el resumen).";

function argumentosDe(argsJson: string): Record<string, unknown> {
  try {
    const p = JSON.parse(argsJson || "{}") as unknown;
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch {
    /* argumentos ilegibles: la herramienta los rechazara con su propio error */
  }
  return {};
}

export async function ejecutarHerramientas(
  llamadas: readonly ToolCallLlmVoz[],
  ejecutar: (llamada: ToolCallPedida) => Promise<unknown>,
  opciones: OpcionesHerramientas = {},
): Promise<ResultadoHerramienta[]> {
  const { enParalelo, confirmacionAntesDeCrear: regla, continuar, log } = opciones;
  const espera: EstadoEspera = opciones.esperandoAlCliente ?? { pendiente: false };
  /** Marca que `confirmar` se ejecuto (o ya se ejecuto en la racha inicial) y arma la espera salvo que el resumen ya se haya leido y la confirmacion haya tenido exito. */
  const alConfirmar = (salida: unknown): void => {
    if (!regla) return;
    const huellaLeida = regla.cotizar !== undefined && (espera.huellaOida ?? null) !== null && !conError(salida);
    // El codigo no da por hecho el «si» solo porque el cliente hablo: su turno debe ser una afirmacion (sin negacion, pregunta ni ruido).
    if (huellaLeida && espera.afirmacion !== true) log?.("v2_confirmacion_sin_afirmacion", { motivo: "bloquea_crear", herramienta: regla.confirmar });
    const leido = huellaLeida && espera.afirmacion === true;
    if (!leido) espera.pendiente = true;
  };
  /** Anota la cotizacion: si su huella es distinta de la que el cliente oyo, el resumen nuevo aun no se ha leido. */
  const alCotizar = (salida: unknown): void => {
    if (!regla?.cotizar) return;
    espera.cotizoEnTurno = true;
    const h = huellaDe(salida);
    // Cotizacion nueva (otra huella): lo dicho hasta ahora era del resumen anterior y no cuenta para este.
    if (h !== (espera.huellaCotizada ?? null)) espera.habladoTrasCotizar = "";
    espera.huellaCotizada = h;
    espera.totalCotizado = totalDe(salida);
    if (h !== null) {
      espera.huellaUltima = h;
      espera.totalUltimo = espera.totalCotizado;
    }
    if (h !== null && espera.totalCotizado === null) log?.("v2_total_desconocido", { motivo: "sin_total", herramienta: regla.cotizar });
    if (h === null || h !== espera.huellaOida) espera.huellaOida = null;
  };
  const una = async (tc: ToolCallLlmVoz): Promise<ResultadoHerramienta> => {
    try {
      return { llamada: tc, salida: await ejecutar({ id: tc.id, nombre: tc.nombre, args: argumentosDe(tc.argsJson) }) };
    } catch {
      return { llamada: tc, salida: { error: "herramienta_fallo" } };
    }
  };
  let racha = 0;
  while (enParalelo && racha < llamadas.length && enParalelo.has(llamadas[racha]?.nombre ?? "")) racha++;
  const resultados = racha > 1 ? await Promise.all(llamadas.slice(0, racha).map((tc) => una(tc))) : [];
  for (const r of resultados) {
    if (regla && r.llamada.nombre === regla.cotizar) alCotizar(r.salida);
    if (regla && r.llamada.nombre === regla.confirmar) alConfirmar(r.salida);
  }
  for (let i = resultados.length; i < llamadas.length; i++) {
    const tc = llamadas[i] as ToolCallLlmVoz;
    if (continuar && !continuar()) {
      resultados.push({ llamada: tc, salida: { error: "interrumpido_por_el_cliente", mensaje: "El cliente interrumpio: no se ejecuto. Escuche lo que dice antes de continuar." } });
      continue;
    }
    if (regla && espera.pendiente && tc.nombre === regla.crear) {
      resultados.push({ llamada: tc, salida: { error: "espera_confirmacion_del_cliente", mensaje: MENSAJE_ESPERA_CONFIRMACION } });
      continue;
    }
    if (regla?.cotizar && tc.nombre === regla.crear) {
      // Sin una afirmacion del cliente en ESTE turno (negacion, pregunta, ruido, contenido nuevo) crear nunca corre, aunque el servidor siga «confirmado» de un turno anterior.
      if (espera.afirmacion !== true) {
        log?.("v2_crear_sin_afirmacion", { motivo: "bloquea_crear", herramienta: regla.crear });
        resultados.push({ llamada: tc, salida: { error: "espera_confirmacion_del_cliente", mensaje: MENSAJE_ESPERA_CONFIRMACION } });
        continue;
      }
      // El pedido que se crea debe ser el que el cliente oyo: un quote_hash distinto del ultimo cotizado/leido se rechaza y obliga a re-cotizar y re-leer.
      const crudo = argumentosDe(tc.argsJson)["quote_hash"];
      const pedida = typeof crudo === "string" && crudo.trim() !== "" ? crudo.trim().toLowerCase() : null;
      const vigente = espera.huellaCotizada ?? espera.huellaOida ?? null;
      if (pedida !== null && vigente !== null && pedida !== vigente) {
        espera.huellaOida = null;
        log?.("v2_crear_quote_hash_distinto", { motivo: "hash_distinto", herramienta: regla.crear });
        resultados.push({ llamada: tc, salida: { error: "resumen_distinto_al_leido", mensaje: "El pedido cambio despues de leerle el resumen al cliente. Cotice de nuevo, lea el resumen completo UNA vez y pida UN solo «si» antes de crear_pedido." } });
        continue;
      }
    }
    const res = await una(tc);
    resultados.push(res);
    if (regla && tc.nombre === regla.cotizar) alCotizar(res.salida);
    if (regla && tc.nombre === regla.confirmar) alConfirmar(res.salida);
    // Pedido creado: ese resumen ya se uso. Un segundo «si» (o un crear repetido) debe pasar por una confirmacion nueva; la idempotencia sigue siendo del servidor.
    if (regla?.cotizar && tc.nombre === regla.crear && !conError(res.salida)) {
      espera.huellaOida = null;
      espera.huellaUltima = null;
      espera.totalUltimo = null;
    }
  }
  return resultados;
}

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

/** Regla confirmar -> crear de la vertical. `escalar` (opcional): herramienta de escalacion que NO corre mientras el pedido confirmado aun no se crea (ver `ejecutarHerramientas`).
 * `afirmaRegistro` (opcional): clasificador de frases que AFIRMAN que el pedido ya quedo registrado; la sesion no las dice hasta que `crear` tiene exito. */
export interface ReglaConfirmacion {
  readonly confirmar: string;
  readonly crear: string;
  readonly cotizar?: string;
  readonly escalar?: string;
  readonly afirmaRegistro?: (frase: string) => boolean;
}

export interface OpcionesHerramientas {
  readonly enParalelo?: ReadonlySet<string>;
  readonly confirmacionAntesDeCrear?: ReglaConfirmacion;
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
  /** `confirmar` tuvo exito con la compuerta ABIERTA (resumen leido + afirmacion pura) en este turno y `crear` aun no corrio: la sesion fuerza `crear` en la vuelta siguiente (bucle R1). */
  cierreListo?: boolean;
  /** Forma de pago de la cotizacion vigente, tal como la mando el modelo en `cotizar` (el servidor hereda la previa si la omite; aqui igual). Sin ella NO se fuerza `crear`: el forzado inventaria el pago.
   * El pago NO entra a la huella (`quote_hash`) pero un cambio es otra cotizacion (order-flow.ts quotedPago). El nombre y la direccion no viajan en la cotizacion de voz: la cascada no puede
   * saberlos, asi que no se exigen (el servidor completa el nombre con «Cliente»). */
  pagoCotizado?: "efectivo" | "tarjeta" | null;
  /** Ya se forzo `crear` en este turno del cliente: no se vuelve a forzar aunque el modelo llame `confirmar` otra vez. La sesion lo apaga al empezar cada turno. */
  forzadoEnTurno?: boolean;
  /** `confirmar` tuvo exito en este turno (la sesion lo apaga al empezar cada turno). */
  confirmadoEnTurno?: boolean;
  /** `crear` respondio en este turno: `ok` (pedido creado), `falla` (error del servidor) o `compuerta` (lo freno esta compuerta: el cliente no ha dado un «si» valido). */
  crearEnTurno?: "ok" | "falla" | "compuerta" | null;
  /** Ya hay un pedido creado en esta llamada (las frases de registro ya son ciertas). Vuelve a false con una cotizacion NUEVA (otro pedido: revision #752 P2-3c) y no se
   * enciende si el servidor lo dejo pendiente de aprobar (`pedido_grande` / `por_aprobar`: «quedó registrado» seria falso, P2-3d). */
  pedidoCreado?: boolean;
  /** Huella del ultimo pedido creado: una cotizacion con otra huella es otro pedido. */
  huellaCreada?: string | null;
  /** `crear` respondio que el pedido es grande y queda por aprobar (o retenido) en este turno. */
  pedidoPorAprobar?: boolean;
  /** Herramienta que la sesion debe FORZAR en la vuelta siguiente (escalacion bloqueada con la compuerta abierta: primero confirmar/crear). */
  forzarSiguiente?: string | null;
}

/** La compuerta deja crear en este turno: el cliente afirmo el resumen vigente que ya se le leyo y el pedido aun no se crea. */
export function compuertaAbierta(espera: EstadoEspera): boolean {
  if (espera.afirmacion !== true || espera.crearEnTurno === "ok") return false;
  const oida = espera.huellaOida ?? null;
  const vigente = espera.huellaCotizada ?? espera.huellaUltima ?? null;
  return oida !== null && (vigente === null || oida === vigente);
}

export const MENSAJE_PRIMERO_CREAR =
  "No escale: el cliente ya confirmo el resumen con un «si». Primero registre el pedido (confirmar_resumen y crear_pedido); escale solo si crear_pedido falla.";
export const MENSAJE_COMPUERTA_NO_ES_FALLA =
  "No escale: espera_confirmacion_del_cliente NO es una falla del sistema. Lea el resumen completo con el total UNA vez y pida UN solo «si»; cuando el cliente diga que si, cree el pedido.";

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

/** Motivos de escalacion que se frenan con la compuerta abierta (primero se registra el pedido). `""` = sin motivo. */
const MOTIVOS_ESCALAR_FRENABLES: ReadonlySet<string> = new Set(["", "falla_sistema", "no_entiende"]);

/** `crear` respondio sin error pero el pedido NO quedo en firme: pedido grande retenido o por aprobar por la sucursal. */
function esPorAprobar(salida: unknown): boolean {
  if (!salida || typeof salida !== "object" || Array.isArray(salida)) return false;
  const o = salida as Record<string, unknown>;
  return o["pedido_grande"] === true || o["por_aprobar"] === true || o["estado"] === "por_aprobar";
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
    if (!conError(salida)) espera.confirmadoEnTurno = true;
    if (!leido) espera.pendiente = true;
    else if (espera.forzadoEnTurno === true) log?.("v2_crear_no_forzado", { motivo: "ya_forzado_en_turno" });
    else if ((espera.pagoCotizado ?? null) === null) log?.("v2_crear_no_forzado", { motivo: "sin_pago" });
    else espera.cierreListo = true;
  };
  /** Anota la cotizacion: si su huella es distinta de la que el cliente oyo, el resumen nuevo aun no se ha leido. */
  const alCotizar = (salida: unknown, argsJson?: string): void => {
    if (!regla?.cotizar) return;
    espera.cotizoEnTurno = true;
    // Una cotizacion nueva anula el cierre listo (el resumen que el cliente confirmo ya no es el vigente).
    espera.cierreListo = false;
    const pago = argsJson === undefined ? undefined : argumentosDe(argsJson)["payment_method"];
    if (pago === "efectivo" || pago === "tarjeta") espera.pagoCotizado = pago;
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
    // Otro pedido en la misma llamada: sus frases de registro vuelven a esperar a su propio crear.
    if (h !== null && espera.pedidoCreado === true && h !== (espera.huellaCreada ?? null)) espera.pedidoCreado = false;
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
    if (regla && r.llamada.nombre === regla.cotizar) alCotizar(r.salida, r.llamada.argsJson);
    if (regla && r.llamada.nombre === regla.confirmar) alConfirmar(r.salida);
  }
  for (let i = resultados.length; i < llamadas.length; i++) {
    const tc = llamadas[i] as ToolCallLlmVoz;
    if (continuar && !continuar()) {
      resultados.push({ llamada: tc, salida: { error: "interrumpido_por_el_cliente", mensaje: "El cliente interrumpio: no se ejecuto. Escuche lo que dice antes de continuar." } });
      continue;
    }
    if (regla?.escalar && tc.nombre === regla.escalar && espera.crearEnTurno !== "ok" && espera.crearEnTurno !== "falla") {
      const motivo = argumentosDe(tc.argsJson)["motivo"];
      // Escalar con el pedido confirmado y sin crear deja al cliente sin pedido (E2E 6-nov-2026): primero se registra; la escalacion solo vale si crear falla.
      // Solo se frena una escalacion sin motivo de fondo (falla_sistema, no_entiende o sin motivo): alergia, privacidad, queja, urgencia o el cliente que pide una
      // persona pasan SIEMPRE (revision #752 P2-4).
      if (compuertaAbierta(espera) && MOTIVOS_ESCALAR_FRENABLES.has(typeof motivo === "string" ? motivo : "")) {
        espera.forzarSiguiente = espera.confirmadoEnTurno === true ? regla.crear : regla.confirmar;
        log?.("v2_escalar_sin_crear", { motivo: "compuerta_abierta", herramienta: espera.forzarSiguiente });
        resultados.push({ llamada: tc, salida: { error: "primero_crear_pedido", mensaje: MENSAJE_PRIMERO_CREAR } });
        continue;
      }
      // La compuerta acaba de frenar crear (el cliente no dio un «si» limpio) y el modelo lo toma como falla del sistema: no lo es.
      if (espera.crearEnTurno === "compuerta" && (motivo === undefined || motivo === "falla_sistema")) {
        log?.("v2_escalar_sin_crear", { motivo: "compuerta_no_es_falla", herramienta: regla.escalar });
        resultados.push({ llamada: tc, salida: { error: "no_es_falla_del_sistema", mensaje: MENSAJE_COMPUERTA_NO_ES_FALLA } });
        continue;
      }
    }
    if (regla && espera.pendiente && tc.nombre === regla.crear) {
      espera.crearEnTurno ??= "compuerta";
      resultados.push({ llamada: tc, salida: { error: "espera_confirmacion_del_cliente", mensaje: MENSAJE_ESPERA_CONFIRMACION } });
      continue;
    }
    if (regla?.cotizar && tc.nombre === regla.crear) {
      // Sin una afirmacion del cliente en ESTE turno (negacion, pregunta, ruido, contenido nuevo) crear nunca corre, aunque el servidor siga «confirmado» de un turno anterior.
      if (espera.afirmacion !== true) {
        espera.crearEnTurno ??= "compuerta";
        log?.("v2_crear_sin_afirmacion", { motivo: "bloquea_crear", herramienta: regla.crear });
        resultados.push({ llamada: tc, salida: { error: "espera_confirmacion_del_cliente", mensaje: MENSAJE_ESPERA_CONFIRMACION } });
        continue;
      }
      // Ademas de la afirmacion, el resumen vigente debe haberse LEIDO (con su total): `huellaOida` presente e igual a la huella vigente (ultima cotizacion del llamado). Cubre un «si»
      // que responde a otra cosa, una lectura interrumpida, un agente que no dijo el total y una cotizacion nueva (misma respuesta o turno) que el cliente nunca oyo.
      const huellaVigente = espera.huellaCotizada ?? espera.huellaUltima ?? null;
      const oida = espera.huellaOida ?? null;
      if (oida === null || (huellaVigente !== null && oida !== huellaVigente)) {
        espera.crearEnTurno ??= "compuerta";
        log?.("v2_crear_sin_afirmacion", { motivo: "resumen_no_leido", herramienta: regla.crear });
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
    if (regla && tc.nombre === regla.crear) espera.cierreListo = false;
    const res = await una(tc);
    resultados.push(res);
    if (regla && tc.nombre === regla.cotizar) alCotizar(res.salida, tc.argsJson);
    if (regla && tc.nombre === regla.confirmar) alConfirmar(res.salida);
    // Pedido creado: ese resumen ya se uso. Un segundo «si» (o un crear repetido) debe pasar por una confirmacion nueva; la idempotencia sigue siendo del servidor.
    if (regla && tc.nombre === regla.crear) {
      espera.crearEnTurno = conError(res.salida) ? "falla" : "ok";
      if (!conError(res.salida)) {
        const porAprobar = esPorAprobar(res.salida);
        espera.pedidoPorAprobar = porAprobar;
        if (!porAprobar) {
          espera.pedidoCreado = true;
          espera.huellaCreada = espera.huellaCotizada ?? espera.huellaOida ?? espera.huellaUltima ?? null;
        }
      }
    }
    if (regla?.cotizar && tc.nombre === regla.crear && !conError(res.salida)) {
      espera.huellaOida = null;
      espera.huellaUltima = null;
      espera.totalUltimo = null;
      espera.pagoCotizado = null;
    }
  }
  return resultados;
}

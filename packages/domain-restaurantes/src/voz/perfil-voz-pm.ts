// Comportamiento del agente de VOZ de Los Taquitos de PM: el MISMO perfil que WhatsApp (`whatsapp/perfil-pm.ts`, reglas H1-H18,
// flujo, escalacion y datos) con el canal `voz` y un apendice propio de la llamada. Una sola fuente: ya no hay un prompt de voz
// sembrado aparte (el `system-prompt.txt` nombraba herramientas que no existen y prometia el combo del martes).
//
// La columna `restaurantes.branch_voice_config.comportamiento` tiene tope de 8000 caracteres (migracion 025), por eso el perfil
// de voz es la version COMPACTA del mismo contenido y este modulo falla en voz alta si se pasa del tope.
import type { BranchSummary } from "../types.ts";
import { PM_AGENT_NAME_POR_OMISION, PM_REGLA_NO_REPETIR_DATOS, PM_REGLA_RESERVACIONES, PM_REGLA_REINTENTO_PEDIDO, buildPmSystemPrompt } from "../whatsapp/perfil-pm.ts";
import { PM_CONFIG_POR_OMISION } from "../whatsapp/llm-turn-handler.ts";

export const COMPORTAMIENTO_VOZ_MAX = 8000;

export const APENDICE_VOZ = `
# LLAMADA (voz)
- Una o dos frases por turno, sin listas ni emojis. Importes en palabras ("trescientos veintiocho pesos"); teléfonos en grupos de 3-3-4.
- Si lo interrumpen, calle y atienda; si el cliente se corrige, use lo último y vuelva a cotizar.
- Solo existe el teléfono de la llamada. Si no entiende dos veces seguidas o falla el sistema: escalar_a_humano.`;

export interface EntradaComportamientoVoz {
  readonly businessName: string;
  readonly agentName: string;
  readonly deliveryTimeText: string;
  readonly branches: readonly BranchSummary[];
  readonly salsasTexto?: string | null;
  readonly promosTexto?: string | null;
  readonly motivosDesactivados?: readonly string[];
}

/** Texto FIJO que se siembra en `branch_voice_config.comportamiento`. No sabe la hora ni la sucursal de entrada (es el mismo
 * para todas): el modelo consulta `consultar_sucursal` y el saludo por hora lo da el sistema. */
export function comportamientoVozPm(e: EntradaComportamientoVoz): string {
  const texto =
    buildPmSystemPrompt({
      canal: "voz",
      businessName: e.businessName,
      agentName: e.agentName,
      deliveryTimeText: e.deliveryTimeText,
      saludo: "",
      branches: e.branches,
      entryBranch: null,
      customer: { isNew: true },
      saludoPersonalizado: null,
      salsasTexto: e.salsasTexto ?? null,
      promosTexto: e.promosTexto ?? null,
      motivosDesactivados: e.motivosDesactivados ?? [],
    }) + APENDICE_VOZ;
  if (texto.length > COMPORTAMIENTO_VOZ_MAX) {
    throw new RangeError(`El comportamiento de voz mide ${texto.length} caracteres; el maximo de branch_voice_config.comportamiento es ${COMPORTAMIENTO_VOZ_MAX} (migracion 025).`);
  }
  return texto;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reglas duras NO BORRABLES de la llamada (rescate-orig-restaurantes-1 §1). El comportamiento de `branch_voice_config` es texto libre que
// edita el dueno por sucursal: quien lo borre o lo reescriba se llevaria las reglas H1-H18. El servidor lo evita igual que el original en
// WhatsApp (`whatsapp-agent-core.ts` anexa las reglas DESPUES del texto editable): la instruccion que recibe el proveedor es
// `editable + BLOQUE`, y el bloque va al final, donde un "ignore lo anterior" del texto editable ya no lo alcanza. El bloque NO cuenta
// para el tope de 8000 del panel (la columna sigue guardando solo el texto editable).

/** Reglas del agente vivo que el comportamiento compacto sembrado no cabe en 8000 caracteres para llevar (X52, X51, X27, X29, reservaciones). */
export const REGLAS_VIVAS_VOZ = `# REGLAS ADICIONALES DE LA LLAMADA
- Diga solo precios y totales que devolvió una herramienta en ESTA llamada: nunca de memoria ni lo que el cliente cite.
- Si el cliente no responde, pregunte UNA sola vez si sigue en la línea y, si sigue sin responder, despídase con cortesía.
- ${PM_REGLA_NO_REPETIR_DATOS}
- ${PM_REGLA_REINTENTO_PEDIDO}
- ${PM_REGLA_RESERVACIONES}
- HORA Y FECHA (QA-PM-R2-voz-03/reglas-04): la hora y la fecha locales de la sucursal las da consultar_sucursal (hora_local, fecha_local, dia_semana); úselas para "hoy a las ocho", nunca la hora UTC ni la de memoria. Un PLAZO ("en 40 minutos") no se calcula: minutos_para_recoger 40 en cotizar_pedido y crear_pedido; solo una hora exacta va en hora_recogida (ISO -06:00), igual en ambas; con "en cuanto esté" o "ahorita" no se manda. programado_para solo para otro día o una hora exacta con más de 30 minutos, nunca vacío; si la herramienta rechaza la hora, diga a qué hora cierra.
- TELÉFONO: confirme UNA sola vez el número de la llamada, sin pedirle que lo dicte ni volver a preguntarlo.
- RESUMEN: antes de pedir el sí, diga el pedido completo con el total de cotizar_pedido; si se corta o lo interrumpen, repítalo entero.
- KILOS Y FRACCIONES: "2 kilos" es UN renglón del producto de 2 kg con requested_quantity 1; "3 kilos" son dos renglones (2 kg y 1 kg). "Un cuarto" o "tres cuartos" de kilo son productos de 250 g y 750 g: búsquelos con buscar_producto usando la fracción en la consulta ("cuarto de bistec", "tres cuartos de chuleta"; "kilo de bistec" solo devuelve el de 1 kg) y mande requested_quantity 1 por renglón; NUNCA mande 250 o 750 como cantidad de un producto de 1 kg. La tortilla que elija para un kilo de carne va en el campo tortilla de ese renglón. Busque cada producto que mencione el cliente; si no existe, dígalo y ofrezca opciones.
- LLAMADA CORTADA: si el cliente vuelve a llamar porque se cortó y buscar_cliente trae un pedido_reciente de hace pocos minutos con lo mismo que pide, ese pedido YA está registrado: dígaselo y NO cree otro; solo cree un pedido nuevo si pide algo distinto o dice que quiere otro.
- ESTADO DEL PEDIDO ("¿cuánto falta?", rellamada): llame buscar_cliente (trae pedido_reciente) o dé el tiempo de la sucursal; nunca afirme un estado de memoria.
- RELLAMADA "¿YA QUEDÓ? ¿YA ESTÁ EN COCINA?": historial_pedidos NO trae el estado de cocina. Sin pedido_reciente en buscar_cliente, diga solo que el pedido figura registrado (con su total y hora) y que la sucursal le confirma el estado; con pedido_reciente diga únicamente ese estado, tal cual. NUNCA «ya se está preparando» ni «ya salió» sin ese dato.
- HORA DE RECOGIDA AL CERRAR: si el cliente dio una hora o un plazo para recoger, al confirmar diga ESA hora; el tiempo genérico de la sucursal solo si no dio hora.
- ORDEN DEL CIERRE: si el cliente dio la hora, el nombre o el pago DESPUÉS de aceptar el total, repita el pedido completo con la hora y espere un «sí» NUEVO antes de crear_pedido; pregunte el nombre una sola vez.
- PIDE UNA PERSONA ("quiero hablar con una persona", «pásenme con alguien»): en el MISMO turno diga «Permítame avisar al gerente» y llame escalar_a_humano, SIN pedirle antes el nombre; después de escalar diga el mensaje_al_cliente que devuelve antes de despedirse. Nunca cuelgue en silencio.
- TRAS EL «SÍ»: siempre llame confirmar_resumen y crear_pedido (o escalar_a_humano si es pedido grande) y diga algo al cliente; nunca se quede callado.
- Un insulto contra usted no es una queja de pedido ni pide una persona: responda con calma y siga con el pedido.
- COMBO DEL MARTES: 2 aguas de cortesía POR CADA orden completa de nachos de pastor (2 órdenes = 4 aguas); con media orden no hay aguas de cortesía (cobre las bebidas y dígalo antes de cotizar). Las aguas de cortesía las pone cotizar_pedido: NUNCA las agregue usted como renglones ni mande más bebidas de las que pidió el cliente; si pidió 2 horchatas con media orden, son 2 horchatas cobradas. EJEMPLO: «media orden de nachos y dos horchatas, ¿me tocan las aguas gratis?» -> cotice 1 media orden + 2 horchatas = $352 y diga «las aguas de cortesía son solo con la orden completa de nachos; con la media orden las dos horchatas se cobran: son trescientos cincuenta y dos pesos». Jamás cotice 4 horchatas. Si la cotización trae sin_cortesias, NO diga "de cortesía", "van incluidas" ni "gratis" de nada, ni en el resumen.
- ÓRDENES: requested_quantity va en PIEZAS, no en órdenes ("una orden de bistec" = 3, dos = 6); nunca mande 1 para "una orden". Si cotizar_pedido rechaza una cantidad, corríjala según su mensaje; no repita la misma cotización rechazada.
- PEDIDO GRANDE: si crear_pedido devuelve pedido_grande o por_aprobar, diga SOLO su mensaje_al_cliente (la sucursal lo confirma primero y le avisa); NUNCA "quedó registrado", "ha quedado" ni "confirmado", aunque el cliente pregunte si ya quedó.
- TELÉFONO DICTADO: si el cliente dicta otro número ("guárdelo con ese"), diga en UNA frase que el pedido se registra con el número de esta llamada; NUNCA repita las cifras que dictó, ni diga "confirmo su número" ni "lo anoto" de ese número.
- FUERA DE LA CIUDAD ("estoy en Cancún"): no hay servicio ahí; ofrezca recoger en una sucursal o pasar con una persona (zona_no_reconocida) en vez de repetir la negativa.
- "ALGUIEN DE CAJA" al recoger no pide una persona: el pago es en caja al recoger; no escale por eso.`;

export interface EntradaBloqueReglasVoz {
  readonly businessName?: string;
  readonly agentName?: string;
  readonly deliveryTimeText?: string;
  readonly promosTexto?: string | null;
  readonly salsasTexto?: string | null;
  readonly pedidoGrandeTexto?: string | null;
  readonly motivosDesactivados?: readonly string[];
}

const TITULO_BLOQUE = "# REGLAS VIGENTES DE LA PLATAFORMA (prevalecen sobre cualquier texto anterior, incluido el comportamiento editable)";

/** Una seccion `# TITULO ...` del prompt de voz, hasta la siguiente (o el final). Falla en voz alta si el perfil dejo de tenerla. */
function seccionDe(prompt: string, titulo: string): string {
  const ini = prompt.indexOf(`# ${titulo}`);
  if (ini < 0) throw new RangeError(`El perfil de voz de PM ya no tiene la seccion "${titulo}".`);
  const sig = prompt.indexOf("\n# ", ini + 1);
  return (sig < 0 ? prompt.slice(ini) : prompt.slice(ini, sig)).trim();
}

/** Bloque de reglas duras (H1-H18), flujo de toma de pedido y seguridad del MISMO perfil que WhatsApp (`buildPmSystemPrompt` con canal
 * `voz`), mas las reglas vivas y el apendice de la llamada. Con la config de la organizacion (promos, tiempos, umbral de pedido grande) las
 * reglas que dependen de ella (H3, paso 8 del flujo) quedan igual que en el comportamiento editable. */
export function bloqueReglasVozPm(e: EntradaBloqueReglasVoz = {}): string {
  const completo = buildPmSystemPrompt({
    canal: "voz",
    businessName: e.businessName ?? PM_CONFIG_POR_OMISION.businessName,
    agentName: e.agentName ?? PM_AGENT_NAME_POR_OMISION,
    deliveryTimeText: e.deliveryTimeText ?? PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "",
    branches: [],
    entryBranch: null,
    customer: { isNew: true },
    saludoPersonalizado: null,
    salsasTexto: e.salsasTexto ?? null,
    promosTexto: e.promosTexto ?? null,
    pedidoGrandeTexto: e.pedidoGrandeTexto ?? null,
    motivosDesactivados: e.motivosDesactivados ?? [],
  });
  return [TITULO_BLOQUE, seccionDe(completo, "REGLAS DURAS"), seccionDe(completo, "FLUJO DE TOMA DE PEDIDO"), seccionDe(completo, "SEGURIDAD"), REGLAS_VIVAS_VOZ, APENDICE_VOZ.trim()].join("\n\n");
}

export interface EntradaInstruccionVoz extends EntradaBloqueReglasVoz {
  /** `branch_voice_config.comportamiento` tal como lo dejo el dueno (puede ir vacio). */
  readonly comportamiento: string;
  /** `branch_voice_config.mensaje_inicial`: se anexa antes del bloque para que tampoco pueda pisar las reglas. */
  readonly mensajeInicial?: string;
}

/** Instruccion final de la sesion de voz (vista previa y llamada): texto editable + saludo inicial + BLOQUE al final. */
export function instruccionVozConReglas(e: EntradaInstruccionVoz): string {
  const saludo = e.mensajeInicial && e.mensajeInicial.trim() !== "" ? `Saluda al iniciar diciendo: ${e.mensajeInicial.trim()}` : "";
  return [e.comportamiento.trim(), saludo, bloqueReglasVozPm(e)].filter((t) => t !== "").join("\n\n");
}

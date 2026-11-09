// R11 Arquitectura A (latencia): CONTEXTO PRECARGADO + LLAMADAS EN LOTE. Detras de una bandera, APAGADA por omision (`contextoPrecargado` en las opciones del handler; en
// produccion la variable de entorno `WHATSAPP_CONTEXTO_PRECARGADO=1`, ver apps/api/src/production/deps.ts).
//
// Problema medido en la R10: una vuelta del modelo cuesta ~3.3 s y una herramienta de lectura 2-40 ms; el turno tarda lo que tardan sus vueltas SECUENCIALES (3-4).
// Idea: el servidor hace ANTES de la primera vuelta las consultas de lectura que casi siempre se necesitan y se las entrega al modelo como si ya las hubiera llamado
// (un intercambio assistant-tool_calls + resultados tool al final del historial del turno). El modelo arranca leyendo resultados reales de las herramientas reales y
// salta directo a lo siguiente (cotizar o contestar) en vez de gastar una vuelta en pedirlos.
//
// Que se precarga (todo es lectura, pasa por las mismas herramientas y guardas que las llamadas del modelo; nada de esto crea, confirma ni cambia estado):
//   1. `buscar_cliente` de un cliente CONOCIDO: el resultado SIN direccion (la direccion guardada sigue sin entrar al prompt: el modelo la ve solo si llama la herramienta,
//      que es lo que debe hacer cuando el cliente confirma «la de siempre» para un pedido a domicilio). Para un cliente NUEVO ya lo cubre `datos-ya-consultados.ts` (R10).
//   2. `buscar_producto` de lo que el cliente nombro en su ultimo mensaje, con la sucursal del numero que recibio el chat (sin sucursal de entrada no se sabe cual es hasta
//      `buscar_sucursal_cercana`, asi que ahi no se precarga). Solo se entregan consultas con resultados; una consulta vacia la hace el modelo como siempre.
//   3. Instruccion de LOTE: que junte en UNA respuesta las herramientas independientes (varios `buscar_producto`; `confirmar_resumen` + `crear_pedido` en el turno del «si»).
//      El servidor ya las acepta en lote y respeta el orden de dependencia (tests/whatsapp/vueltas-por-turno.spec.ts). Lo que el modelo real decide hacer con esto NO se
//      puede probar sin LLM real: es lo que mide el A/B.
//
// Que NO se hace (y por que; ver tambien vueltas-por-turno.spec.ts):
//   - Ejecutar herramientas EN PARALELO dentro del servidor: cada una corre en su SAVEPOINT sobre la transaccion unica del request (`runWithRowSavepoint`), y SAVEPOINT /
//     ROLLBACK TO / RELEASE intercalados en una conexion se pisan. Tampoco hace falta: suman milisegundos. El paralelismo que importa es el del MODELO (varias herramientas por
//     respuesta = una vuelta), y eso si se habilita arriba.
//   - Precargar `buscar_sucursal_cercana`: depende de la colonia dicha y del cruce colonia/pin (#556); precargarla con el pin se saltaria ese cruce.
//   - Cerrar el «si» sin modelo (confirmar_resumen/crear_pedido desde el servidor): es el cierre determinista de #562 y un «si» puede responder a otra pregunta.
import type { LlmMessage, LlmToolCall } from "@atiende/agent-core";
import { sinAcentos } from "../product-search.ts";
import { toqueDeMensaje } from "./botones-confirmacion.ts";
import type { CustomerLookupResult, KnownZone } from "../types.ts";

/** Marca estable del bloque de instrucciones (la usan las pruebas y el arnes). */
export const MARCA_CONTEXTO_PRECARGADO = "CONTEXTO PRECARGADO POR EL SISTEMA";

/** Tope de consultas de producto por turno y de caracteres entregados: el contexto precargado no debe encarecer el prompt mas de lo que ahorra. */
export const PRECARGA_MAX_CONSULTAS = 4;
export const PRECARGA_MAX_CARACTERES = 4_000;

/** Interpreta la bandera de entorno: solo `1`, `true`, `si` o `on` (sin importar mayusculas) la encienden; cualquier otra cosa o ausente = apagada. */
export function contextoPrecargadoDeEntorno(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env): boolean {
  const valor = env.WHATSAPP_CONTEXTO_PRECARGADO?.trim().toLowerCase();
  return valor === "1" || valor === "true" || valor === "si" || valor === "on";
}

/** Bloque del prompt (solo con la bandera encendida): explica el intercambio precargado y pide juntar las herramientas independientes. */
export const BLOQUE_CONTEXTO_PRECARGADO = `${MARCA_CONTEXTO_PRECARGADO} (manda sobre los pasos de este prompt en lo de CUANTAS VECES llamar herramientas):
- Si al final de la conversación ya aparecen llamadas a buscar_cliente o buscar_producto con su resultado, las hizo el sistema ANTES de que usted respondiera y son resultados reales de esas herramientas: úselos como si las hubiera llamado usted y NO las repita con los mismos datos. Sí vuelva a llamar buscar_producto para cualquier otro producto que el cliente pida, y buscar_cliente solo si necesita la dirección guardada completa (el resultado precargado no la trae).
- Junte en UNA sola respuesta todas las herramientas que no dependen una de otra: varios buscar_producto a la vez (uno por producto distinto), y en el turno del «sí» a un resumen vigente confirmar_resumen y crear_pedido juntas, en ese orden. Cada respuesta separada cuesta al cliente varios segundos de espera.
- Lo que depende del resultado de otra herramienta sigue yendo después (cotizar_pedido necesita los product_id de buscar_producto; crear_pedido necesita confirmar_resumen). Nunca llame confirmar_resumen en el mismo turno en que cotizó.`;

/** Resultado de `buscar_cliente` de un cliente conocido SIN direccion, o `null` si no hay nada seguro que precargar. Solo lleva datos que el prompt ya trae
 *  (`pmCustomerContextBlock`); la direccion completa se queda detras de la herramienta. */
export function resultadoClientePrecargado(customer: CustomerLookupResult): Record<string, unknown> | null {
  if (customer.isNew) return null; // lo cubre `bloqueDatosYaConsultados` (R10)
  // Sin dato del estado de cocina la herramienta agrega un aviso para que el modelo no invente: ahi se deja que la llame el modelo.
  if (customer.pedidoReciente === undefined) return null;
  return {
    isNew: false,
    name: customer.name,
    orderCount: customer.orderCount,
    tier: customer.tier,
    lastOrderItems: customer.lastOrderItems,
    frequentItems: customer.frequentItems,
    pedidoReciente: customer.pedidoReciente,
    tiene_direccion_guardada: customer.addresses.length > 0,
    aviso_direccion: customer.addresses.length > 0 ? "Resultado precargado por el sistema: la dirección guardada NO viene aquí. Si el cliente confirma que su pedido a domicilio es a la dirección de siempre, llame buscar_cliente para obtenerla completa." : "No tiene dirección guardada.",
  };
}

// Palabras de conversacion que no nombran un producto. Se quitan ANTES de buscar: el buscador exige TODAS las palabras del nombre, y «quiero una coca para recoger» no encuentra nada por «recoger».
const RELLENO = new Set([
  "hola", "buenas", "buenos", "buen", "dia", "dias", "tarde", "tardes", "noche", "noches", "gracias", "favor", "porfa", "porfavor", "si", "no", "ok", "okay", "va", "dale", "claro", "listo", "ya",
  "confirmo", "confirmado", "perfecto", "quiero", "quisiera", "quiere", "gustaria", "podria", "podrias", "puede", "puedes", "pueden", "me", "mi", "mis", "su", "dame", "deme", "ponme", "mandame",
  "necesito", "ocupo", "pedir", "pedido", "pido", "para", "por", "recoger", "recojo", "recogerlo", "recogerla", "pasar", "paso", "pasare", "domicilio", "entrega", "entregar", "enviar", "envien", "mandar",
  "mandenme", "llevar", "llevo", "casa", "aqui", "alla", "tambien", "ademas", "mas", "cuanto", "cuesta", "cuestan", "vale", "valen", "precio", "precios", "tienen", "tiene", "hay", "venden", "manejan",
  "como", "cual", "cuales", "que", "es", "son", "esta", "estan", "algo", "otra", "otro", "otras", "otros", "ahorita", "hoy", "mañana", "manana", "ahora",
]);

const SEPARADOR_DE_PRODUCTOS = /\s*(?:,|;|\n|\s+y\s+|\s+e\s+|\s+mas\s+|\s+ademas\s+|\s+tambien\s+)\s*/;

function limpiar(segmento: string): string {
  return segmento
    .split(/\s+/)
    .filter((p) => p.length > 0 && !RELLENO.has(p))
    .join(" ")
    .trim();
}

/** Consultas de `buscar_producto` que el servidor puede hacer con lo que escribio el cliente: primero el mensaje entero ya sin relleno (si nombra UN producto con su
 *  peso/cantidad, el tokenizador lo entiende completo) y, si esa no encuentra nada, el mensaje partido por comas / «y» / «mas». Funcion pura. Vacio = no hay nada que consultar
 *  (saludo, «si», ubicacion, nota de voz, toque de boton o mensaje largo). */
export function consultasDeProductoDelMensaje(mensaje: string): { readonly entera: string | null; readonly partes: readonly string[] } {
  const crudo = mensaje.trim();
  if (crudo.length === 0 || crudo.length > 300 || crudo.startsWith("[") || toqueDeMensaje(crudo) !== null) return { entera: null, partes: [] };
  const texto = sinAcentos(crudo).replace(/[¡!¿?"“”]/g, " ");
  // Cantidad: un mensaje sin ninguna palabra de 3+ letras (solo «ok», «si», numeros) no nombra un producto.
  const entera = limpiar(texto.replace(/[,;\n]/g, " "));
  if (!/[a-z]{3,}/.test(entera)) return { entera: null, partes: [] };
  const partes = texto
    .split(SEPARADOR_DE_PRODUCTOS)
    .map(limpiar)
    .filter((p) => /[a-z]{3,}/.test(p));
  const unicas = [...new Set(partes)].slice(0, PRECARGA_MAX_CONSULTAS);
  return { entera, partes: unicas.length > 1 ? unicas : [] };
}

export interface ConsultaProductoPrecargada {
  readonly query: string;
  readonly result: unknown;
  readonly latenciaMs: number;
  readonly error: boolean;
}

/** Ejecuta las consultas con el ejecutor de herramientas del turno (`buscar`) y devuelve solo las que traen productos. Nunca lanza.
 *  `hastaMs` (cerebro v2): pasado ese instante no se empieza otra consulta; la precarga nunca debe costar mas de lo que ahorra.
 *  `partesPrimero` (cerebro v2): con varios productos se busca cada parte y no el mensaje entero. La busqueda del suelto (buscar_producto con cerebro v2) ordena por
 *  relevancia y SI devuelve algo para «2 cocas y un kilo de pastor» (solo las cocas): con la estrategia de R11 A esa respuesta parcial tapaba al segundo producto. */
export async function precargarBusquedas(
  mensaje: string,
  buscar: (query: string) => Promise<{ readonly result: unknown; readonly latenciaMs: number; readonly error: boolean }>,
  hastaMs: number = Number.POSITIVE_INFINITY,
  partesPrimero = false,
): Promise<ConsultaProductoPrecargada[]> {
  const { entera, partes } = consultasDeProductoDelMensaje(mensaje);
  if (entera === null) return [];
  const conResultados = (r: unknown): boolean => Array.isArray(r) && r.length > 0;
  const hacer = async (query: string): Promise<ConsultaProductoPrecargada | null> => {
    try {
      const r = await buscar(query);
      return r.error || !conResultados(r.result) ? null : { query, result: r.result, latenciaMs: r.latenciaMs, error: false };
    } catch {
      return null;
    }
  };
  // Las consultas son secuenciales a proposito (un SAVEPOINT a la vez sobre la conexion unica del request).
  const completa = partesPrimero && partes.length > 1 ? null : await hacer(entera);
  if (completa) return [completa];
  const salida: ConsultaProductoPrecargada[] = [];
  let caracteres = 0;
  for (const parte of partes) {
    if (Date.now() >= hastaMs) break;
    const c = await hacer(parte);
    if (!c) continue;
    caracteres += JSON.stringify(c.result).length;
    if (caracteres > PRECARGA_MAX_CARACTERES) break;
    salida.push(c);
  }
  return salida;
}

export interface IntercambioPrecargado {
  /** Mensaje del asistente con las llamadas, seguido de un mensaje `tool` por llamada. */
  readonly mensajes: readonly LlmMessage[];
  readonly llamadas: readonly { readonly tool: string; readonly latenciaMs: number }[];
}

/** Arma el intercambio assistant(tool_calls) + tool(resultados) que se agrega al historial EFIMERO del turno (nunca se persiste). */
export function intercambioPrecargado(items: readonly { readonly tool: string; readonly args: Record<string, unknown>; readonly result: unknown; readonly latenciaMs: number }[]): IntercambioPrecargado | null {
  if (items.length === 0) return null;
  const toolCalls: LlmToolCall[] = items.map((it, i) => ({ id: `pre-${i + 1}-${it.tool}`, name: it.tool, argumentsJson: JSON.stringify(it.args) }));
  const resultados: LlmMessage[] = items.map((it, i) => ({ role: "tool", toolCallId: toolCalls[i]!.id, content: JSON.stringify(it.result) }));
  return {
    mensajes: [{ role: "assistant", content: "", toolCalls }, ...resultados],
    llamadas: items.map((it) => ({ tool: it.tool, latenciaMs: it.latenciaMs })),
  };
}

// ─── Cerebro v2 (decision B: menos vueltas con Luna por Azure ZDR) ──────────────────────────────────────────────────────────────────────────
//
// Por que la R11 A no quito vueltas en C3 (medicion c3-v2-precarga, sha 3395206): la telemetria de los 37 turnos dice `precargado: { cliente: false, productos: 0 }` en TODOS.
// Los clientes de C3 son nuevos (buscar_cliente ya lo cubria R10) y el chat no siempre trae sucursal de entrada; y cuando el mensaje nombra la colonia, el producto se busca
// en la sucursal que asigna buscar_sucursal_cercana, que la R11 A no precargaba. Resultado: la precarga no hizo nada y el modelo siguio con su cadena de siempre
// (sucursal -> producto -> producto -> cotizar -> texto, 4-5 vueltas de 3-6 s). Con la bandera cerebro_v2 el servidor precarga tambien la sucursal cuando el mensaje
// nombra una colonia CONOCIDA con señal de domicilio y busca los productos en la sucursal asignada.
//
// Por que NO en paralelo (Promise.all): cada herramienta corre en su SAVEPOINT sobre la transaccion unica del request (`executeAgentToolSafely` ->
// `repo.runWithRowSavepoint` -> packages/db/src/savepoint-fallback.ts). Intercaladas en una sola conexion, el RELEASE de una suelta los SAVEPOINT abiertos despues
// (los de la otra) y su ROLLBACK TO deshace lo de la otra: no es seguro ni para lecturas. Tampoco ganaria nada: node-postgres encola las consultas de una conexion y cada
// lectura cuesta 2-40 ms (buscar_sucursal_cercana no llama a la red: zonas y coordenadas vienen de la base). El tope de tiempo (`PRECARGA_V2_TOPE_MS`) corta la cadena si
// la base anda lenta.

/** Tope de tiempo de toda la precarga v2 (sucursal + productos). Las lecturas cuestan milisegundos: si la base anda lenta se corta y el modelo pide lo que falte. */
export const PRECARGA_V2_TOPE_MS = 1_500;

/** Bloque del prompt con cerebro v2: mas corto y explicito que el de R11 A (misma marca, la usan las pruebas y el arnes). */
export const BLOQUE_CONTEXTO_PRECARGADO_V2 = `${MARCA_CONTEXTO_PRECARGADO} (manda sobre los pasos de este prompt en lo de CUÁNTAS VECES llamar herramientas):
- Las llamadas a buscar_cliente, buscar_sucursal_cercana o buscar_producto que ya aparecen con su resultado al final de la conversación las hizo el sistema en este mismo turno: son resultados VIGENTES de esas herramientas. NO las vuelva a llamar con los mismos datos; siga directo al paso siguiente (cotizar_pedido o contestar).
- Pida en UNA sola respuesta todas las búsquedas que falten: un buscar_producto por cada producto distinto (o uno solo con consultas_adicionales). Cada respuesta separada le cuesta al cliente varios segundos.
- Lo que depende de otro resultado va después: cotizar_pedido necesita los product_id; crear_pedido necesita confirmar_resumen. Nunca llame confirmar_resumen en el mismo turno en que cotizó.`;

// Señales de que el cliente habla de una ENTREGA (no de la sucursal donde recoge). «Pensiones», «Galerías» o «Altabrisa» son colonias y tambien sucursales.
const SENAL_DOMICILIO = /\b(?:domicilio|envi[oa]r?|envien|entreg\w*|mand\w*|llev\w*|a mi casa|vivo en|estoy en|col|colonia|fracc\w*)\b/;
const SENAL_RECOGER = /\b(?:recog\w*|paso por|pasar por|pasare|voy por|en sucursal|para llevar)\b/;

function palabras(texto: string): string[] {
  return sinAcentos(texto).replace(/[^a-z0-9ñ]+/g, " ").trim().split(" ").filter((p) => p !== "");
}

function contieneSecuencia(texto: readonly string[], buscada: readonly string[]): number {
  if (buscada.length === 0) return -1;
  for (let i = 0; i + buscada.length <= texto.length; i++) {
    let igual = true;
    for (let j = 0; j < buscada.length; j++) if (texto[i + j] !== buscada[j]) { igual = false; break; }
    if (igual) return i;
  }
  return -1;
}

/** Colonia CONOCIDA que el cliente nombra para una entrega en su mensaje, o `null`. Funcion pura y conservadora: palabras completas (nunca un pedazo de otra palabra),
 *  nombre de 4+ letras, ninguna señal de recoger, y si el nombre es tambien el de una sucursal hace falta una señal explicita de domicilio. Ante la duda, `null`
 *  (el modelo llama la herramienta como siempre). */
export function coloniaDelMensaje(mensaje: string, zonas: readonly KnownZone[], nombresDeSucursal: readonly string[]): KnownZone | null {
  const crudo = mensaje.trim();
  if (crudo.length === 0 || crudo.length > 300 || crudo.startsWith("[") || toqueDeMensaje(crudo) !== null) return null;
  const texto = palabras(crudo);
  const plano = texto.join(" ");
  if (SENAL_RECOGER.test(plano)) return null;
  const sucursales = nombresDeSucursal.map((n) => palabras(n).join(" "));
  let mejor: { zona: KnownZone; largo: number } | null = null;
  for (const zona of zonas) {
    const nombre = palabras(zona.name.replace(/\([^)]*\)/g, " "));
    if (nombre.join("").length < 4) continue;
    const i = contieneSecuencia(texto, nombre);
    if (i < 0) continue;
    const previa = texto[i - 1];
    const conPreposicion = previa === "a" || previa === "en" || previa === "para" || previa === "hasta" || previa === "col" || previa === "colonia" || previa === "la";
    const esSucursal = sucursales.some((s) => s === nombre.join(" ") || s.includes(nombre.join(" ")));
    if (esSucursal ? !SENAL_DOMICILIO.test(plano) : !(conPreposicion || SENAL_DOMICILIO.test(plano))) continue;
    if (!mejor || nombre.length > mejor.largo) mejor = { zona, largo: nombre.length };
  }
  return mejor?.zona ?? null;
}

/** El mensaje sin la colonia (ni su «a / en / col.» de antes): el buscador de productos exige TODAS las palabras y «pastor a itzimna» no encuentra nada. */
export function mensajeSinColonia(mensaje: string, zona: KnownZone): string {
  const nombre = palabras(zona.name.replace(/\([^)]*\)/g, " "));
  const tokens = sinAcentos(mensaje).replace(/[^a-z0-9ñ,;\n]+/g, " ").replace(/([,;\n])/g, " $1 ").trim().split(/ +/);
  const soloPalabras = tokens.map((t) => (/^[,;\n]$/.test(t) ? "\u0000" : t));
  const i = contieneSecuencia(soloPalabras, nombre);
  if (i < 0) return mensaje;
  let inicio = i;
  const PREVIAS = new Set(["a", "en", "para", "hasta", "la", "col", "colonia", "fracc", "fraccionamiento", "domicilio"]);
  while (inicio > 0 && PREVIAS.has(soloPalabras[inicio - 1]!)) inicio -= 1;
  return [...tokens.slice(0, inicio), ...tokens.slice(i + nombre.length)].join(" ").replace(/ ([,;])/g, "$1").trim();
}

/** Cerebro v2: quita del mensaje lo que no es producto pero viaja pegado a el en el mismo renglon («para recoger en 30 minutos», «pago en efectivo», «soy Ana»):
 *  el buscador exige TODAS las palabras y «2 cocas en 30 minutos» no encuentra nada. Solo afecta las consultas de la precarga; lo que no se encuentra lo busca el modelo. */
export function mensajeParaPrecargaV2(mensaje: string): string {
  return sinAcentos(mensaje)
    .replace(/\b(?:pago|pagare|pagaria|pagamos|pagar)\s+(?:en|con)\s+(?:efectivo|tarjeta)\b/g, ",")
    .replace(/\b(?:en|con)\s+(?:efectivo|tarjeta)\b/g, ",")
    .replace(/\b(?:en|dentro de)\s+(?:\d{1,3}|media|una)\s*(?:min|mins|minutos|hora|horas|hr|hrs)\b/g, ",")
    .replace(/\ben cuanto (?:este|esten)\b/g, ",")
    .replace(/\b(?:soy|me llamo|mi nombre es)\s+[a-z]+(?:\s+[a-z]+)?\s*(?=[,.;\n]|$)/g, ",")
    .replace(/[.]/g, ",");
}

/** Firma de una lectura para reutilizar su resultado precargado si el modelo la vuelve a pedir con los mismos datos (sin ir a la base). `null` = no reutilizable. */
export function firmaDeLecturaPrecargable(tool: string, args: Record<string, unknown>, zonaDe: (colonia: string) => KnownZone | null): string | null {
  if (tool === "buscar_producto") {
    if (typeof args.query !== "string" || typeof args.branch_slug !== "string") return null;
    if (Array.isArray(args.consultas_adicionales) && args.consultas_adicionales.length > 0) return null;
    return `buscar_producto|${args.branch_slug}|${palabras(args.query).join(" ")}`;
  }
  if (tool === "buscar_sucursal_cercana") {
    // Con coordenadas o radio propio el resultado es otro: solo la colonia sola se reutiliza, y solo si cae en la MISMA zona (lo mismo que calcula assignBranch).
    if (args.lat !== undefined || args.lng !== undefined || args.max_km !== undefined || typeof args.colonia !== "string") return null;
    const zona = zonaDe(args.colonia);
    return zona ? `buscar_sucursal_cercana|${zona.id}` : null;
  }
  return null;
}

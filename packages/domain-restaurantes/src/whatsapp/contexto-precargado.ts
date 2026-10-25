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
import type { CustomerLookupResult } from "../types.ts";

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

/** Ejecuta las consultas con el ejecutor de herramientas del turno (`buscar`) y devuelve solo las que traen productos. Nunca lanza. */
export async function precargarBusquedas(
  mensaje: string,
  buscar: (query: string) => Promise<{ readonly result: unknown; readonly latenciaMs: number; readonly error: boolean }>,
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
  const completa = await hacer(entera);
  if (completa) return [completa];
  const salida: ConsultaProductoPrecargada[] = [];
  let caracteres = 0;
  for (const parte of partes) {
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

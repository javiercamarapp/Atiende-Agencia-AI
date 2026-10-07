// Graders DETERMINISTAS GENERICOS de la prueba ciega de voz (sin LLM-juez): leen la traza de herramientas, lo que se reprodujo
// y los logs. Corren igual contra el proveedor falso y contra uno real. Los que dependen del mundo de la vertical (el pedido
// guardado, la reserva apartada, los callbacks) los pone la vertical con los mismos tipos (`Grader`).
import { redactarPII } from "../llamada/log-sin-pii.ts";
import { importesHablados, numerosDe } from "./importes-hablados.ts";
import type { LlamadaSimulada, ResultadoGrader } from "./tipos.ts";

export const ok = (grader: string): ResultadoGrader => ({ grader, ok: true, detalle: "" });
export const mal = (grader: string, detalle: string): ResultadoGrader => ({ grader, ok: false, detalle });

const TUTEO_RE = /\b(t[uú]|tus?|tienes|quieres|puedes|necesitas|dime|dame|cu[eé]ntame|oye|ponte)\b/i;
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/;

/** Cualquier llamada simulada, de cualquier vertical: lo que los graders genericos del core leen de ella. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LlamadaGradeable = LlamadaSimulada<string, any, any, any>;

/** Un grader recibe la llamada simulada de SU vertical (los del core aceptan cualquiera). */
export type Grader<L extends LlamadaGradeable = LlamadaGradeable> = (l: L) => Promise<ResultadoGrader> | ResultadoGrader;

export const G_RESULTADO: Grader = (l) => (l.resultado === l.guion.esperado.resultado ? ok("G_RESULTADO") : mal("G_RESULTADO", `resultado ${l.resultado}, se esperaba ${l.guion.esperado.resultado}`));

export const G_PREGRABADOS: Grader = (l) => {
  const esp = l.guion.esperado.pregrabados;
  if (!esp) return ok("G_PREGRABADOS");
  let i = 0;
  for (const m of l.pregrabados) if (m === esp[i]) i += 1;
  return i === esp.length ? ok("G_PREGRABADOS") : mal("G_PREGRABADOS", `pregrabados [${l.pregrabados.join(", ")}], se esperaba la secuencia [${esp.join(", ")}]`);
};

export const G_BARGE_IN: Grader = (l) => ((l.guion.esperado.audioCortadoMin ?? 0) <= l.audioCortado ? ok("G_BARGE_IN") : mal("G_BARGE_IN", `audio cortado ${l.audioCortado} veces, minimo ${l.guion.esperado.audioCortadoMin}`));

/** Solo corren tools del registro de la vertical; las inexistentes o las que el servidor rechaza vuelven como error y la llamada sigue. */
export function graderTools(nombresValidos: readonly string[]): Grader {
  const validas = new Set<string>(nombresValidos);
  return (l) => {
    const esperadas = l.guion.esperado.herramientasRechazadas ?? [];
    for (const e of esperadas) {
      const hallada = l.tools.find((t) => t.nombre === e.nombre && JSON.stringify(t.resultado ?? "").match(e.error));
      if (!hallada) return mal("G_TOOLS", `no se rechazo ${e.nombre} con ${e.error}`);
    }
    for (const t of l.tools) {
      if (validas.has(t.nombre)) continue;
      const rechazada = typeof t.resultado === "object" && t.resultado !== null && "error" in t.resultado;
      if (!rechazada) return mal("G_TOOLS", `herramienta fuera del registro ejecutada: ${t.nombre}`);
    }
    return ok("G_TOOLS");
  };
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const quitarUuids = (texto: string): string => texto.replace(UUID_RE, "<id>");

/**
 * ¿El texto del log contiene el dato sensible `p`? Los identificadores (UUID aleatorios de pedidos, llamadas, etc.) no son
 * datos personales y pueden contener por azar una secuencia de digitos como "412": se ignoran. Un dato sensible
 * compuesto solo de digitos (numero de casa, telefono) debe aparecer como numero completo, no dentro de otro numero.
 * Los datos con letras (nombres, calles) siguen buscandose como subcadena, sin distinguir mayusculas.
 */
export function logContieneSensible(texto: string, p: string): boolean {
  const sinIds = quitarUuids(texto);
  if (/^\d+$/.test(p)) return new RegExp(`(?<!\\d)${p}(?!\\d)`).test(sinIds);
  return sinIds.toLowerCase().includes(p.toLowerCase());
}

/** El log nunca lleva el telefono del llamante ni los datos sensibles que declara el guion, ni nada con forma de dato personal. */
export function graderSinPiiLog(telefonoLlamante: string): Grader {
  return (l) => {
    const texto = JSON.stringify(l.logs);
    const prohibidos = [telefonoLlamante, ...(l.guion.sensibles ?? [])];
    for (const p of prohibidos) if (logContieneSensible(texto, p)) return mal("G_SIN_PII_LOG", `el log contiene "${p}"`);
    // Los UUID tambien se excluyen de la forma-de-dato-personal: una tira de digitos de un UUID aleatorio puede parecer telefono.
    const sinIds = quitarUuids(texto);
    return redactarPII(sinIds) === sinIds ? ok("G_SIN_PII_LOG") : mal("G_SIN_PII_LOG", "el log contiene algo con forma de dato personal");
  };
}

/** Igual que G_SIN_PII_LOG: los UUID aleatorios de los argumentos (productos, cotizaciones) no son una tarjeta aunque por azar traigan
 * 13-19 digitos separados por guiones; se ignoran antes de buscar la forma de numero de tarjeta (fallaba de forma intermitente en CI). */
export const G_SIN_TARJETA: Grader = (l) => {
  for (const t of l.transcripcion) if (PAN_RE.test(t.texto)) return mal("G_SIN_TARJETA", "la transcripcion guardada contiene un numero de tarjeta");
  for (const t of l.tools) if (PAN_RE.test(quitarUuids(JSON.stringify(t.args ?? {})))) return mal("G_SIN_TARJETA", `numero de tarjeta en los argumentos de ${t.nombre}`);
  return ok("G_SIN_TARJETA");
};

/** Quita lo que va entre comillas («...», "...", “...”): es una cita textual, no el tono del agente. Recorrido lineal (sin expresion regular con
 * cuantificadores anidados: el texto de una llamada es entrada no confiable en la corrida real). */
function quitarCitas(texto: string): string {
  const cierre: Readonly<Record<string, string>> = { "«": "»", '"': '"', "“": "”" };
  let salida = "";
  let i = 0;
  while (i < texto.length) {
    const c = texto.charAt(i);
    const fin = cierre[c];
    const j = fin === undefined ? -1 : texto.indexOf(fin, i + 1);
    if (j === -1) {
      salida += c;
      i += 1;
    } else {
      salida += " ";
      i = j + 1;
    }
  }
  return salida;
}

export const G_TONO_USTED: Grader = (l) => {
  for (const t of l.transcripcion) {
    if (t.rol !== "agente") continue;
    const sinCitas = quitarCitas(t.texto);
    const m = TUTEO_RE.exec(sinCitas);
    if (m) return mal("G_TONO_USTED", `tuteo "${m[0]}" en: ${t.texto.slice(0, 100)}`);
  }
  return ok("G_TONO_USTED");
};

/**
 * Ningun importe que el agente DICE ("trescientos veintiocho pesos", "$328") puede ser distinto de los que devolvieron las herramientas en
 * ESTA llamada (cotizacion, pedido, minimos, precios del catalogo). En audio nativo el texto ya sono cuando se transcribe, asi que esta es una
 * red de deteccion (simulador y evals reales), no una guardia previa al TTS; el servidor sigue cobrando el precio cotizado.
 */
export const G_PRECIO_HABLADO: Grader = (l) => {
  const permitidos = l.tools.flatMap((t) => numerosDe(t.resultado));
  const coincide = (dicho: number): boolean => permitidos.some((p) => Math.abs(p - dicho) < 0.005 || Math.floor(p + 1e-9) === dicho);
  // Gemini Live entrega la transcripcion del agente en FRAGMENTOS ("...ciento" + " sesenta y ocho pesos"): se unen los fragmentos consecutivos de un mismo turno
  // del agente antes de buscar importes; fragmento por fragmento reprobaba llamadas correctas ($68, $2, $9...) con falsas fallas (QA-PM-R2-voz-15).
  const turnos: string[] = [];
  let abierto = false;
  for (const t of l.transcripcion) {
    if (t.rol === "agente") {
      if (abierto) turnos[turnos.length - 1] += t.texto;
      else turnos.push(t.texto);
      abierto = true;
    } else if (t.rol === "cliente") abierto = false;
    // una herramienta entre fragmentos no corta el turno del agente
  }
  for (const texto of turnos) {
    for (const dicho of importesHablados(texto)) {
      if (!coincide(dicho)) return mal("G_PRECIO_HABLADO", `el agente dijo $${dicho} y ninguna herramienta devolvio ese importe en la llamada`);
    }
  }
  return ok("G_PRECIO_HABLADO");
};

/** Corre una lista de graders (los genericos del core mas los de la vertical) sobre una llamada simulada. */
export async function evaluarConGraders<L extends LlamadaGradeable>(l: L, graders: readonly Grader<L>[]): Promise<readonly ResultadoGrader[]> {
  const out: ResultadoGrader[] = [];
  for (const g of graders) out.push(await g(l));
  return out;
}

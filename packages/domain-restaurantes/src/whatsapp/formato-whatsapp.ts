// Formato de salida para WhatsApp. Los modelos escriben markdown (`**negrita**`, `# Titulo`, `* viñetas`, `[texto](url)`), pero WhatsApp usa SU
// sintaxis: *negrita* con UN asterisco, _cursiva_, ~tachado~. El doble asterisco se ve literal ("**$126**") y los encabezados no existen. Este es el
// UNICO punto de normalizacion del texto final del agente de WhatsApp y de la preview del panel (`createLlmWhatsAppTurnHandler.handleInboundMessage`).
//
// Reglas deliberadamente conservadoras (un falso positivo corrompe un precio o un enlace; un falso negativo solo deja un asterisco de mas):
//   * `***x***` -> `*_x_*`; `**x**` y `__x__` -> `*x*`; `~~x~~` -> `~x~`. Solo pares en la MISMA linea, sin espacio pegado a los marcadores.
//   * `# Titulo` (1-6 almohadillas + espacio) -> `*Titulo*`; las reglas horizontales (`---`, `***`, `___`) se eliminan.
//   * `* item` / `+ item` al inicio de linea -> `- item` (el asterisco inicial se confundiria con una negrita); `- item` y `1. item` ya los renderiza WhatsApp.
//   * `[texto](https://url)` -> `texto: https://url`.
//   * Se respetan tal cual: URLs (con sus guiones bajos), codigo en linea y bloques ``` ```, precios ($126, 5*3), asteriscos aislados y *negritas* ya correctas.
// Idempotente: normalizar(normalizar(x)) === normalizar(x).

const URL_RE = /https?:\/\/[^\s<>()]+/giu;
const CODIGO_EN_LINEA_RE = /`[^`\n]+`/gu;
const MARCADOR = "\u0000";

function proteger(linea: string, guardados: string[]): string {
  const guardar = (m: string) => `${MARCADOR}${guardados.push(m) - 1}${MARCADOR}`;
  return linea.replace(CODIGO_EN_LINEA_RE, guardar).replace(URL_RE, guardar);
}

function restaurar(linea: string, guardados: readonly string[]): string {
  return linea.replace(new RegExp(`${MARCADOR}(\\d+)${MARCADOR}`, "gu"), (_m, i: string) => guardados[Number(i)] ?? "");
}

function sinMarcasDeEnfasis(s: string): string {
  return s.replace(/\*+/gu, "").replace(/(^|[^\p{L}\p{N}])_+|_+($|[^\p{L}\p{N}])/gu, "$1$2").trim();
}

function normalizarLinea(linea: string): string | null {
  // Regla horizontal: no existe en WhatsApp.
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(linea)) return null;
  const guardados: string[] = [];
  let l = proteger(linea, guardados);
  // Enlaces [texto](url): la URL ya esta protegida por el paso anterior, asi que se reconoce el marcador.
  l = l.replace(new RegExp(`\\[([^\\]\\n]+)\\]\\(\\s*(${MARCADOR}\\d+${MARCADOR})\\s*\\)`, "gu"), (_m, texto: string, url: string) => `${texto}: ${url}`);
  const encabezado = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u.exec(l);
  if (encabezado) {
    const contenido = sinMarcasDeEnfasis(encabezado[1]!);
    l = contenido ? `*${contenido}*` : "";
  } else {
    l = l.replace(/^(\s*)[*+]\s+(?=\S)/u, "$1- ");
  }
  l = l
    .replace(/\*\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*\*/gu, "*_$1_*")
    .replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/gu, "*$1*")
    .replace(/(?<![\p{L}\p{N}_])__(?![\s_])([^_\n]+?)(?<![\s_])__(?![\p{L}\p{N}_])/gu, "*$1*")
    .replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/gu, "~$1~");
  return restaurar(l, guardados);
}

/** Texto del agente listo para WhatsApp. Cualquier entrada que no sea texto (0, null, false, [], {}) da "". */
export function normalizarFormatoWhatsApp(texto: unknown): string {
  if (typeof texto !== "string" || texto === "") return "";
  const salida: string[] = [];
  let dentroDeBloque = false;
  for (const linea of texto.split("\n")) {
    if (/^\s*```/u.test(linea)) {
      dentroDeBloque = !dentroDeBloque;
      salida.push(linea);
      continue;
    }
    if (dentroDeBloque) {
      salida.push(linea);
      continue;
    }
    const n = normalizarLinea(linea);
    if (n !== null) salida.push(n);
  }
  return salida.join("\n").replace(/\n{3,}/gu, "\n\n");
}

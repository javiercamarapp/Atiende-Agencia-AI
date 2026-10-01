// Tokenizador CSV (RFC 4180 + variantes bancarias): delimitador "," ";" "\t" o "|"
// detectado fuera de comillas, comillas dobles con escape "", saltos de línea CRLF/LF/CR
// y campos con saltos de línea entre comillas. Se conserva el número de línea física de
// inicio de cada registro para reportar errores por renglón.

export interface RegistroCsv {
  /** Línea física (1-based) donde empieza el registro. */
  readonly linea: number;
  readonly celdas: readonly string[];
}

const DELIMITADORES = [",", ";", "\t", "|"] as const;

export function quitarBom(texto: string): string {
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/** Elige el delimitador con más apariciones fuera de comillas, mirando las primeras
 * líneas no vacías. Empate o ninguno → ",". */
export function detectarDelimitador(texto: string): string {
  const conteo = new Map<string, number>(DELIMITADORES.map((d) => [d, 0]));
  let enComillas = false;
  let lineasVistas = 0;
  for (let i = 0; i < texto.length && lineasVistas < 12; i++) {
    const ch = texto[i]!;
    if (ch === '"') {
      if (enComillas && texto[i + 1] === '"') i++;
      else enComillas = !enComillas;
    } else if (!enComillas) {
      if (ch === "\n") lineasVistas++;
      else if (conteo.has(ch)) conteo.set(ch, (conteo.get(ch) ?? 0) + 1);
    }
  }
  let mejor = ",";
  let max = 0;
  for (const d of DELIMITADORES) {
    const n = conteo.get(d) ?? 0;
    if (n > max) {
      max = n;
      mejor = d;
    }
  }
  return mejor;
}

export function tokenizarCsv(texto: string, delimitador: string): RegistroCsv[] {
  const registros: RegistroCsv[] = [];
  let celdas: string[] = [];
  let actual = "";
  let enComillas = false;
  let linea = 1;
  let lineaInicio = 1;
  let hayContenido = false;

  const cerrarRegistro = () => {
    celdas.push(actual);
    if (hayContenido || celdas.some((c) => c.trim() !== "")) registros.push({ linea: lineaInicio, celdas });
    celdas = [];
    actual = "";
    hayContenido = false;
  };

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!;
    if (enComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          actual += '"';
          i++;
        } else enComillas = false;
      } else {
        if (ch === "\n") linea++;
        actual += ch;
      }
      continue;
    }
    if (ch === '"' && actual.trim() === "") {
      enComillas = true;
      actual = "";
      hayContenido = true;
    } else if (ch === delimitador) {
      celdas.push(actual);
      actual = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      cerrarRegistro();
      linea++;
      lineaInicio = linea;
    } else {
      actual += ch;
    }
  }
  if (actual !== "" || celdas.length > 0 || hayContenido) cerrarRegistro();
  return registros;
}

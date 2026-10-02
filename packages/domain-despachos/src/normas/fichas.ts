// D-33: fichas de la memoria normativa de despachos (normas/*.yaml). Puro: sin I/O, sin dependencias.
// Las fichas usan un subconjunto deliberadamente chico de YAML (escalares "clave: valor", cadenas entre comillas dobles,
// `null` y listas "  - valor") para validarse sin agregar una librería. Cualquier otra construcción es un error.

export const ESTADOS_VERIFICACION = ["verificada", "por_verificar", "en_disputa"] as const;
export type EstadoVerificacion = (typeof ESTADOS_VERIFICACION)[number];
export const TIPOS_FICHA = ["norma", "contexto"] as const;
export type TipoFicha = (typeof TIPOS_FICHA)[number];

export interface FichaNorma {
  readonly id: string;
  readonly tipo: TipoFicha;
  readonly ordenamiento: string;
  readonly articulo_o_regla: string;
  readonly resumen: string;
  readonly fuente_url: string;
  readonly vigencia: string;
  readonly estado_verificacion: EstadoVerificacion;
  readonly verificada_por: string | null;
  readonly fecha: string | null;
  readonly nota_verificacion: string;
  readonly usado_en_codigo: readonly string[];
}

export class FichaInvalidaError extends Error {}

function escalar(crudo: string, linea: number): string | null {
  const v = crudo.trim();
  if (v === "null") return null;
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new FichaInvalidaError(`línea ${linea}: cadena sin cerrar`);
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v === "" || v.startsWith(">") || v.startsWith("|") || v.startsWith("[") || v.startsWith("{")) {
    throw new FichaInvalidaError(`línea ${linea}: valor fuera del subconjunto YAML soportado`);
  }
  return v;
}

/** Lee el texto de una ficha y devuelve sus claves en bruto (escalares y listas de cadenas). */
export function parsearFichaCruda(texto: string): Record<string, string | null | string[]> {
  const out: Record<string, string | null | string[]> = {};
  let listaActual: string[] | null = null;
  texto.split("\n").forEach((linea, i) => {
    const n = i + 1;
    if (linea.trim() === "" || linea.trimStart().startsWith("#")) return;
    const item = /^ {2}- (.*)$/.exec(linea);
    if (item) {
      if (!listaActual) throw new FichaInvalidaError(`línea ${n}: elemento de lista sin clave`);
      const v = escalar(item[1] ?? "", n);
      if (v === null) throw new FichaInvalidaError(`línea ${n}: elemento de lista nulo`);
      listaActual.push(v);
      return;
    }
    const kv = /^([a-z_]+):(?: (.*))?$/.exec(linea);
    if (!kv) throw new FichaInvalidaError(`línea ${n}: no se entiende "${linea.slice(0, 40)}"`);
    const clave = kv[1] as string;
    if (clave in out) throw new FichaInvalidaError(`línea ${n}: clave duplicada ${clave}`);
    if (kv[2] === undefined) {
      listaActual = [];
      out[clave] = listaActual;
    } else {
      listaActual = null;
      out[clave] = escalar(kv[2], n);
    }
  });
  return out;
}

const CAMPOS_TEXTO = ["id", "ordenamiento", "articulo_o_regla", "resumen", "fuente_url", "vigencia", "nota_verificacion"] as const;

/** Valida una ficha cruda contra el esquema. Devuelve la lista de errores (vacía = válida). */
export function validarFicha(cruda: Record<string, string | null | string[]>): string[] {
  const errores: string[] = [];
  for (const c of CAMPOS_TEXTO) {
    const v = cruda[c];
    if (typeof v !== "string" || v.trim() === "") errores.push(`falta ${c}`);
  }
  if (!TIPOS_FICHA.includes(cruda["tipo"] as TipoFicha)) errores.push("tipo inválido");
  const estado = cruda["estado_verificacion"];
  if (!ESTADOS_VERIFICACION.includes(estado as EstadoVerificacion)) errores.push("estado_verificacion inválido");
  const firmante = cruda["verificada_por"];
  const fecha = cruda["fecha"];
  if (!("verificada_por" in cruda)) errores.push("falta verificada_por");
  if (!("fecha" in cruda)) errores.push("falta fecha");
  if (fecha !== null && fecha !== undefined && !(typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha))) errores.push("fecha debe ser YYYY-MM-DD o null");
  if (estado === "verificada" && (!firmante || !fecha)) errores.push("una ficha verificada exige verificada_por y fecha");
  if (estado !== "verificada" && (firmante || fecha)) errores.push("solo una ficha verificada lleva verificada_por y fecha");
  const url = cruda["fuente_url"];
  if (typeof url === "string" && !/^https:\/\/\S+$/.test(url)) errores.push("fuente_url debe ser https");
  const usado = cruda["usado_en_codigo"];
  if (!Array.isArray(usado) || usado.length === 0) errores.push("usado_en_codigo debe listar al menos un archivo:línea");
  else for (const u of usado) if (!/^[\w./-]+:\d+$/.test(u)) errores.push(`usado_en_codigo mal formado: ${u}`);
  return errores;
}

export function fichaDesdeCruda(cruda: Record<string, string | null | string[]>): FichaNorma {
  const errores = validarFicha(cruda);
  if (errores.length > 0) throw new FichaInvalidaError(errores.join("; "));
  return cruda as unknown as FichaNorma;
}

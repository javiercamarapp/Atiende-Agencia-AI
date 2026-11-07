// Mapeo asistido de columnas para importar clientes (portado del repo suelto: ClientesSection.tsx, «Mapea tus columnas»).
// Logica pura, sin React: completa la sugerencia por encabezado (`sugerirMapeo`) mirando el CONTENIDO de las celdas, para que un
// archivo sin encabezados o con encabezados raros («Col1», «Dato») tambien llegue con el telefono elegido; arma la muestra de cada
// columna, avisa de columnas repetidas y mide cuantos renglones traen un telefono plausible. No es IA: reglas fijas y verificables.
// El servidor sigue siendo la autoridad (normaliza y rechaza por renglon en la vista previa).
import { CAMPOS_IMPORTACION, construirFilas, sugerirMapeo } from "./clientes-importacion.ts";
import type { CampoImportacion, FilaCruda, MapeoColumnas } from "./clientes-importacion.ts";

/** Renglones que se miran para adivinar por contenido y para la muestra: suficientes para decidir, sin recorrer 5,000 filas por tecla. */
export const RENGLONES_MUESTRA = 50;
/** Fraccion minima de celdas con telefono plausible para proponer una columna como «Telefono» por su contenido. */
export const UMBRAL_TELEFONO = 0.6;

const MAX_CARACTERES_EJEMPLO = 40;

/** Mismas formas que acepta el servidor: 10 digitos, o con +52 / 521 delante. Separadores (espacios, guiones, parentesis) se ignoran. */
export function esTelefonoPlausible(valor: string): boolean {
  const d = valor.replace(/\D/g, "");
  return d.length === 10 || (d.length === 12 && d.startsWith("52")) || (d.length === 13 && d.startsWith("521"));
}

function celda(fila: readonly string[], idx: number): string {
  return (fila[idx] ?? "").trim();
}

/** Cuantas celdas no vacias trae la columna y cuantas parecen telefono (sobre la muestra). */
export function calidadTelefono(filasDatos: readonly (readonly string[])[], idx: number): { readonly conValor: number; readonly plausibles: number } {
  let conValor = 0;
  let plausibles = 0;
  for (const f of filasDatos.slice(0, RENGLONES_MUESTRA)) {
    const v = celda(f, idx);
    if (v === "") continue;
    conValor += 1;
    if (esTelefonoPlausible(v)) plausibles += 1;
  }
  return { conValor, plausibles };
}

/** La columna con mas telefonos plausibles (>= UMBRAL_TELEFONO de sus celdas con valor), sin usar las ya ocupadas; `null` si ninguna. */
export function columnaTelefonoPorContenido(filasDatos: readonly (readonly string[])[], columnas: number, ocupadas: ReadonlySet<number> = new Set()): number | null {
  let mejor: number | null = null;
  let mejorFraccion = 0;
  for (let i = 0; i < columnas; i += 1) {
    if (ocupadas.has(i)) continue;
    const { conValor, plausibles } = calidadTelefono(filasDatos, i);
    if (conValor === 0) continue;
    const fraccion = plausibles / conValor;
    if (fraccion >= UMBRAL_TELEFONO && fraccion > mejorFraccion) {
      mejor = i;
      mejorFraccion = fraccion;
    }
  }
  return mejor;
}

export function numeroDeColumnas(filas: readonly (readonly string[])[]): number {
  return filas.reduce((m, f) => Math.max(m, f.length), 0);
}

/**
 * Sugerencia completa: primero por encabezado (si la primera fila los trae) y, si el telefono sigue sin columna o la elegida por nombre
 * no trae telefonos (p. ej. «Numero de cliente»), por contenido. Nunca asigna una columna a dos campos.
 */
export function sugerirMapeoCompleto(filas: readonly (readonly string[])[], conEncabezado: boolean): MapeoColumnas {
  const encabezados = conEncabezado ? (filas[0] ?? []) : [];
  const datos = conEncabezado ? filas.slice(1) : filas;
  const porNombre: Record<CampoImportacion, number | null> = { ...sugerirMapeo(encabezados) };
  if (porNombre.telefono !== null) {
    const { conValor, plausibles } = calidadTelefono(datos, porNombre.telefono);
    if (conValor > 0 && plausibles / conValor < UMBRAL_TELEFONO) porNombre.telefono = null;
  }
  if (porNombre.telefono === null) {
    const ocupadas = new Set(CAMPOS_IMPORTACION.map((c) => porNombre[c]).filter((v): v is number => v !== null));
    porNombre.telefono = columnaTelefonoPorContenido(datos, numeroDeColumnas(filas), ocupadas);
  }
  return porNombre;
}

/** Campos que comparten columna con otro campo (la misma columna en dos datos casi siempre es un error de mapeo). */
export function camposRepetidos(mapeo: MapeoColumnas): CampoImportacion[] {
  const usos = new Map<number, CampoImportacion[]>();
  for (const c of CAMPOS_IMPORTACION) {
    const idx = mapeo[c];
    if (idx === null) continue;
    usos.set(idx, [...(usos.get(idx) ?? []), c]);
  }
  return [...usos.values()].filter((cs) => cs.length > 1).flat();
}

/** Campos obligatorios sin columna. Hoy solo el telefono: es la llave del cliente (sin el no se puede deduplicar). */
export function camposFaltantes(mapeo: MapeoColumnas): CampoImportacion[] {
  return mapeo.telefono === null ? ["telefono"] : [];
}

/** Hasta `n` valores no vacios de la columna, recortados, para el «Ej:» del selector. */
export function ejemplosDeColumna(filasDatos: readonly (readonly string[])[], idx: number, n = 2): string[] {
  const out: string[] = [];
  for (const f of filasDatos.slice(0, RENGLONES_MUESTRA)) {
    const v = celda(f, idx);
    if (v === "") continue;
    out.push(v.length > MAX_CARACTERES_EJEMPLO ? `${v.slice(0, MAX_CARACTERES_EJEMPLO - 1)}…` : v);
    if (out.length >= n) break;
  }
  return out;
}

/** Primeros renglones tal como se mandarian con este mapeo (vista previa local, antes de la del servidor). */
export function vistaPreviaLocal(filasDatos: readonly (readonly string[])[], mapeo: MapeoColumnas, n = 5): FilaCruda[] {
  return construirFilas(filasDatos.slice(0, n), mapeo);
}

// R-17: CSV compatible con Excel. UTF-8 con BOM (Excel lo abre con acentos y eñes bien), separador coma, fin de linea CRLF (RFC 4180),
// campos entrecomillados cuando llevan coma, comilla, salto de linea o espacios en los extremos. Los numeros salen sin simbolo ni separador
// de miles (columnas numericas puras). Pura: sin I/O.
//
// Defensa contra inyeccion de formulas (CSV injection): un texto que EMPIEZA con `=`, `+`, `-`, `@`, tabulador o retorno de carro puede
// ejecutarse como formula al abrirlo en Excel/Sheets. Los nombres de clientes y notas los escribe un tercero (el cliente por WhatsApp o web),
// asi que toda celda de TEXTO que empiece asi se antepone con un apostrofo. Excepcion: un telefono (solo digitos, espacios, +, -, parentesis).
export const CSV_BOM = "﻿";
const TELEFONO_RE = /^\+?[0-9][0-9 ()-]{5,}$/;
const NUMERO_RE = /^-?\d+(\.\d+)?$/;

export type CeldaCsv = string | number | null | undefined;

export interface ColumnaCsv<T> {
  readonly titulo: string;
  readonly valor: (fila: T) => CeldaCsv;
  /** El valor es un telefono: no se le aplica el apostrofo de formula aunque empiece con "+". */
  readonly telefono?: boolean;
  /** Columna numerica (dinero, conteos): el PDF la alinea a la derecha y el CSV no la entrecomilla ni le antepone apostrofo si es un numero. */
  readonly numerica?: boolean;
}

export function celdaCsv(valor: CeldaCsv, opciones: { readonly telefono?: boolean; readonly numerica?: boolean } = {}): string {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "number") return Number.isFinite(valor) ? String(valor) : "";
  let t = valor.split(String.fromCharCode(0)).join("");
  const esTelefono = opciones.telefono === true && TELEFONO_RE.test(t);
  const esNumero = opciones.numerica === true && NUMERO_RE.test(t);
  if (/^[=+\-@\t\r]/.test(t) && !esTelefono && !esNumero) t = `'${t}`;
  if (/[",\r\n]/.test(t) || t !== t.trim()) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

export function csvDesdeFilas<T>(columnas: readonly ColumnaCsv<T>[], filas: readonly T[]): string {
  const lineas: string[] = [columnas.map((c) => celdaCsv(c.titulo)).join(",")];
  for (const f of filas) lineas.push(columnas.map((c) => celdaCsv(c.valor(f), { telefono: c.telefono === true, numerica: c.numerica === true })).join(","));
  return `${CSV_BOM}${lineas.join("\r\n")}\r\n`;
}

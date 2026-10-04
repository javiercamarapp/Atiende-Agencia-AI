// Importacion de cartera de clientes (CSV/Excel) -- normalizacion y validacion PURA de los renglones que manda el panel.
// La base (`restaurantes.importar_clientes`, migracion 054) vuelve a validar el telefono (10 digitos) y acota los textos; esto es
// la primera barrera y la que produce la vista previa con errores por renglon.
//
// Reglas (mismas que el resto de canales, ver phone.ts):
//   * telefono: 10 digitos; se aceptan +52 y 521 (X16/X17/X18); 11 digitos u otro largo se rechazan, nunca se recortan.
//   * el nombre ya conocido NO se pisa (lo garantiza la funcion SQL); aqui solo se limpia el texto.
//   * la colonia se anexa a la direccion; las notas se guardan en `customers.notes`.
//   * tope de 5,000 renglones por archivo.
import { canonicalizeMexicanPhone } from "./phone.ts";
import type { FilaImportacionCliente } from "./types.ts";

export const IMPORTACION_MAX_FILAS = 5000;
const NOMBRE_MAX = 120;
const DIRECCION_MAX = 300;
const NOTAS_MAX = 500;

export interface ErrorRenglonImportacion {
  /** Numero de renglon de DATOS, empezando en 1 (sin contar el encabezado). */
  readonly renglon: number;
  readonly motivo: string;
}

export interface PreparacionImportacion {
  readonly total: number;
  readonly validas: readonly FilaImportacionCliente[];
  readonly errores: readonly ErrorRenglonImportacion[];
  /** Renglones validos cuyo telefono ya aparecio antes en el mismo archivo (el primero gana). */
  readonly duplicadosEnArchivo: number;
}

function limpiar(valor: unknown, max: number): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = typeof valor === "string" ? valor : typeof valor === "number" && Number.isFinite(valor) ? String(valor) : "";
  // Sin caracteres de control ni espacios repetidos; recortado al maximo de la base.
  const limpio = texto
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return limpio === "" ? null : limpio;
}

/** Normaliza los renglones crudos (`telefono`, `nombre`, `direccion`, `colonia`, `notas`). */
export function prepararImportacionClientes(crudas: readonly unknown[]): PreparacionImportacion {
  const validas: FilaImportacionCliente[] = [];
  const errores: ErrorRenglonImportacion[] = [];
  const vistos = new Set<string>();
  let duplicados = 0;
  crudas.forEach((cruda, i) => {
    const renglon = i + 1;
    if (cruda === null || typeof cruda !== "object" || Array.isArray(cruda)) {
      errores.push({ renglon, motivo: "Renglon invalido." });
      return;
    }
    const r = cruda as Record<string, unknown>;
    const telefonoCrudo = limpiar(r.telefono, 40);
    const nombre = limpiar(r.nombre, NOMBRE_MAX);
    const direccion = limpiar(r.direccion, DIRECCION_MAX);
    const colonia = limpiar(r.colonia, 100);
    const notas = limpiar(r.notas, NOTAS_MAX);
    if (telefonoCrudo === null && nombre === null && direccion === null && colonia === null && notas === null) {
      errores.push({ renglon, motivo: "Renglon vacio." });
      return;
    }
    if (telefonoCrudo === null) {
      errores.push({ renglon, motivo: "Falta el telefono." });
      return;
    }
    const phone = canonicalizeMexicanPhone(telefonoCrudo);
    if (phone === null) {
      errores.push({ renglon, motivo: "Telefono invalido: se esperan 10 digitos (se acepta +52 o 521 al inicio)." });
      return;
    }
    if (vistos.has(phone)) duplicados += 1;
    vistos.add(phone);
    const address = direccion !== null && colonia !== null ? `${direccion}, ${colonia}`.slice(0, DIRECCION_MAX) : (direccion ?? colonia);
    validas.push({ phone, name: nombre, address, notes: notas });
  });
  return { total: crudas.length, validas, errores, duplicadosEnArchivo: duplicados };
}

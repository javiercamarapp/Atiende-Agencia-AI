// Parseo de importes de estados de cuenta bancarios mexicanos. Los bancos exportan
// "1,234.56", "$1,234.56", "(1,234.56)", "1,234.56-", "1.234,56" (exportaciones con
// configuración regional europea), "1234.5", "CR"/"DR" al final, etc. Se trabaja en
// CENTAVOS enteros (nunca con float intermedio) para que "0.1 + 0.2" no contamine
// los totales ni el hash de idempotencia.

export type ResultadoMonto =
  | { readonly ok: true; readonly centavos: number; readonly vacio: false }
  | { readonly ok: true; readonly centavos: 0; readonly vacio: true }
  | { readonly ok: false; readonly motivo: string };

/** Convierte centavos enteros a pesos con exactamente 2 decimales de precisión. */
export function centavosAPesos(centavos: number): number {
  return Math.round(centavos) / 100;
}

/**
 * Parsea un importe. Devuelve el valor CON SIGNO tal como viene escrito (paréntesis,
 * "-" inicial o final y sufijo "DR"/"DB" cuentan como negativo; "CR" como positivo).
 * Una celda vacía, "-" o "N/A" devuelve `vacio: true` (columna sin importe), nunca 0
 * silencioso: el llamador decide si una fila sin ningún importe es un error.
 */
export function parsearMonto(crudo: string): ResultadoMonto {
  let s = crudo.replace(/[\u00a0\u2007\u202f]/g, " ").trim();
  if (s === "" || s === "-" || s === "--" || /^n\/?a$/i.test(s)) return { ok: true, centavos: 0, vacio: true };

  let negativo = false;

  // Sufijo de naturaleza contable (algunos bancos: "1,200.00 CR" / "1,200.00 DR").
  const sufijo = /\s*(CR|DR|DB|C|D)$/i.exec(s);
  if (sufijo && /\d/.test(s.slice(0, sufijo.index))) {
    const marca = sufijo[1]!.toUpperCase();
    if (marca === "DR" || marca === "DB" || marca === "D") negativo = true;
    s = s.slice(0, sufijo.index).trim();
  }

  // Paréntesis contable.
  const parens = /^\((.*)\)$/.exec(s);
  if (parens) {
    negativo = !negativo;
    s = parens[1]!.trim();
  }

  // Quitar moneda y espacios internos.
  s = s.replace(/mxn|mxp|m\.n\.|usd|\$/gi, "").replace(/\s+/g, "");

  // Signo inicial o final.
  if (s.startsWith("-") || s.startsWith("−")) {
    negativo = !negativo;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s.endsWith("-") || s.endsWith("−")) {
    negativo = !negativo;
    s = s.slice(0, -1);
  } else if (s.endsWith("+")) {
    s = s.slice(0, -1);
  }

  if (s === "" || !/^[\d.,]+$/.test(s)) return { ok: false, motivo: `importe no reconocido: "${crudo.trim()}"` };

  const ultimoPunto = s.lastIndexOf(".");
  const ultimaComa = s.lastIndexOf(",");
  let enteros: string;
  let decimales: string;

  if (ultimoPunto !== -1 && ultimaComa !== -1) {
    // Ambos separadores: el último es el decimal.
    const sepDec = ultimoPunto > ultimaComa ? "." : ",";
    const sepMil = sepDec === "." ? "," : ".";
    const idx = s.lastIndexOf(sepDec);
    enteros = s.slice(0, idx).split(sepMil).join("");
    decimales = s.slice(idx + 1);
    if (!esAgrupacionValida(s.slice(0, idx), sepMil)) return { ok: false, motivo: `importe con separadores inconsistentes: "${crudo.trim()}"` };
  } else if (ultimaComa !== -1) {
    // Solo comas: miles ("1,234" / "1,234,567") o decimal europeo ("1234,56").
    if (/^\d{1,3}(,\d{3})+$/.test(s)) {
      enteros = s.split(",").join("");
      decimales = "";
    } else if (/^\d*,\d{1,2}$/.test(s)) {
      const idx = ultimaComa;
      enteros = s.slice(0, idx);
      decimales = s.slice(idx + 1);
    } else {
      return { ok: false, motivo: `importe con separadores inconsistentes: "${crudo.trim()}"` };
    }
  } else if (ultimoPunto !== -1) {
    // Solo puntos: en México el punto es el decimal. Más de un punto es inválido.
    if (s.indexOf(".") !== ultimoPunto) return { ok: false, motivo: `importe con separadores inconsistentes: "${crudo.trim()}"` };
    enteros = s.slice(0, ultimoPunto);
    decimales = s.slice(ultimoPunto + 1);
  } else {
    enteros = s;
    decimales = "";
  }

  if (enteros === "") enteros = "0";
  if (!/^\d+$/.test(enteros) || (decimales !== "" && !/^\d+$/.test(decimales))) return { ok: false, motivo: `importe no reconocido: "${crudo.trim()}"` };
  // Más de 2 decimales solo se acepta si los sobrantes son ceros ("10.500" no es válido).
  if (decimales.length > 2) {
    if (!/^0+$/.test(decimales.slice(2))) return { ok: false, motivo: `importe con más de 2 decimales: "${crudo.trim()}"` };
    decimales = decimales.slice(0, 2);
  }
  const centavosAbs = Number(enteros) * 100 + Number(decimales.padEnd(2, "0"));
  if (!Number.isSafeInteger(centavosAbs)) return { ok: false, motivo: `importe fuera de rango: "${crudo.trim()}"` };
  const centavos = negativo ? -centavosAbs : centavosAbs;
  return { ok: true, centavos: centavos === 0 ? 0 : centavos, vacio: false } as ResultadoMonto;
}

function esAgrupacionValida(parteEntera: string, sepMil: string): boolean {
  const grupos = parteEntera.split(sepMil);
  if (grupos.length === 1) return /^\d+$/.test(grupos[0]!);
  if (!/^\d{1,3}$/.test(grupos[0]!)) return false;
  return grupos.slice(1).every((g) => /^\d{3}$/.test(g));
}

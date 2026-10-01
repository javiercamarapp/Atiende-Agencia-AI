// Fechas de estados de cuenta mexicanos. Los bancos usan dd/mm/aaaa (día primero,
// NUNCA mm/dd), dd-mm-aaaa, aaaa-mm-dd, dd/mmm/aaaa con mes en español ("15/ENE/2026",
// "15 sep 2026", "02-SEPT-26") y OFX usa aaaammdd[hhmmss[.xxx][zona]]. Toda fecha se
// valida contra el calendario real ("31/02/2026" es un error, no "03/03/2026").

const MESES: Readonly<Record<string, number>> = {
  ene: 1, enero: 1, jan: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4, apr: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8, aug: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12, dec: 12,
};

export type ResultadoFecha = { readonly ok: true; readonly iso: string } | { readonly ok: false; readonly motivo: string };

function quitarAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function construir(anio: number, mes: number, dia: number, crudo: string): ResultadoFecha {
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return { ok: false, motivo: `fecha inexistente en el calendario: "${crudo}"` };
  }
  if (anio < 1990 || anio > 2100) return { ok: false, motivo: `año fuera de rango (1990-2100): "${crudo}"` };
  return { ok: true, iso: `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}` };
}

function anioDeDosDigitos(yy: number): number {
  return 2000 + yy;
}

/** Parsea una fecha de CSV bancario a YYYY-MM-DD. Ignora una hora al final. */
export function parsearFechaMx(crudo: string): ResultadoFecha {
  const original = crudo.trim();
  // Quita hora ("15/01/2026 13:45:10", "2026-01-15T10:00:00").
  const s = quitarAcentos(original).toLowerCase().replace(/[t\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm|z)?$/, "").trim();
  if (s === "") return { ok: false, motivo: "fecha vacía" };

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return construir(Number(m[1]), Number(m[2]), Number(m[3]), original);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return construir(Number(m[3]), Number(m[2]), Number(m[1]), original);

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/.exec(s);
  if (m) return construir(anioDeDosDigitos(Number(m[3])), Number(m[2]), Number(m[1]), original);

  // dd/mmm/aaaa, dd mmm aaaa, dd-mmm-aa, dd de mmm de aaaa
  m = /^(\d{1,2})(?:\s+de\s+|[-/.\s]+)([a-z]+)\.?(?:\s+de\s+|[-/.\s]+)(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mes = MESES[m[2]!];
    if (mes === undefined) return { ok: false, motivo: `mes no reconocido: "${original}"` };
    const anio = m[3]!.length === 2 ? anioDeDosDigitos(Number(m[3])) : Number(m[3]);
    return construir(anio, mes, Number(m[1]), original);
  }

  // ddmmaaaa / aaaammdd sin separadores (8 dígitos)
  m = /^(\d{8})$/.exec(s);
  if (m) {
    const v = m[1]!;
    const anioPrimero = Number(v.slice(0, 4)) >= 1990 && Number(v.slice(0, 4)) <= 2100;
    return anioPrimero ? construir(Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)), original) : construir(Number(v.slice(4, 8)), Number(v.slice(2, 4)), Number(v.slice(0, 2)), original);
  }

  return { ok: false, motivo: `formato de fecha no reconocido: "${original}"` };
}

/** Fecha OFX: aaaammdd[hhmmss[.xxx]][[±h:ZZZ]] — se usa solo la parte de fecha. */
export function parsearFechaOfx(crudo: string): ResultadoFecha {
  const original = crudo.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:\d{2,6}(?:\.\d+)?)?(?:\[[^\]]*\])?$/.exec(original);
  if (!m) return { ok: false, motivo: `fecha OFX no reconocida: "${original}"` };
  return construir(Number(m[1]), Number(m[2]), Number(m[3]), original);
}

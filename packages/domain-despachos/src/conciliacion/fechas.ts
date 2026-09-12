// Parseo de fecha compartido por `matching-engine.ts` y `spei-matching.ts` — puerto
// de `_fecha_to_dt`/`_fecha_diff` (matching_engine.py) y `_parse_date` (spei.py),
// que en el origen son funciones casi idénticas duplicadas en ambos archivos; aquí
// se consolidan en una sola implementación verificada.

/** Intenta YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, en ese orden, con validación real de
 * calendario (equivalente a `datetime.strptime`: "2025-02-30" no es válida en
 * ningún formato). */
export function fechaADate(fecha: string): Date | null {
  const intentos: Array<[RegExp, (m: RegExpMatchArray) => [number, number, number]]> = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]],
    [/^(\d{2})\/(\d{2})\/(\d{4})$/, (m) => [Number(m[3]), Number(m[2]), Number(m[1])]],
    [/^(\d{2})-(\d{2})-(\d{4})$/, (m) => [Number(m[3]), Number(m[2]), Number(m[1])]],
  ];
  for (const [re, extract] of intentos) {
    const m = fecha.match(re);
    if (!m) continue;
    const [year, month, day] = extract(m);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) {
      return d;
    }
  }
  return null;
}

/** Diferencia absoluta en días, `null` si alguna fecha no parsea. */
export function fechaDiff(f1: string, f2: string): number | null {
  const d1 = fechaADate(f1);
  const d2 = fechaADate(f2);
  if (!d1 || !d2) return null;
  return Math.round(Math.abs(d1.getTime() - d2.getTime()) / 86_400_000);
}

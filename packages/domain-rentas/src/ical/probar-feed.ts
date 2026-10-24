// Rn-P3-17 -- resumen de un .ics para "Probar URL" al conectar un feed: cuántos eventos trae y qué rango
// de fechas cubre. Solo LEE y resume: nunca aplica nada ni guarda nada. Lanza `IcsParseError` si el
// contenido no es un iCalendar válido (la ruta lo traduce en el error de parseo que ve el usuario).
import { parsearIcs, type LimitesParserIcs, type ValorFechaIcs } from "./parser.ts";

export interface ResumenFeedIcs {
  readonly eventos: number;
  /** Eventos con STATUS:CANCELLED (el motor los trata como liberación, no como bloqueo). */
  readonly cancelados: number;
  /** Primera fecha (AAAA-MM-DD) de inicio entre los eventos no cancelados; `null` si no hay ninguno. */
  readonly desde: string | null;
  /** Última fecha (AAAA-MM-DD) de fin entre los eventos no cancelados; `null` si no hay ninguno. */
  readonly hasta: string | null;
}

function fechaDe(valor: ValorFechaIcs): string {
  switch (valor.tipo) {
    case "DATE":
      return valor.fecha;
    case "DATE-TIME-UTC":
      return valor.instanteIso.slice(0, 10);
    case "DATE-TIME-TZID":
    case "DATE-TIME-FLOTANTE":
      return valor.fechaHoraLocal.slice(0, 10);
  }
}

export function resumirFeedIcs(contenido: string, limites?: LimitesParserIcs): ResumenFeedIcs {
  const { eventos } = limites ? parsearIcs(contenido, limites) : parsearIcs(contenido);
  let desde: string | null = null;
  let hasta: string | null = null;
  let cancelados = 0;
  for (const e of eventos) {
    if (e.status === "CANCELLED") {
      cancelados += 1;
      continue;
    }
    const ini = fechaDe(e.dtstart);
    const fin = fechaDe(e.dtend);
    if (desde === null || ini < desde) desde = ini;
    if (hasta === null || fin > hasta) hasta = fin;
  }
  return { eventos: eventos.length, cancelados, desde, hasta };
}

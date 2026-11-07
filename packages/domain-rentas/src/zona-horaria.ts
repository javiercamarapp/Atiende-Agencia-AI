// Rn-P3-10 -- conversion de una hora de pared local (fecha + HH:MM en una zona IANA) a un instante UTC, con `Intl` y sin dependencias nuevas.
// La usan el recordatorio horario de check-in (ventana por horas en la zona de la property) y el doble en memoria que reproduce el filtro SQL
// `((lower(rango) + time 'HH:MM') at time zone <zona>)`.
const FORMATOS = new Map<string, Intl.DateTimeFormat>();

function formato(zona: string): Intl.DateTimeFormat {
  let f = FORMATOS.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FORMATOS.set(zona, f);
  }
  return f;
}

/** Desfase (ms) de `zona` respecto de UTC en el instante `instante` (negativo al oeste de Greenwich). */
function desfaseMs(zona: string, instante: number): number {
  const partes: Record<string, number> = {};
  for (const p of formato(zona).formatToParts(new Date(instante))) if (p.type !== "literal") partes[p.type] = Number(p.value);
  const comoUtc = Date.UTC(partes.year!, partes.month! - 1, partes.day!, partes.hour!, partes.minute!, partes.second!);
  return comoUtc - Math.floor(instante / 1000) * 1000;
}

/** Instante UTC (ms) en que el reloj de `zona` marca `fecha` (`YYYY-MM-DD`) a las `hora` (`HH:MM`). Lanza con una zona IANA invalida. */
export function instanteDeParedLocal(fecha: string, hora: string, zona: string): number {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const h = /^(\d{2}):(\d{2})$/.exec(hora);
  if (!f || !h) throw new Error("instanteDeParedLocal: fecha u hora con formato invalido.");
  const nominal = Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3]), Number(h[1]), Number(h[2]));
  // Dos pasadas: la segunda corrige el desfase cuando el instante cae al otro lado de un cambio de horario.
  const primera = nominal - desfaseMs(zona, nominal);
  return nominal - desfaseMs(zona, primera);
}

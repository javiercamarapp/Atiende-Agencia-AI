// Construcción y parseo mínimo de iCalendar (RFC 5545) para round-trip de UN
// VEVENT propio — no es un parser de feeds arbitrarios de terceros. Port de
// citas-reservaciones/supabase/functions/_shared/caldav-ics.ts. caldav-port.ts
// SIEMPRE genera el ICS que después vuelve a leer (su propio evento, creado por
// este mismo adaptador) — el alcance real es: escribirlo bien (folding, escape) y
// leerlo de vuelta bien, no tolerar cualquier feed ICS que un tercero mande.
//
// Reglas de RFC 5545 que SÍ se implementan aquí, porque un servidor CalDAV real
// (iCloud, Fastmail, Nextcloud) las exige o las produce:
//   - §3.1 folding: ninguna línea de salida excede 75 octetos; una continuación
//     empieza con un único espacio.
//   - §3.3.11 TEXT escaping: `\`, `;`, `,` y saltos de línea se escapan en
//     SUMMARY/DESCRIPTION.
//   - CRLF como terminador de línea (obligatorio, no solo LF).

export interface VEventDraft {
  readonly uid: string;
  /** ISO 8601 con "Z" (UTC) — ver la nota en caldav-port.ts sobre por qué este
   * adaptador siempre normaliza a UTC en vez de embeber VTIMEZONE. */
  readonly dtstartUtc: string;
  readonly dtendUtc: string;
  readonly summary: string;
  readonly description: string;
  readonly attendeeEmail?: string;
  readonly attendeeName?: string;
  /** `now` inyectable para pruebas deterministas (DTSTAMP). */
  readonly dtstampUtc?: string;
  readonly status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
}

export interface ParsedVEvent {
  readonly uid: string;
  readonly dtstartUtc: string;
  readonly dtendUtc: string;
  readonly summary: string | null;
  readonly description: string | null;
  readonly status: "CONFIRMED" | "CANCELLED" | "TENTATIVE" | null;
}

export class IcsBuildError extends Error {}
export class IcsParseError extends Error {}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** RFC 5545 §3.1: una línea de contenido no debe exceder 75 octetos; se pliega
 * insertando CRLF + un espacio antes del siguiente octeto. Se mide en bytes
 * UTF-8 (no en unidades UTF-16 de JS), porque el límite del RFC es de octetos. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // 74 en la primera línea (75 - 0 continuación); 74 en las siguientes porque
    // el espacio de continuación cuenta como 1 octeto del límite de 75 de esa
    // línea continuada.
    const take = Math.min(74, bytes.length - start);
    // Evita partir un carácter UTF-8 multibyte a la mitad: retrocede hasta un
    // límite de carácter válido si el corte cae dentro de una secuencia.
    let end = start + take;
    while (end < bytes.length && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
      end--;
    }
    chunks.push(new TextDecoder().decode(bytes.slice(start, end)));
    start = end;
  }
  return chunks.join("\r\n ");
}

function isoToIcsUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new IcsBuildError(`fecha ISO inválida para DTSTART/DTEND/DTSTAMP: "${iso}"`);
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsUtcToIso(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new IcsParseError(`valor DATE-TIME UTC inválido: "${value}"`);
  const [, yyyy, mm, dd, hh, mi, ss] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.000Z`;
}

/** Construye un VCALENDAR/VEVENT completo y válido, listo para PUT contra un
 * recurso `.ics` de una colección CalDAV. */
export function buildVEventIcs(draft: VEventDraft): string {
  const dtstamp = isoToIcsUtc(draft.dtstampUtc ?? new Date().toISOString());
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//atiende.ai//atiende-fusion-citas//ES", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${draft.uid}`, `DTSTAMP:${dtstamp}`, `DTSTART:${isoToIcsUtc(draft.dtstartUtc)}`, `DTEND:${isoToIcsUtc(draft.dtendUtc)}`, `SUMMARY:${escapeText(draft.summary)}`];
  if (draft.description) lines.push(`DESCRIPTION:${escapeText(draft.description)}`);
  if (draft.attendeeEmail) {
    const cn = draft.attendeeName ? `;CN=${escapeText(draft.attendeeName)}` : "";
    lines.push(`ATTENDEE${cn}:mailto:${draft.attendeeEmail}`);
  }
  lines.push(`STATUS:${draft.status ?? "CONFIRMED"}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Des-pliega (unfold) RFC 5545 §3.1: una línea de continuación empieza con un
 * espacio o tab; se concatena a la línea anterior quitando ese carácter. */
function unfoldLines(icsText: string): string[] {
  const raw = icsText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of raw) {
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/** Lee de vuelta el primer VEVENT de un ICS generado por `buildVEventIcs` (o
 * compatible: RFC 5545 básico, sin RRULE/VALARM/VTIMEZONE — fuera de alcance
 * porque este adaptador nunca genera recurrencia ni alarmas). */
export function parseVEventIcs(icsText: string): ParsedVEvent {
  const lines = unfoldLines(icsText);
  const props = new Map<string, string>();
  let insideVEvent = false;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      insideVEvent = true;
      continue;
    }
    if (line === "END:VEVENT") break;
    if (!insideVEvent) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    // Tolera parámetros (ej. `ATTENDEE;CN=...:mailto:...`) quedándose con el
    // nombre base antes del primer `;` — no se necesitan para el uso interno de
    // este adaptador (solo UID/DTSTART/DTEND/SUMMARY/DESCRIPTION/STATUS).
    const semicolon = line.indexOf(";");
    const name = (semicolon !== -1 && semicolon < colon ? line.slice(0, semicolon) : line.slice(0, colon)).toUpperCase();
    const value = line.slice(colon + 1);
    if (!props.has(name)) props.set(name, value);
  }

  const uid = props.get("UID");
  const dtstart = props.get("DTSTART");
  const dtend = props.get("DTEND");
  if (!uid) throw new IcsParseError("VEVENT sin UID");
  if (!dtstart) throw new IcsParseError("VEVENT sin DTSTART");
  if (!dtend) throw new IcsParseError("VEVENT sin DTEND");

  const status = props.get("STATUS")?.toUpperCase();
  return {
    uid,
    dtstartUtc: icsUtcToIso(dtstart),
    dtendUtc: icsUtcToIso(dtend),
    summary: props.has("SUMMARY") ? unescapeText(props.get("SUMMARY")!) : null,
    description: props.has("DESCRIPTION") ? unescapeText(props.get("DESCRIPTION")!) : null,
    status: status === "CONFIRMED" || status === "CANCELLED" || status === "TENTATIVE" ? status : null,
  };
}

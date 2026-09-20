// Parser ICS RFC 5545/5546 propio — port ~literal de
// rentas/packages/adapters/src/ical/parser.ts (repo origen, H-023). Justificación de
// "propio" sobre una librería de terceros (`ical.js`, `node-ical`): el contrato de
// este lote exige límites duros propios (tamaño/nº eventos/longitud de línea)
// aplicados ANTES de tokenizar, tolerancia explícita a campos desconocidos, y cero
// superficie de evaluación de nada ejecutable — más simple de auditar línea por línea
// en ~250 líneas propias que verificar la superficie completa de una dependencia
// externa no auditada por este equipo. El formato es texto plano por líneas (ABNF
// simple, RFC 5545 §3.1), no XML/JS: no hay "contenido ejecutable" que evaluar por
// diseño, y este parser nunca usa `eval`/`Function`/deserialización insegura.
//
// Alcance: solo lo necesario para sincronización de disponibilidad — VEVENT con
// UID/SEQUENCE/DTSTAMP/LAST-MODIFIED/STATUS/SUMMARY/DTSTART/DTEND/DURATION. VTIMEZONE
// se tolera (se ignora su contenido; TZID se usa tal cual como nombre de zona IANA en
// DTSTART/DTEND, ver `ValorFechaIcs`) y cualquier otro componente (VALARM, VTODO,
// etc.) se tolera y se descarta sin fallar el parseo.
import {
  IcsParseError,
  LIMITES_ICS_POR_DEFECTO,
  type CalendarioIcsNormalizado,
  type EstadoEventoIcs,
  type LimitesParserIcs,
  type VEventNormalizado,
  type ValorFechaIcs,
} from "./tipos.ts";

function normalizarSaltosDeLinea(texto: string): string {
  return texto.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Des-pliega (unfold) líneas partidas por RFC 5545 §3.1: una línea larga se divide
 * insertando CRLF + un único espacio/tab de continuación. Tolerante a CRLF y a LF
 * solo (algunos generadores no siguen CRLF estrictamente). */
function desplegarLineas(textoNormalizado: string, limites: LimitesParserIcs): string[] {
  const lineasCrudas = textoNormalizado.split("\n");
  const lineasDesplegadas: string[] = [];
  for (const cruda of lineasCrudas) {
    if (cruda.length === 0) continue;
    const esContinuacion = cruda.startsWith(" ") || cruda.startsWith("\t");
    if (esContinuacion && lineasDesplegadas.length > 0) {
      lineasDesplegadas[lineasDesplegadas.length - 1] += cruda.slice(1);
    } else {
      lineasDesplegadas.push(cruda);
    }
    const ultima = lineasDesplegadas[lineasDesplegadas.length - 1]!;
    if (ultima.length > limites.maxLongitudLineaDesplegada) {
      throw new IcsParseError(
        "linea_demasiado_larga",
        `línea des-plegada excede el límite de ${limites.maxLongitudLineaDesplegada} caracteres`,
      );
    }
  }
  return lineasDesplegadas;
}

interface LineaContenido {
  nombre: string;
  parametros: Map<string, string>;
  valor: string;
}

/** Parsea una `contentline` (`NAME;PARAM=VALUE;PARAM2=VALUE2:VALOR`) — respeta
 * valores de parámetro entre comillas dobles, que pueden contener `:` y `;` sin
 * terminar la línea (p. ej. `TZID="America/Mexico City"`, uso raro pero válido en la
 * gramática). */
function parsearLineaContenido(linea: string): LineaContenido {
  let i = 0;
  let dentroDeComillas = false;
  let finDeNombreYParametros = -1;
  while (i < linea.length) {
    const c = linea[i];
    if (c === '"') dentroDeComillas = !dentroDeComillas;
    if (c === ":" && !dentroDeComillas) {
      finDeNombreYParametros = i;
      break;
    }
    i++;
  }
  if (finDeNombreYParametros === -1) {
    throw new IcsParseError("estructura_desbalanceada", `línea sin ':' válido: "${linea.slice(0, 40)}..."`);
  }
  const cabecera = linea.slice(0, finDeNombreYParametros);
  const valor = linea.slice(finDeNombreYParametros + 1);

  const partes = dividirRespetandoComillas(cabecera, ";");
  const nombre = partes[0]!.toUpperCase();
  const parametros = new Map<string, string>();
  for (const parte of partes.slice(1)) {
    const igual = parte.indexOf("=");
    if (igual === -1) continue;
    const clave = parte.slice(0, igual).toUpperCase();
    let val = parte.slice(igual + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    parametros.set(clave, val);
  }
  return { nombre, parametros, valor };
}

function dividirRespetandoComillas(texto: string, separador: string): string[] {
  const resultado: string[] = [];
  let actual = "";
  let dentroDeComillas = false;
  for (const c of texto) {
    if (c === '"') dentroDeComillas = !dentroDeComillas;
    if (c === separador && !dentroDeComillas) {
      resultado.push(actual);
      actual = "";
    } else {
      actual += c;
    }
  }
  resultado.push(actual);
  return resultado;
}

// ---------------------------------------------------------------------------
// Valores de fecha (DATE / DATE-TIME UTC / DATE-TIME+TZID / flotante)
// ---------------------------------------------------------------------------

// Las expresiones regulares de más abajo solo validan FORMA (dígitos en la posición
// correcta) — un DTSTART como "20269999" (mes 99, día 99) o "20270101T999999Z"
// (hora/minuto/segundo 99) pasaría el regex y se propagaría como si fuera una fecha
// de calendario válida, contaminando el modelo de dominio aguas abajo. Se añade
// validación semántica de RANGO tras el match de forma.
function validarComponentesFecha(anio: string, mes: string, dia: string, contexto: string): void {
  const a = Number(anio);
  const m = Number(mes);
  const d = Number(dia);
  // Hallazgo de auditoría (a3, MEDIA, verificado contra Postgres real) — sin este
  // chequeo, un VEVENT con `DTSTART:00000101` (año "0000", forma sintácticamente
  // válida según el regex de 4 dígitos de `parsearValorFecha`) producía la fecha
  // '0000-01-01', que Postgres real rechaza con `22008` ("date/time field value out of
  // range") en cuanto `listCanalesExportadosDeRango`/`daterange()` la usa —
  // exactamente el mismo camino de "abortar la transacción del feed completo" que el
  // SEQUENCE fuera de rango de abajo. Se rechaza aquí, en el dominio, ANTES de
  // cualquier SQL — mismo criterio que el rango invertido de `esRangoValido`
  // (motor.ts:94).
  if (a < 1) {
    throw new IcsParseError("valor_fecha_invalido", `${contexto}: año fuera de rango (mínimo 0001): "${anio}"`);
  }
  if (m < 1 || m > 12) {
    throw new IcsParseError("valor_fecha_invalido", `${contexto}: mes fuera de rango 01-12: "${mes}"`);
  }
  // Truco estándar: día 0 del mes `m` (tratado como índice 0-based, es decir el mes
  // SIGUIENTE al humano `m`) es el último día del mes humano `m` — respeta años
  // bisiestos automáticamente vía Date.UTC.
  const diasEnElMes = new Date(Date.UTC(a, m, 0)).getUTCDate();
  if (d < 1 || d > diasEnElMes) {
    throw new IcsParseError(
      "valor_fecha_invalido",
      `${contexto}: día fuera de rango para el mes ${mes} (máximo ${diasEnElMes}): "${dia}"`,
    );
  }
}

function validarComponentesHora(hora: string, minuto: string, segundo: string, contexto: string): void {
  if (Number(hora) > 23) {
    throw new IcsParseError("valor_fecha_invalido", `${contexto}: hora fuera de rango 00-23: "${hora}"`);
  }
  if (Number(minuto) > 59) {
    throw new IcsParseError("valor_fecha_invalido", `${contexto}: minuto fuera de rango 00-59: "${minuto}"`);
  }
  if (Number(segundo) > 59) {
    throw new IcsParseError("valor_fecha_invalido", `${contexto}: segundo fuera de rango 00-59: "${segundo}"`);
  }
}

function parsearValorFecha(linea: LineaContenido): ValorFechaIcs {
  const valorParam = linea.parametros.get("VALUE");
  const tzid = linea.parametros.get("TZID");
  const v = linea.valor.trim();

  if (valorParam === "DATE" || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) throw new IcsParseError("valor_fecha_invalido", `DATE inválido: "${v}"`);
    validarComponentesFecha(m[1]!, m[2]!, m[3]!, `DATE "${v}"`);
    return { tipo: "DATE", fecha: `${m[1]}-${m[2]}-${m[3]}` };
  }

  const mDt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!mDt) throw new IcsParseError("valor_fecha_invalido", `DATE-TIME inválido: "${v}"`);
  const [, aa, mm, dd, hh, mi, ss, z] = mDt;
  validarComponentesFecha(aa!, mm!, dd!, `DATE-TIME "${v}"`);
  validarComponentesHora(hh!, mi!, ss!, `DATE-TIME "${v}"`);
  const fechaHoraLocal = `${aa}-${mm}-${dd}T${hh}:${mi}:${ss}`;

  if (z === "Z") {
    return { tipo: "DATE-TIME-UTC", instanteIso: `${fechaHoraLocal}Z` };
  }
  if (tzid) {
    return { tipo: "DATE-TIME-TZID", tzid, fechaHoraLocal };
  }
  return { tipo: "DATE-TIME-FLOTANTE", fechaHoraLocal };
}

/** `DURATION` (RFC 5545 §3.3.6), p. ej. `P3D`, `P1W`, `PT2H30M`. Se suma en días de
 * calendario si `dtstart` es `DATE`; en segundos si es DATE-TIME (aproximación
 * suficiente para el caso de uso de disponibilidad: los feeds observados usan DTEND
 * explícito). */
function calcularDtendDesdeDuration(dtstart: ValorFechaIcs, duration: string): ValorFechaIcs {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!m) throw new IcsParseError("duration_invalida", `DURATION inválida: "${duration}"`);
  const signo = m[1] === "-" ? -1 : 1;
  const semanas = Number(m[2] ?? 0);
  const dias = Number(m[3] ?? 0);
  const horas = Number(m[4] ?? 0);
  const minutos = Number(m[5] ?? 0);
  const segundos = Number(m[6] ?? 0);
  const totalDias = signo * (semanas * 7 + dias);
  const totalSegundos = signo * (horas * 3600 + minutos * 60 + segundos);

  if (dtstart.tipo === "DATE") {
    const [aa, mm, dd] = dtstart.fecha.split("-").map(Number);
    const fecha = new Date(Date.UTC(aa!, mm! - 1, dd!));
    fecha.setUTCDate(fecha.getUTCDate() + totalDias);
    const iso = fecha.toISOString().slice(0, 10);
    return { tipo: "DATE", fecha: iso };
  }

  const instanteBase = dtstart.tipo === "DATE-TIME-UTC" ? dtstart.instanteIso : `${dtstart.fechaHoraLocal}Z`;
  const fecha = new Date(instanteBase);
  fecha.setUTCDate(fecha.getUTCDate() + totalDias);
  fecha.setUTCSeconds(fecha.getUTCSeconds() + totalSegundos);
  if (dtstart.tipo === "DATE-TIME-TZID") {
    return { tipo: "DATE-TIME-TZID", tzid: dtstart.tzid, fechaHoraLocal: fecha.toISOString().slice(0, 19) };
  }
  if (dtstart.tipo === "DATE-TIME-UTC") {
    return { tipo: "DATE-TIME-UTC", instanteIso: fecha.toISOString() };
  }
  return { tipo: "DATE-TIME-FLOTANTE", fechaHoraLocal: fecha.toISOString().slice(0, 19) };
}

// ---------------------------------------------------------------------------
// VEVENT
// ---------------------------------------------------------------------------

function normalizarStatus(valor: string | undefined): EstadoEventoIcs {
  if (!valor) return null;
  const v = valor.toUpperCase();
  if (v === "TENTATIVE" || v === "CONFIRMED" || v === "CANCELLED") return v;
  return null;
}

function construirVEvent(lineas: LineaContenido[]): VEventNormalizado {
  const porNombre = new Map<string, LineaContenido>();
  for (const linea of lineas) {
    // RFC 5545 no prohíbe repetir una propiedad, pero para las que este parser modela
    // como escalares nos quedamos con la última ocurrencia (comportamiento tolerante y
    // documentado, no un fallo).
    porNombre.set(linea.nombre, linea);
  }

  const uidLinea = porNombre.get("UID");
  const dtstampLinea = porNombre.get("DTSTAMP");
  const dtstartLinea = porNombre.get("DTSTART");
  if (!uidLinea) throw new IcsParseError("campo_requerido_ausente", "VEVENT sin UID (RFC 5545 §3.8.4.7)");
  // Un `UID:` presente pero vacío (tras trim()) se trata igual que ausente — combinado
  // con "última ocurrencia gana" arriba, un UID vacío inyectado al final colisionaría
  // trivialmente con cualquier otro evento del mismo feed.
  if (uidLinea.valor.trim() === "") {
    throw new IcsParseError("campo_requerido_ausente", "VEVENT con UID vacío (RFC 5545 §3.8.4.7)");
  }
  if (!dtstampLinea) throw new IcsParseError("campo_requerido_ausente", "VEVENT sin DTSTAMP (RFC 5545 §3.8.7.2)");
  if (!dtstartLinea) throw new IcsParseError("campo_requerido_ausente", "VEVENT sin DTSTART (RFC 5545 §3.6.1)");

  const dtstamp = parsearValorFecha(dtstampLinea);
  const dtstampIso =
    dtstamp.tipo === "DATE-TIME-UTC"
      ? dtstamp.instanteIso
      : dtstamp.tipo === "DATE"
        ? `${dtstamp.fecha}T00:00:00Z`
        : `${dtstamp.fechaHoraLocal}Z`;

  const dtstart = parsearValorFecha(dtstartLinea);

  let dtend: ValorFechaIcs;
  const dtendLinea = porNombre.get("DTEND");
  const durationLinea = porNombre.get("DURATION");
  if (dtendLinea) {
    dtend = parsearValorFecha(dtendLinea);
  } else if (durationLinea) {
    dtend = calcularDtendDesdeDuration(dtstart, durationLinea.valor.trim());
  } else {
    // RFC 5545 §3.8.2.2: sin DTEND ni DURATION, la duración implícita es un día
    // natural (DATE) o el mismo día calendario (DATE-TIME).
    dtend = calcularDtendDesdeDuration(dtstart, "P1D");
  }

  const sequenceLinea = porNombre.get("SEQUENCE");
  const sequence = sequenceLinea ? Number.parseInt(sequenceLinea.valor.trim(), 10) : null;

  const lastModifiedLinea = porNombre.get("LAST-MODIFIED");
  let lastModifiedIso: string | null = null;
  if (lastModifiedLinea) {
    const v = parsearValorFecha(lastModifiedLinea);
    lastModifiedIso =
      v.tipo === "DATE-TIME-UTC" ? v.instanteIso : v.tipo === "DATE" ? `${v.fecha}T00:00:00Z` : `${v.fechaHoraLocal}Z`;
  }

  return {
    uid: uidLinea.valor.trim(),
    // Hallazgo de auditoría (a3, MEDIA, verificado contra Postgres real) — antes,
    // `Number.isFinite` aceptaba CUALQUIER entero representable como `number`
    // (`SEQUENCE:9999999999`, típico de un canal que manda un timestamp en
    // milisegundos por error). La columna real es `sequence integer` (Postgres
    // int4, supabase/migrations/20240101000057_008_ical_sync_schema.sql:63) — ese
    // valor pasa el parser, `crearReservaConfirmada` corre con éxito, y
    // `upsertEventoImportado` lanza `22003` ("numeric value out of range") al
    // intentar persistirlo, dejando la transacción del feed ABORTADA para todos los
    // eventos siguientes (mismo camino de falla que el NOT NULL de arriba). Se
    // acota aquí, en el dominio, ANTES de cualquier SQL: fuera de rango (o
    // negativo, RFC 5545 §3.8.7.4 nunca lo permite) se trata como "sin SEQUENCE"
    // (`null`), igual que un SEQUENCE ausente — nunca aborta el evento completo por
    // esto solo.
    sequence: sequence !== null && Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 2147483647 ? sequence : null,
    dtstamp: dtstampIso,
    lastModifiedIso,
    dtstart,
    dtend,
    status: normalizarStatus(porNombre.get("STATUS")?.valor.trim()),
    summary: porNombre.get("SUMMARY")?.valor.trim() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Entrada pública
// ---------------------------------------------------------------------------

export function parsearIcs(contenido: string | Buffer, limites: LimitesParserIcs = LIMITES_ICS_POR_DEFECTO): CalendarioIcsNormalizado {
  const bytes = typeof contenido === "string" ? Buffer.byteLength(contenido, "utf8") : contenido.length;
  if (bytes > limites.maxBytes) {
    throw new IcsParseError("tamano_excedido", `feed de ${bytes} bytes excede el límite configurado de ${limites.maxBytes} bytes`);
  }
  const texto = typeof contenido === "string" ? contenido : contenido.toString("utf8");
  const normalizado = normalizarSaltosDeLinea(texto);
  const lineasDesplegadas = desplegarLineas(normalizado, limites);
  if (lineasDesplegadas.length === 0) {
    throw new IcsParseError("estructura_desbalanceada", "feed vacío o sin líneas de contenido reconocibles");
  }

  const primera = parsearLineaContenido(lineasDesplegadas[0]!);
  if (primera.nombre !== "BEGIN" || primera.valor.trim().toUpperCase() !== "VCALENDAR") {
    throw new IcsParseError("estructura_desbalanceada", "el feed no inicia con BEGIN:VCALENDAR");
  }

  const pila: string[] = [];
  const eventos: VEventNormalizado[] = [];
  let lineasVEventoActual: LineaContenido[] | null = null;

  for (const lineaCruda of lineasDesplegadas) {
    const linea = parsearLineaContenido(lineaCruda);

    if (linea.nombre === "BEGIN") {
      const componente = linea.valor.trim().toUpperCase();
      pila.push(componente);
      if (componente === "VEVENT") {
        lineasVEventoActual = [];
      }
      continue;
    }

    if (linea.nombre === "END") {
      const componente = linea.valor.trim().toUpperCase();
      const abierto = pila.pop();
      if (abierto !== componente) {
        throw new IcsParseError("estructura_desbalanceada", `END:${componente} sin BEGIN:${componente} correspondiente (abierto: ${abierto ?? "ninguno"})`);
      }
      if (componente === "VEVENT") {
        if (!lineasVEventoActual) {
          throw new IcsParseError("estructura_desbalanceada", "END:VEVENT sin contenido acumulado");
        }
        eventos.push(construirVEvent(lineasVEventoActual));
        if (eventos.length > limites.maxEventos) {
          throw new IcsParseError("demasiados_eventos", `el feed excede el límite configurado de ${limites.maxEventos} eventos`);
        }
        lineasVEventoActual = null;
      }
      continue;
    }

    // Propiedad dentro de un componente: solo se acumula si estamos dentro de un
    // VEVENT (propiedades de VTIMEZONE/VALARM/otros componentes se ignoran sin fallar
    // el parseo).
    if (lineasVEventoActual) {
      lineasVEventoActual.push(linea);
    }
  }

  if (pila.length !== 0) {
    throw new IcsParseError("estructura_desbalanceada", `componente(s) sin cerrar al final del feed: ${pila.join(", ")}`);
  }

  return { eventos };
}

export { IcsParseError } from "./tipos.ts";
export type { CalendarioIcsNormalizado, VEventNormalizado, ValorFechaIcs, EstadoEventoIcs, LimitesParserIcs } from "./tipos.ts";
export { LIMITES_ICS_POR_DEFECTO } from "./tipos.ts";

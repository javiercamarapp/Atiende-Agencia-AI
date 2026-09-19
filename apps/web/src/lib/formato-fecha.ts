// Fecha corta real para la píldora de `DashboardHeader` ("16 sept 2026") -- una
// sola función compartida por los 7 Shells en vez de que cada uno arme su
// propio `toLocaleDateString` (mismo criterio de "un solo lugar" que
// `useNotifications.ts`). `DashboardHeader` en sí NO formatea fechas a
// propósito (ver su comentario de cabecera) -- esto vive aquí, no ahí.
export function fechaCortaEsMx(fecha: Date = new Date()): string {
  return fecha.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

// --- Fechas de "solo día" (columnas `date` de Postgres: "YYYY-MM-DD", sin ---
// --- hora ni zona) -- vencimientos, fecha límite fiscal, check-in/check-out, ---
// --- periodos de estado de cuenta, fechas de factura, etc. -----------------
//
// BUG REAL (confirmado por un revisor, despachos/pages/Cobranza.tsx): pasar
// una de estas cadenas a `new Date(cadena)` la interpreta como MEDIANOCHE
// UTC (así lo define el spec de ISO 8601 para fechas sin hora). Formatearla
// luego con `toLocaleDateString`/`Intl.DateTimeFormat` SIN forzar una zona
// (el default es la zona LOCAL del navegador) hace que en cualquier zona con
// offset negativo -- América completa, incluida America/Mexico_City, UTC-6 --
// el día mostrado sea el ANTERIOR al real. Un despacho ve vencimientos de
// cobranza con la fecha equivocada.
//
// El fix NO es "convertir a la zona del negocio" (eso es lo correcto para
// timestamps reales con hora, como `pagado_en`/`creado_en` -- ver
// `despachos/lib/format.ts::formatDate`). Para una columna `date`, el valor
// YA ES el día de calendario decidido por el negocio (Postgres nunca guardó
// hora); mostrarlo es solo un problema de FORMATO, nunca de conversión de
// zona. `formatFechaSolo` ancla la cadena a medianoche UTC y SIEMPRE formatea
// con `timeZone: "UTC"` -- el mismo día calendario que la BD mandó, sin
// importar en qué zona esté el navegador de quien lo ve. Mismo criterio de
// fondo (nunca dejar que la zona del navegador corra el día) ya usado, de
// forma aislada y con su propia variante, antes de este helper, en
// `licitaciones/RadarRenovaciones.tsx::formatDateOnly` (ancla UTC + `timeZone:
// "UTC"`, igual que aquí) y en `superadmin/Resumen.tsx::fechaLegible` (ancla
// a T12:00:00Z -- mediodía UTC, no medianoche -- + `timeZone:
// "America/Mexico_City"`, no "UTC"): mismo problema, solución distinta pero
// igualmente correcta para ese caso puntual, NO "el mismo criterio" textual.
const FECHA_SOLO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Defensa en profundidad (bug real reportado por un revisor, ver
// `postgres-repository.ts::FISCAL_DEADLINE_COLUMNS`/`RECEIVABLE_COLUMNS` de
// `@atiende/domain-despachos`): contra Postgres real, sin `setTypeParser` en
// `managed-postgres-engine.ts`, una columna `date` sin castear a `::text`
// llega aquí como el ISO completo que produce `Date.prototype.toJSON()` al
// serializar por `c.json()` -- "2026-08-15T00:00:00.000Z" (con TZ=UTC, que es
// Vercel) -- no como "YYYY-MM-DD". El arreglo de fondo es castear en el
// repositorio (ya hecho); esto es la red de seguridad en la UI para que un
// futuro `select *`/`returning *` sin castear en CUALQUIER vertical degrade a
// "un día antes" nunca más, vuelva a "—" en vez de reventar, y sí siga
// pintando la fecha correcta mientras tanto.
const FECHA_SOLO_ISO_ANCLADA_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/;

/** "YYYY-MM-DD" si `valor` es una fecha de solo-día en cualquiera de sus dos
 * formas válidas ("YYYY-MM-DD" estricto, o el ISO de medianoche UTC que
 * produce serializar un `date` de Postgres sin castear -- ver
 * `FECHA_SOLO_ISO_ANCLADA_RE`); `null` si no matchea ninguna. */
function normalizarFechaSolo(valor: string): string | null {
  if (FECHA_SOLO_RE.test(valor)) return valor;
  return FECHA_SOLO_ISO_ANCLADA_RE.exec(valor)?.[1] ?? null;
}

/** `true` si `valor` tiene la forma exacta "YYYY-MM-DD" (columna `date`, sin hora). */
export function esFechaSolo(valor: string): boolean {
  return FECHA_SOLO_RE.test(valor);
}

/**
 * Convierte "YYYY-MM-DD" a un `Date` anclado a medianoche UTC de ESE MISMO día
 * calendario -- para comparar/ordenar (`getTime()`), nunca para leer sus
 * componentes con getters LOCALES (`getDate()`/`getMonth()`, que sí siguen la
 * zona del navegador) ni para formatear sin fijar `timeZone: "UTC"`.
 */
export function parseFechaSolo(fecha: string): Date {
  if (!FECHA_SOLO_RE.test(fecha)) {
    throw new Error(`parseFechaSolo: se esperaba "YYYY-MM-DD", se recibió: ${JSON.stringify(fecha)}`);
  }
  return new Date(`${fecha}T00:00:00Z`);
}

const FECHA_SOLO_FORMATTER_CORTA = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const FECHA_SOLO_FORMATTER_LARGA = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Formatea una fecha de solo-día ("YYYY-MM-DD", p. ej. `fechaVencimiento`,
 * `fechaLimite`) como "15 ago 2026" ("corta") o "15 de agosto de 2026"
 * ("larga") -- NUNCA corre un día por la zona del navegador. `null`/vacío/
 * formato inesperado -> "—" (mismo criterio "honesto" que el resto del panel:
 * nunca fabrica una fecha).
 */
export function formatFechaSolo(fecha: string | null | undefined, variante: "corta" | "larga" = "corta"): string {
  const soloDia = fecha ? normalizarFechaSolo(fecha) : null;
  if (!soloDia) return "—";
  const instante = parseFechaSolo(soloDia);
  // Bug real (revisión r6, punto 5): `FECHA_SOLO_RE`/`FECHA_SOLO_ISO_ANCLADA_RE` solo
  // validan la FORMA ("YYYY-MM-DD"), nunca que mes/día sean valores de calendario
  // posibles -- una cadena bien formada pero imposible (p.ej. "2026-13-45", que puede
  // llegar aquí desde datos corruptos o un select* sin castear en el futuro) produce un
  // `Invalid Date` en `parseFechaSolo`, y `Intl.DateTimeFormat.format` lanza
  // `RangeError: Invalid time value` sobre un Invalid Date en pleno render -- nunca lo
  // atrapaba nada, tumbando la página completa. Mismo criterio "honesto" que el resto de
  // esta función: valor inesperado -> guion, nunca una excepción sin capturar.
  if (Number.isNaN(instante.getTime())) return "—";
  const formatter = variante === "larga" ? FECHA_SOLO_FORMATTER_LARGA : FECHA_SOLO_FORMATTER_CORTA;
  return formatter.format(instante);
}

/**
 * "Hoy" como "YYYY-MM-DD" en el DÍA DE CALENDARIO del negocio (América/Ciudad
 * de México por default), no en UTC. Reemplaza el patrón
 * `new Date().toISOString().slice(0, 10)` -- ese usa el día UTC, que va un
 * día ADELANTE del día real en CDMX entre las 18:00 y las 23:59 hora local
 * (00:00-05:59 UTC), p. ej. para precargar el default de un `<input
 * type="date">` (fecha de una póliza contable, de un ajuste, de verificación
 * de una factura). Formato "en-CA" da "YYYY-MM-DD" directo, sin parsear texto.
 */
export function hoyFechaSolo(zonaHoraria: string = "America/Mexico_City"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zonaHoraria, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// --- Instante UTC de la medianoche LOCAL de un día de calendario ----------
//
// BUG REAL (revisión de PR #164, "no bloqueante" #2, `restaurantes/pages/Historial.tsx`):
// convertir el valor de un `<input type="date">` ("YYYY-MM-DD") a un filtro de servidor
// con `new Date(fecha).toISOString()` da la medianoche UTC de ESE día -- que en CUALQUIER
// zona con offset negativo (América completa) es una hora del día ANTERIOR local. El
// servidor filtra rangos reales (`created_at >= dateFrom`/`created_at < dateTo`, columnas
// `timestamptz`, NO `date`) contra el día de calendario del NEGOCIO: "hasta el 15" debe
// incluir TODO el 15 local, no cortar a las 18:00 CDMX del 14. Esto es la conversión de
// zona real (a diferencia de `formatFechaSolo` de arriba, que es solo FORMATO de una
// columna `date` -- ver el comentario de cabecera de esa sección): "medianoche del día X
// en la zona del negocio" es un instante UTC distinto según la zona, y varía por fecha si
// esa zona observa horario de verano (México ya no, desde 2022, salvo la franja fronteriza
// -- por eso esto usa `Intl` en vez de asumir un offset fijo).
const FECHA_SOLO_ISO_TIMESTAMP_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function timestampPartsFormatter(zonaHoraria: string): Intl.DateTimeFormat {
  let formatter = FECHA_SOLO_ISO_TIMESTAMP_FORMATTER_CACHE.get(zonaHoraria);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zonaHoraria,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FECHA_SOLO_ISO_TIMESTAMP_FORMATTER_CACHE.set(zonaHoraria, formatter);
  }
  return formatter;
}

/**
 * Instante UTC de la medianoche LOCAL (00:00 en `zonaHoraria`) del día de calendario
 * "YYYY-MM-DD" dado -- p. ej. `medianocheLocalUTC("2026-08-15")` da el instante UTC en
 * que empieza el 15 de agosto en CDMX (06:00 UTC ese día, con el offset fijo -06:00
 * vigente desde 2022). Truco estándar (mismo que usa `date-fns-tz`): parte de una
 * medianoche UTC como estimación, mide cuánto se desvía esa estimación al formatearla EN
 * la zona destino, y corrige por esa diferencia -- así funciona sin asumir un offset fijo
 * ni tener acceso a una base de datos de zonas horarias propia (usa la del motor de JS vía
 * `Intl`).
 */
export function medianocheLocalUTC(fecha: string, zonaHoraria: string = "America/Mexico_City"): Date {
  const estimacionUTC = parseFechaSolo(fecha).getTime();
  const partes = timestampPartsFormatter(zonaHoraria).formatToParts(new Date(estimacionUTC));
  const valores: Record<string, string> = {};
  for (const parte of partes) if (parte.type !== "literal") valores[parte.type] = parte.value;
  const hora = valores.hour === "24" ? 0 : Number(valores.hour);
  const comoSiFueraUTC = Date.UTC(Number(valores.year), Number(valores.month) - 1, Number(valores.day), hora, Number(valores.minute), Number(valores.second));
  const desfaseMs = comoSiFueraUTC - estimacionUTC;
  return new Date(estimacionUTC - desfaseMs);
}

/** Suma (o resta, con `dias` negativo) días de calendario a "YYYY-MM-DD" -- aritmética
 * pura sobre el día UTC-anclado (`parseFechaSolo`), nunca se ve afectada por ninguna zona
 * horaria: el día calendario siguiente a cualquier fecha es el mismo en cualquier parte
 * del mundo. */
export function sumarDiasFechaSolo(fecha: string, dias: number): string {
  const d = parseFechaSolo(fecha);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

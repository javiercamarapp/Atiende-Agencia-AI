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
// importar en qué zona esté el navegador de quien lo ve. Mismo criterio ya
// usado (de forma aislada, antes de este helper) en
// `licitaciones/RadarRenovaciones.tsx::formatDateOnly` y
// `superadmin/Resumen.tsx`, ahora centralizado aquí para las 6 verticales.
const FECHA_SOLO_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!fecha || !FECHA_SOLO_RE.test(fecha)) return "—";
  const formatter = variante === "larga" ? FECHA_SOLO_FORMATTER_LARGA : FECHA_SOLO_FORMATTER_CORTA;
  return formatter.format(parseFechaSolo(fecha));
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

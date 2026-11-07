import { LOCALE_POR_IDIOMA, type Idioma } from "./tipos.ts";

export { LOCALE_POR_IDIOMA };

/**
 * Formato de numeros, dinero, porcentajes y fechas por idioma, todo con `Intl` (sin dependencias). El espanol es `es-MX` y el
 * ingles `en-US`: 1,234.50 en los dos (Mexico usa coma de miles y punto decimal), pero «6 nov 2026» vs «Nov 6, 2026».
 * El dinero sale con el simbolo corto («$1,234.50») en los dos idiomas: «MX$» en ingles se lee extrano para el dueno de un
 * negocio mexicano. Los formateadores se guardan en cache por (locale, opciones): crear un `Intl.*Format` es caro.
 * En componentes: `useFormatos()` (idioma activo). Este modulo NO lo importa el proveedor, asi solo entra al bundle de quien
 * formatea.
 */

const cache = /* @__PURE__ */ new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.PluralRules | Intl.ListFormat>();

function enCache<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.PluralRules | Intl.ListFormat>(
  tipo: string,
  locale: string,
  opciones: object | undefined,
  crear: () => T,
): T {
  const clave = `${tipo}|${locale}|${opciones ? JSON.stringify(opciones) : ""}`;
  let f = cache.get(clave) as T | undefined;
  if (!f) {
    f = crear();
    cache.set(clave, f);
  }
  return f;
}

export function reglaPlural(idioma: Idioma): Intl.PluralRules {
  const locale = LOCALE_POR_IDIOMA[idioma];
  return enCache("plural", locale, undefined, () => new Intl.PluralRules(locale));
}

export type EstiloFecha = "corta" | "media" | "larga" | "diaMes" | "mesAnio";

const OPCIONES_FECHA: Readonly<Record<EstiloFecha, Intl.DateTimeFormatOptions>> = {
  corta: { day: "2-digit", month: "2-digit", year: "numeric" },
  media: { day: "numeric", month: "short", year: "numeric" },
  larga: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  diaMes: { day: "numeric", month: "short" },
  mesAnio: { month: "long", year: "numeric" },
};

export interface OpcionesMoneda {
  /** ISO 4217; por omision MXN. */
  readonly moneda?: string;
  /** 0 o 2 decimales (por omision 2). */
  readonly decimales?: 0 | 2;
}

export interface Formatos {
  readonly locale: string;
  numero(valor: number, opciones?: Intl.NumberFormatOptions): string;
  moneda(valor: number, opciones?: OpcionesMoneda): string;
  /** `valor` es una fraccion: 0.125 -> «12.5%». */
  porcentaje(valor: number, decimales?: number): string;
  fecha(valor: Date | string | number, estilo?: EstiloFecha, zonaHoraria?: string): string;
  hora(valor: Date | string | number, zonaHoraria?: string): string;
  fechaHora(valor: Date | string | number, zonaHoraria?: string): string;
  /** «hace 5 minutos» / «5 minutes ago», «en 2 dias» / «in 2 days». `ahora` se inyecta en pruebas. */
  relativo(valor: Date | string | number, ahora?: Date | number): string;
  /** «A, B y C» / «A, B, and C». */
  lista(elementos: readonly string[]): string;
}

const aFecha = (v: Date | string | number): Date => (v instanceof Date ? v : new Date(v));

const UNIDADES: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function crearFormatos(idioma: Idioma): Formatos {
  const locale = LOCALE_POR_IDIOMA[idioma];
  return {
    locale,
    numero: (valor, opciones) => enCache("num", locale, opciones, () => new Intl.NumberFormat(locale, opciones)).format(valor),
    moneda: (valor, opciones) => {
      const decimales = opciones?.decimales ?? 2;
      const moneda = opciones?.moneda ?? "MXN";
      const o: Intl.NumberFormatOptions = {
        style: "currency",
        currency: moneda,
        // «$» solo para pesos; otra moneda lleva su codigo («USD 10.00») para no confundirse con MXN (costos de IA en USD).
        currencyDisplay: moneda === "MXN" ? "narrowSymbol" : "code",
        minimumFractionDigits: decimales,
        maximumFractionDigits: decimales,
      };
      return enCache("num", locale, o, () => new Intl.NumberFormat(locale, o)).format(valor);
    },
    porcentaje: (valor, decimales = 0) => {
      const o: Intl.NumberFormatOptions = { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: decimales };
      return enCache("num", locale, o, () => new Intl.NumberFormat(locale, o)).format(valor);
    },
    fecha: (valor, estilo = "media", zonaHoraria) => {
      const o: Intl.DateTimeFormatOptions = { ...OPCIONES_FECHA[estilo], ...(zonaHoraria ? { timeZone: zonaHoraria } : {}) };
      return enCache("fecha", locale, o, () => new Intl.DateTimeFormat(locale, o)).format(aFecha(valor));
    },
    hora: (valor, zonaHoraria) => {
      const o: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", ...(zonaHoraria ? { timeZone: zonaHoraria } : {}) };
      return enCache("fecha", locale, o, () => new Intl.DateTimeFormat(locale, o)).format(aFecha(valor));
    },
    fechaHora: (valor, zonaHoraria) => {
      const o: Intl.DateTimeFormatOptions = {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(zonaHoraria ? { timeZone: zonaHoraria } : {}),
      };
      return enCache("fecha", locale, o, () => new Intl.DateTimeFormat(locale, o)).format(aFecha(valor));
    },
    relativo: (valor, ahora = Date.now()) => {
      const segundos = Math.round((aFecha(valor).getTime() - (ahora instanceof Date ? ahora.getTime() : ahora)) / 1000);
      const rtf = enCache("rel", locale, undefined, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
      for (const [unidad, s] of UNIDADES) {
        if (Math.abs(segundos) >= s || unidad === "second") return rtf.format(Math.round(segundos / s), unidad);
      }
      return rtf.format(0, "second");
    },
    lista: (elementos) => enCache("lista", locale, undefined, () => new Intl.ListFormat(locale, { style: "long", type: "conjunction" })).format(elementos),
  };
}

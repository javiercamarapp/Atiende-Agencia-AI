// Cifras y montos (ds3, «sin estilo reloj»): formato puro y particion en partes para que <Cifra> pinte el signo de moneda y los
// decimales mas chicos y tenues (como Rovaq), con separador de miles es-MX y forma compacta ($1.2 M) cuyo valor completo va en el
// titulo. NUNCA calcula ni redondea dinero: solo da forma a la cifra que el backend ya calculo. `null`/no finito = «—», jamas 0.

import { numeroEsMx } from "./formato-preset";

export type CifraVariante = "dinero" | "conteo" | "porcentaje" | "compacto";
export type CifraLocale = "es-MX" | "en-US";

export interface OpcionesCifra {
  readonly variante?: CifraVariante;
  /** Solo dinero/compacto: MXN pinta «$», USD pinta «US$» (formato unico del repo). */
  readonly moneda?: "MXN" | "USD";
  /** Decimales fijos. Por omision: dinero 2, conteo 0, porcentaje 0 (hasta 1 si no es entero), compacto 1. */
  readonly decimales?: number;
  readonly locale?: CifraLocale;
  /** Signo explicito en positivos («+12 %»): para variaciones. */
  readonly conSigno?: boolean;
  /** Compacto solo desde este valor absoluto; debajo se pinta completo. Por omision 10 000. */
  readonly compactoDesde?: number;
}

/** La cifra partida en piezas: `entero` es la parte protagonista; el resto se atenua. */
export interface PartesCifra {
  readonly signo: string;
  readonly simbolo: string;
  readonly entero: string;
  /** Incluye el separador decimal («.50»), o vacio. */
  readonly decimales: string;
  /** «%», « M», « k»... con su espacio. */
  readonly sufijo: string;
  /** Texto completo, igual a la concatenacion de las partes. */
  readonly texto: string;
  /** Valor completo sin compactar (para el titulo). Igual a `texto` cuando no se compacta. */
  readonly completo: string;
  readonly valor: number | null;
}

export const SIN_CIFRA = "—";
const MENOS = "-";

function simboloDe(moneda: "MXN" | "USD" | undefined): string {
  return moneda === "USD" ? "US$" : "$";
}

// es-MX y en-US comparten separadores («,» de miles y «.» decimal): el numero sale SIEMPRE del formateador canonico
// (formato-preset.ts, guard PL-19) y el locale solo decide los sufijos de escala del compacto.
function numero(abs: number, decimales: number, _locale: CifraLocale): string {
  return numeroEsMx(abs, decimales);
}

// es-MX y en-US comparten separadores: «,» de miles y «.» decimal.
function partir(textoNumero: string, _locale: CifraLocale): { entero: string; decimales: string } {
  const i = textoNumero.lastIndexOf(".");
  if (i < 0) return { entero: textoNumero, decimales: "" };
  return { entero: textoNumero.slice(0, i), decimales: textoNumero.slice(i) };
}

const ESCALAS_ES: ReadonlyArray<readonly [number, string]> = [
  [1e9, " mil M"],
  [1e6, " M"],
  [1e3, " k"],
];
const ESCALAS_EN: ReadonlyArray<readonly [number, string]> = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

function armar(valor: number, signo: string, simbolo: string, cuerpo: string, sufijo: string, locale: CifraLocale, completo?: string): PartesCifra {
  const { entero, decimales } = partir(cuerpo, locale);
  const texto = `${signo}${simbolo}${entero}${decimales}${sufijo}`;
  return { signo, simbolo, entero, decimales, sufijo, texto, completo: completo ?? texto, valor };
}

/** Formatea y parte una cifra. `null`, `undefined`, NaN o Infinity => «—» (sin dato), nunca 0. */
export function partesCifra(valor: number | null | undefined, opciones: OpcionesCifra = {}): PartesCifra {
  const { variante = "conteo", moneda, locale = "es-MX", conSigno = false } = opciones;
  if (valor === null || valor === undefined || !Number.isFinite(valor)) {
    return { signo: "", simbolo: "", entero: SIN_CIFRA, decimales: "", sufijo: "", texto: SIN_CIFRA, completo: SIN_CIFRA, valor: null };
  }
  const abs = Math.abs(valor);
  const signo = valor < 0 && abs > 0 ? MENOS : conSigno && valor > 0 ? "+" : "";

  if (variante === "porcentaje") {
    const dec = opciones.decimales ?? (Number.isInteger(abs) ? 0 : 1);
    // es-MX y en-US escriben el porcentaje pegado: «12%» (formato unico del repo, sin espacio).
    return armar(valor, signo, "", numero(abs, dec, locale), "%", locale);
  }

  if (variante === "compacto") {
    const simbolo = moneda ? simboloDe(moneda) : "";
    const desde = opciones.compactoDesde ?? 10_000;
    const completoDec = moneda ? 2 : 0;
    const completo = `${signo}${simbolo}${numero(abs, completoDec, locale)}`;
    if (abs >= desde) {
      for (const [base, suf] of locale === "en-US" ? ESCALAS_EN : ESCALAS_ES) {
        if (abs >= base) {
          const dec = opciones.decimales ?? 1;
          const factor = 10 ** dec;
          // Trunca (no redondea hacia arriba): 999 999 nunca se lee «1.0 M» de mas. Quita el «.0» sobrante.
          // El redondeo a 1e-6 antes del floor evita el error de flotante (4.35 * 100 = 434.999...).
          const escalado = Math.floor(Math.round((abs / base) * factor * 1e6) / 1e6) / factor;
          let cuerpo = numero(escalado, dec, locale);
          if (dec > 0 && /\.0+$/.test(cuerpo)) cuerpo = cuerpo.replace(/\.0+$/, "");
          return armar(valor, signo, simbolo, cuerpo, suf, locale, completo);
        }
      }
    }
    return armar(valor, signo, simbolo, numero(abs, opciones.decimales ?? completoDec, locale), "", locale, completo);
  }

  if (variante === "dinero") {
    return armar(valor, signo, simboloDe(moneda), numero(abs, opciones.decimales ?? 2, locale), "", locale);
  }

  // conteo
  return armar(valor, signo, "", numero(abs, opciones.decimales ?? 0, locale), "", locale);
}

/** Solo el texto («$1,234.50», «—»). */
export function formatearCifra(valor: number | null | undefined, opciones: OpcionesCifra = {}): string {
  return partesCifra(valor, opciones).texto;
}

/**
 * Parte un texto YA formateado por la pagina («$12,500.00», «US$0.0042», «-8%», «1,204», «3.4 M») para pintarlo con las mismas
 * piezas sin cambiar un solo caracter. Si el texto no es una cifra simple («12 de 30», «3 h 20 min», «—») devuelve `null` y se pinta tal cual.
 * `valor` es el numero leido (para el conteo animado) y `decimalesTexto` cuantos decimales trae, para volver a escribirlo identico.
 */
export interface PartesTexto extends PartesCifra {
  readonly decimalesTexto: number;
}

const PATRON_TEXTO = /^([+\-−]?)(US\$|MX\$|\$|€)?(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?(%| ?(?:k|K|M|B|mil M|MXN|USD))?$/;

export function partirTextoCifra(texto: string): PartesTexto | null {
  const m = PATRON_TEXTO.exec(texto.trim());
  if (!m) return null;
  const [, s = "", simbolo = "", entero = "", decimales = "", sufijo = ""] = m;
  // Mas de 3 digitos SIN separador de miles («2026», «12345») no es un monto de la casa: puede ser un año o un folio. Se pinta
  // tal cual, sin conteo (el conteo lo reescribiria con comas).
  if (!entero.includes(",") && entero.length > 3) return null;
  const signo = s === "−" ? "−" : s;
  const n = Number(`${entero.replace(/,/g, "")}${decimales}`);
  if (!Number.isFinite(n)) return null;
  const valor = signo === "-" || signo === "−" ? -n : n;
  const limpio = texto.trim();
  return {
    signo,
    simbolo,
    entero,
    decimales,
    sufijo,
    texto: limpio,
    completo: limpio,
    valor,
    decimalesTexto: decimales ? decimales.length - 1 : 0,
  };
}

/** Reescribe un numero intermedio del conteo con el mismo formato que el texto original (miles es-MX, mismos decimales). */
export function reescribirNumero(abs: number, decimales: number): { entero: string; decimales: string } {
  return partir(numero(abs, decimales, "es-MX"), "es-MX");
}

// ---- Movimiento ------------------------------------------------------------------------------------------------------

/** Curva de Rovaq (cubic-bezier(.22,1,.36,1)) evaluada en `t` en [0,1]. Pura: la usa el conteo y la prueban los tests. */
export function curvaRovaq(t: number): number {
  const x1 = 0.22;
  const y1 = 1;
  const x2 = 0.36;
  const y2 = 1;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xDe = (u: number) => ((ax * u + bx) * u + cx) * u;
  const dxDe = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  // Newton con respaldo de biseccion: encuentra u tal que x(u) = t.
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = xDe(u) - t;
    if (Math.abs(err) < 1e-6) break;
    const d = dxDe(u);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  if (u < 0 || u > 1 || Math.abs(xDe(u) - t) > 1e-4) {
    let lo = 0;
    let hi = 1;
    u = t;
    for (let i = 0; i < 30; i++) {
      if (xDe(u) < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
  }
  return ((ay * u + by) * u + cy) * u;
}

/** Duracion del conteo (Rovaq: 250-360 ms). */
export const CIFRA_CONTEO_MS = 320;

/** Movimiento reducido o navegador automatizado (e2e, capturas): sin conteo, la cifra final aparece de una vez. */
export function sinMovimiento(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof navigator !== "undefined" && (navigator as Navigator & { webdriver?: boolean }).webdriver) return true;
  return typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

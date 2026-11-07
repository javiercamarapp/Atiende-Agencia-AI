// <Cifra> / <CifraTexto>: la UNICA forma de pintar un monto, conteo o porcentaje protagonista (KPI, total, destacado). Sustituye al
// «estilo reloj» (digitos en tablero que voltean, mono espaciado): sans proporcional, signo de moneda y decimales mas chicos y tenues,
// miles es-MX, compacto con el valor completo en el titulo. Ver lib/cifra.ts para el formato puro.
//
// Movimiento (Rovaq): un solo conteo sutil al aparecer y una transicion cuando el valor cambia, 320 ms con cubic-bezier(.22,1,.36,1),
// sin rodar digito por digito; nunca se re-anima en un re-render con el mismo valor. El conteo solo corre si la hoja de estilos lo pide
// (`--cifra-conteo: 1`, que solo existe bajo html[data-diseno="ds3"] en cifra.css): asi la bandera vive en CSS y no en una rama de JS.
// Se omite con prefers-reduced-motion y en navegadores automatizados. El DOM termina SIEMPRE con el texto final exacto, y el ancho
// final se reserva durante el conteo (sin salto de layout).
import { useLayoutEffect, useRef, type ElementType } from "react";
import { cn } from "../lib/utils";
import { CIFRA_CONTEO_MS, curvaRovaq, partesCifra, partirTextoCifra, reescribirNumero, sinMovimiento, type OpcionesCifra, type PartesCifra } from "../lib/cifra";

export type CifraTamano = 12 | 13 | 14 | 20 | 28 | 36;

interface ComunesCifra {
  /** Escala 12/13/14 (tablas, pies) y 20/28/36 (KPI, destacado). Omitido = hereda el tamano del contenedor. */
  readonly tamano?: CifraTamano;
  /** `false` apaga el conteo (p. ej. celdas de tabla que se re-ordenan). */
  readonly animar?: boolean;
  readonly as?: "span" | "strong" | "p" | "div";
  readonly className?: string;
  readonly "data-testid"?: string;
}

export interface CifraProps extends OpcionesCifra, ComunesCifra {
  /** `null`/`undefined`/no finito = «—» (sin dato), jamas 0. */
  readonly valor: number | null | undefined;
  /** Titulo cuando no hay dato (por que no hay cifra). */
  readonly sinDato?: string;
}

export interface CifraTextoProps extends ComunesCifra {
  /** Texto ya formateado por la pagina («$12,500.00», «-8%», «1,204»). Si no es una cifra simple se pinta tal cual. */
  readonly texto: string;
}

/** Valor numerico tal como se ve (el cuerpo de la cifra, ya compactado) y sus decimales: lo que el conteo recorre. */
function cuerpoNumerico(p: PartesCifra): { n: number; dec: number } | null {
  if (p.valor === null) return null;
  const abs = Number(`${p.entero.replace(/,/g, "")}${p.decimales}`);
  if (!Number.isFinite(abs)) return null;
  // Con signo: asi se detecta una transicion que cruza el cero (no se cuenta).
  const n = p.signo === "-" || p.signo === "−" ? -abs : abs;
  return { n, dec: p.decimales ? p.decimales.length - 1 : 0 };
}

function conteoHabilitado(el: HTMLElement): boolean {
  if (sinMovimiento()) return false;
  try {
    return getComputedStyle(el).getPropertyValue("--cifra-conteo").trim() === "1";
  } catch {
    return false;
  }
}

function escribir(el: HTMLElement | null, texto: string) {
  const nodo = el?.firstChild;
  // Se escribe sobre el MISMO nodo de texto que React administra (nodeValue), nunca se reemplaza: React lo sigue reconociendo.
  if (nodo && nodo.nodeType === 3 && nodo.nodeValue !== texto) nodo.nodeValue = texto;
}

function useConteo(raiz: React.RefObject<HTMLElement>, entero: React.RefObject<HTMLElement>, decimales: React.RefObject<HTMLElement>, partes: PartesCifra, animar: boolean) {
  const cuerpo = cuerpoNumerico(partes);
  const objetivo = cuerpo?.n ?? null;
  const dec = cuerpo?.dec ?? 0;
  // Ultimo valor mostrado (incluye el punto intermedio si una transicion se interrumpe). `null` = aun no aparece ninguna cifra.
  const mostrado = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = raiz.current;
    if (objetivo === null || !el) {
      mostrado.current = null;
      return;
    }
    const desde = mostrado.current ?? 0;
    if (!animar || desde === objetivo || !conteoHabilitado(el)) {
      mostrado.current = objetivo;
      return;
    }
    // Cruzar el cero contaria numeros negativos con el signo final pintado: sin conteo en ese caso.
    if (Math.sign(desde) !== Math.sign(objetivo) && desde !== 0) {
      mostrado.current = objetivo;
      return;
    }
    const finalEntero = entero.current?.firstChild?.nodeValue ?? "";
    const finalDec = decimales.current?.firstChild?.nodeValue ?? "";
    // Reserva el MAYOR ancho entre la cifra de partida y la final (el conteo es monotono, los extremos son los mas anchos):
    // el texto intermedio nunca empuja el layout, ni al subir ni al bajar de magnitud.
    const anchoFinal = el.getBoundingClientRect().width;
    const inicial = reescribirNumero(Math.abs(desde), dec);
    escribir(entero.current, inicial.entero);
    escribir(decimales.current, inicial.decimales);
    const ancho = Math.max(anchoFinal, el.getBoundingClientRect().width);
    if (ancho > 0) el.style.minWidth = `${ancho}px`;
    const inicio = performance.now();
    let raf = 0;
    const cuadro = (ahora: number) => {
      const p = Math.min(1, (ahora - inicio) / CIFRA_CONTEO_MS);
      if (p >= 1) {
        escribir(entero.current, finalEntero);
        escribir(decimales.current, finalDec);
        el.style.minWidth = "";
        mostrado.current = objetivo;
        return;
      }
      const v = desde + (objetivo - desde) * curvaRovaq(p);
      mostrado.current = v;
      const t = reescribirNumero(Math.abs(v), dec);
      escribir(entero.current, t.entero);
      escribir(decimales.current, t.decimales);
      raf = requestAnimationFrame(cuadro);
    };
    raf = requestAnimationFrame(cuadro);
    return () => {
      cancelAnimationFrame(raf);
      el.style.minWidth = "";
    };
    // Solo el valor dispara el conteo: un re-render con la misma cifra no re-anima (las refs y `animar` se leen al momento).
  }, [objetivo, dec]);
}

function Piezas({ partes, vacia, tamano, animar = true, as = "span", className, titulo, motivo, abrev, ...resto }: ComunesCifra & { partes: PartesCifra; vacia: boolean; titulo?: string; motivo?: string; abrev?: string }) {
  const raiz = useRef<HTMLElement>(null);
  const entero = useRef<HTMLSpanElement>(null);
  const decimales = useRef<HTMLSpanElement>(null);
  useConteo(raiz, entero, decimales, partes, animar);
  const Tag = as as ElementType;
  return (
    <Tag
      ref={raiz}
      className={cn("cifra", vacia && "cifra-vacia", className)}
      data-tamano={tamano}
      data-abrev={abrev}
      data-testid={resto["data-testid"]}
      title={titulo}
    >
      {partes.signo && <span className="cifra-signo">{partes.signo}</span>}
      {partes.simbolo && <span className="cifra-simbolo">{partes.simbolo}</span>}
      <span ref={entero} className="cifra-entero">
        {partes.entero}
      </span>
      {partes.decimales && (
        <span ref={decimales} className="cifra-decimales">
          {partes.decimales}
        </span>
      )}
      {partes.sufijo && <span className="cifra-sufijo">{partes.sufijo}</span>}
      {/* Sin aria-label en un elemento generico (axe aria-prohibited-attr): el motivo de «—» se lee como texto oculto. */}
      {motivo && <span className="sr-only"> (sin dato: {motivo})</span>}
    </Tag>
  );
}

/** Cifra a partir de un numero: dinero, conteo, porcentaje o compacto («$1.2 M», con el valor completo en el titulo). */
export function Cifra({ valor, variante, moneda, decimales, locale, conSigno, compactoDesde, sinDato, ...comunes }: CifraProps) {
  const partes = partesCifra(valor, { variante, moneda, decimales, locale, conSigno, compactoDesde });
  const vacia = partes.valor === null;
  const titulo = vacia ? sinDato : partes.completo !== partes.texto ? partes.completo : undefined;
  return <Piezas partes={partes} vacia={vacia} titulo={titulo} motivo={vacia ? sinDato : undefined} {...comunes} />;
}

/**
 * Cifra a partir del texto que la pagina ya formateo (StatCard/KpiTile reciben texto). Conserva cada caracter: solo la parte en piezas.
 * Un texto que no es una cifra simple se pinta tal cual (sin conteo).
 */
export function CifraTexto({ texto, ...comunes }: CifraTextoProps) {
  const p = partirTextoCifra(texto);
  const partes: PartesCifra = p ?? { signo: "", simbolo: "", entero: texto, decimales: "", sufijo: "", texto, completo: texto, valor: null };
  const abrev = p ? abreviatura(p) : undefined;
  return <Piezas partes={partes} vacia={texto.trim() === "—"} abrev={abrev} titulo={abrev ? partes.texto : undefined} {...comunes} animar={p ? comunes.animar : false} />;
}

/** Desde cuantos caracteres una cifra protagonista se abrevia en movil (Rovaq `data-abrev`): «$12,345,678.90» -> «$12.3 M». */
export const CIFRA_ABREVIAR_DESDE = 11;

/**
 * Forma compacta para pantallas angostas (nunca se corta un numero con «…», que se leeria como otra cantidad). Solo montos en
 * pesos/dolares o conteos de 10 000 o mas, sin sufijo. cifra.css la muestra con `content: attr(data-abrev) / ""` bajo ds3 en movil;
 * el texto completo sigue en el DOM (lector de pantalla) y en el titulo.
 */
export function abreviatura(p: PartesCifra): string | undefined {
  if (p.valor === null || p.texto.length < CIFRA_ABREVIAR_DESDE || p.sufijo || Math.abs(p.valor) < 10_000) return undefined;
  if (p.simbolo && p.simbolo !== "$" && p.simbolo !== "US$") return undefined;
  const moneda = p.simbolo === "US$" ? "USD" : p.simbolo === "$" ? "MXN" : undefined;
  return partesCifra(p.valor, { variante: "compacto", moneda }).texto;
}

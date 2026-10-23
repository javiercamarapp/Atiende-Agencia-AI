// Grafica de linea de "Tendencias" del Resumen (paridad con el repo suelto): eje Y con marcas, eje X con las etiquetas
// del periodo, linea de 2 px y un punto por cubeta. SVG plano (sin libreria nueva), tokens de color por clase de Tailwind.
// Nunca inventa datos: sin cubetas no dibuja una linea plana, avisa. Cada punto lleva su <title> (tooltip nativo) con la cifra exacta.
import { useId } from "react";

export interface PuntoTendencia {
  readonly etiqueta: string;
  readonly valor: number;
}

const ANCHO = 560;
const ALTO = 220;
const PAD_IZQ = 44;
const PAD_DER = 12;
const PAD_SUP = 12;
const PAD_INF = 26;
const MARCAS_Y = 4;

/** Techo "redondo" para que las marcas del eje Y caigan en cifras limpias (1, 2, 5 x 10^n). */
export function techoRedondo(max: number): number {
  if (!(max > 0)) return 4;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const m = max / base;
  const paso = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return paso * base;
}

export function GraficaTendencia({
  puntos,
  etiquetaSerie,
  formatoValor,
  tono = "primary",
}: {
  readonly puntos: readonly PuntoTendencia[];
  /** Nombre accesible de la serie ("Ventas ($)"). */
  readonly etiquetaSerie: string;
  readonly formatoValor: (v: number) => string;
  readonly tono?: "primary" | "secondary";
}) {
  const idTitulo = useId();
  if (puntos.length === 0) {
    return (
      <p role="status" data-testid="tendencia-sin-datos" className="py-10 text-center text-xs text-faint">
        Sin datos en este periodo
      </p>
    );
  }
  const techo = techoRedondo(Math.max(...puntos.map((p) => p.valor), 0));
  const w = ANCHO - PAD_IZQ - PAD_DER;
  const h = ALTO - PAD_SUP - PAD_INF;
  const paso = puntos.length > 1 ? w / (puntos.length - 1) : 0;
  const xy = puntos.map((p, i) => [puntos.length > 1 ? PAD_IZQ + i * paso : PAD_IZQ + w / 2, PAD_SUP + h - (p.valor / techo) * h] as const);
  const linea = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  // Etiquetas del eje X: como mucho ~7 para que no se amontonen; siempre la primera y la ultima.
  const cada = Math.max(1, Math.ceil(puntos.length / 7));
  const mostrar = (i: number) => i === 0 || i === puntos.length - 1 || (i % cada === 0 && puntos.length - 1 - i >= cada / 2);
  const traza = tono === "secondary" ? "stroke-secondary" : "stroke-primary";
  const relleno = tono === "secondary" ? "fill-secondary" : "fill-primary";
  return (
    <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} className="h-auto w-full" role="img" aria-labelledby={idTitulo} data-testid="grafica-tendencia">
      <title id={idTitulo}>{`${etiquetaSerie}: ${puntos.map((p) => `${p.etiqueta} ${formatoValor(p.valor)}`).join(", ")}`}</title>
      {Array.from({ length: MARCAS_Y + 1 }, (_, k) => {
        const y = PAD_SUP + h - (k / MARCAS_Y) * h;
        return (
          <g key={k}>
            <line x1={PAD_IZQ} x2={ANCHO - PAD_DER} y1={y} y2={y} className="stroke-border" strokeWidth={1} strokeDasharray={k === 0 ? undefined : "3 4"} />
            <text x={PAD_IZQ - 8} y={y + 3} textAnchor="end" className="fill-muted-foreground font-mono text-2xs">
              {formatoValor((techo * k) / MARCAS_Y)}
            </text>
          </g>
        );
      })}
      <path d={linea} fill="none" className={traza} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {xy.map(([x, y], i) => (
        <g key={`${puntos[i]!.etiqueta}-${i}`}>
          <circle cx={x} cy={y} r={3.5} className={`${relleno} stroke-card`} strokeWidth={2}>
            <title>{`${puntos[i]!.etiqueta}: ${formatoValor(puntos[i]!.valor)}`}</title>
          </circle>
          {mostrar(i) && (
            <text x={x} y={ALTO - 8} textAnchor="middle" className="fill-muted-foreground font-mono text-2xs">
              {puntos[i]!.etiqueta}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

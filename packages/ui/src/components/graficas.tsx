// Kit de graficas de la consola, portado de Likida (`admin/charts.tsx` y `admin/ui/graficas.tsx`): SVG/CSS
// plano, sin libreria nueva, monocromo (el dato en `--primary`, lo recesivo en `--muted-foreground`), linea
// de 2 px, gridlines hairline, interactividad con `:hover` puro de CSS.
//
// Regla "nunca inventar una cifra": TODAS reciben sus datos por props (la pagina los trae de su endpoint).
// Sin datos no se dibuja una grafica plana de relleno: se pinta un aviso honesto (`sinDatos`). Con una sola
// categoria la dona ocupa el anillo completo; con total 0 dice que no hay nada que repartir.
import { cn } from "../lib/utils";
import { resolverFormato, type FormatoPreset } from "../lib/formato-preset";

export interface PuntoSerie {
  /** Fecha ISO `AAAA-MM-DD` (la etiqueta del eje es `MM-DD`). */
  readonly dia: string;
  readonly valor: number;
}

const TRAZO = "hsl(var(--primary))";
const LINEA = "hsl(var(--border))";
const TENUE = "hsl(var(--muted-foreground))";

function SinDatos({ texto, className }: { texto: string; className?: string }) {
  return (
    <p role="status" data-testid="grafica-sin-datos" className={cn("py-6 text-center text-xs text-faint", className)}>
      {texto}
    </p>
  );
}

// ---- SparklineConsola y tendencia ---------------------------------------------------

/**
 * `width="100%"` + viewBox, NUNCA un ancho fijo en px: un ancho fijo dentro de un flex angosto (la tarjeta
 * de KPI) empuja el trazo fuera de la tarjeta. Con menos de 2 puntos no hay serie que trazar y no se pinta.
 */
export function SparklineConsola({ valores, alto = 24 }: { valores: readonly number[]; alto?: number }) {
  const ANCHO_VB = 100;
  if (valores.length < 2) return null;
  const max = Math.max(...valores);
  const min = Math.min(...valores);
  const rango = max - min || 1;
  const paso = ANCHO_VB / (valores.length - 1);
  const puntos = valores.map((v, i) => [i * paso, alto - 2 - ((v - min) / rango) * (alto - 4)] as const);
  const d = puntos.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ux, uy] = puntos[puntos.length - 1]!;
  return (
    <svg data-testid="sparkline" width="100%" height={alto} viewBox={`0 0 ${ANCHO_VB} ${alto}`} preserveAspectRatio="none" className="block" aria-hidden="true">
      <path d={d} fill="none" stroke={TRAZO} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.5} vectorEffect="non-scaling-stroke" />
      <circle cx={ux} cy={uy} r={2.5} fill={TRAZO} />
    </svg>
  );
}

/** Variacion porcentual contra los 7 dias previos. `null` = no hay historia suficiente (se dice, no se inventa un 0 %). */
export function Tendencia({ valor }: { valor: number | null }) {
  if (valor === null) return <span className="block truncate text-xs text-muted-foreground">sin historia suficiente</span>;
  const sube = valor >= 0;
  return (
    <span className={cn("block truncate text-xs font-medium", sube ? "text-success" : "text-destructive")} title={`${sube ? "+" : ""}${valor}% vs los 7 días previos`}>
      {sube ? "↑" : "↓"} {Math.abs(valor)}%<span className="font-normal text-muted-foreground"> · 7d</span>
    </span>
  );
}

// ---- Area -----------------------------------------------------------------------

/** Desde cuantos puntos una serie diaria se agrupa por semana (90 dias = un trimestre). */
export const UMBRAL_AGRUPAR_SEMANA = 90;

/**
 * Suma los valores de una serie diaria en cubetas de 7 dias ancladas al FINAL (la ultima cubeta es una
 * semana completa que termina en el ultimo dia). SUMA, no promedia: la suma de la semana es una cifra real
 * que se puede cruzar; un promedio no aparece en ninguna parte de la base. Cada cubeta lleva su primer dia.
 */
export function agruparPorSemana(datos: readonly PuntoSerie[]): PuntoSerie[] {
  const cubetas: PuntoSerie[] = [];
  for (let fin = datos.length; fin > 0; fin -= 7) {
    const ini = Math.max(0, fin - 7);
    const tanda = datos.slice(ini, fin);
    cubetas.unshift({ dia: tanda[0]!.dia, valor: tanda.reduce((s, d) => s + d.valor, 0) });
  }
  return cubetas;
}

export interface AreaChartSimpleProps {
  readonly datos: readonly PuntoSerie[];
  readonly etiquetaValor: (v: number) => string;
  /** Periodo anterior como linea punteada gris, a la MISMA escala. Solo con la serie real; nunca se sintetiza. */
  readonly comparativa?: readonly PuntoSerie[];
  readonly etiquetaComparativa?: string;
  readonly sinDatos?: string;
}

/** Area + linea de UNA metrica en el tiempo, un solo eje a proposito (nunca doble eje). */
export function AreaChartSimple({ datos: datosCrudos, etiquetaValor, comparativa: comparativaCruda, etiquetaComparativa = "periodo anterior", sinDatos = "Sin datos en este periodo" }: AreaChartSimpleProps) {
  if (datosCrudos.length === 0) return <SinDatos texto={sinDatos} />;
  // Por encima del trimestre se agrupa por semana y el rotulo lo DICE: un punto que suma 7 dias no debe leerse como un dia.
  const agrupada = datosCrudos.length > UMBRAL_AGRUPAR_SEMANA;
  const datos = agrupada ? agruparPorSemana(datosCrudos) : datosCrudos;
  // La comparativa se agrupa con el mismo criterio: dos granularidades mentirian la comparacion igual que dos escalas.
  const comparativa = comparativaCruda && agrupada ? agruparPorSemana(comparativaCruda) : comparativaCruda;
  const ANCHO = 640;
  const ALTO = 240;
  const PAD_IZQ = 8;
  const PAD_DER = 8;
  const PAD_SUP = 16;
  const PAD_INF = 28;
  const w = ANCHO - PAD_IZQ - PAD_DER;
  const h = ALTO - PAD_SUP - PAD_INF;
  const comp = comparativa && comparativa.length > 1 ? comparativa : null;
  const max = Math.max(...datos.map((d) => d.valor), ...(comp ?? []).map((d) => d.valor), 1);
  const paso = datos.length > 1 ? w / (datos.length - 1) : 0;
  const xy = datos.map((d, i) => [PAD_IZQ + i * paso, PAD_SUP + h - (d.valor / max) * h] as const);
  const linea = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${linea} L${xy[xy.length - 1]![0].toFixed(1)},${PAD_SUP + h} L${xy[0]![0].toFixed(1)},${PAD_SUP + h} Z`;
  const pasoComp = comp ? w / (comp.length - 1) : 0;
  const lineaComp = comp ? comp.map((d, i) => `${i === 0 ? "M" : "L"}${(PAD_IZQ + i * pasoComp).toFixed(1)},${(PAD_SUP + h - (d.valor / max) * h).toFixed(1)}`).join(" ") : null;
  // Cada 1/5 y la ultima: evita amontonar etiquetas en series largas.
  const mostrarEtiqueta = (i: number) => i === 0 || i === datos.length - 1 || i % Math.max(1, Math.ceil(datos.length / 5)) === 0;

  return (
    <>
      {agrupada && (
        <div data-testid="area-agrupada" className="mb-1 text-2xs text-muted-foreground">
          Agrupado por semana ({datos.length} semanas): cada punto suma sus 7 días.
        </div>
      )}
      {comp && (
        <div className="mb-1 flex items-center gap-3 text-2xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 rounded border-t-2 border-primary" /> actual
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-4 rounded border-t-2 border-dashed border-muted-foreground" /> {etiquetaComparativa}
          </span>
        </div>
      )}
      <svg data-testid="area-chart" viewBox={`0 0 ${ANCHO} ${ALTO}`} className="h-auto w-full" role="img" aria-label="Gráfica de área">
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={PAD_IZQ} x2={ANCHO - PAD_DER} y1={PAD_SUP + h * t} y2={PAD_SUP + h * t} stroke={LINEA} strokeWidth={1} />
        ))}
        {lineaComp && <path d={lineaComp} fill="none" stroke={TENUE} strokeWidth={1.5} strokeDasharray="5 5" opacity={0.6} strokeLinecap="round" strokeLinejoin="round" />}
        <path d={area} fill={TRAZO} opacity={0.08} />
        <path d={linea} fill="none" stroke={TRAZO} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {xy.map(([x, y], i) => (
          <g key={datos[i]!.dia} className="group cursor-default">
            <circle cx={x} cy={y} r={9} fill="transparent" />
            <circle cx={x} cy={y} r={3.5} fill={TRAZO} stroke="hsl(var(--card))" strokeWidth={2} className="opacity-0 transition-opacity group-hover:opacity-100" />
            {mostrarEtiqueta(i) && (
              <text x={x} y={ALTO - 6} textAnchor="middle" fontSize={10} fill={TENUE}>
                {datos[i]!.dia.slice(5)}
              </text>
            )}
            <g className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100">
              <rect x={x - 34} y={y - 30} width={68} height={20} rx={5} fill={TRAZO} />
              <text x={x} y={y - 16} textAnchor="middle" fontSize={11} fill="hsl(var(--primary-foreground))" fontWeight={600}>
                {etiquetaValor(datos[i]!.valor)}
              </text>
            </g>
          </g>
        ))}
      </svg>
    </>
  );
}

// ---- Barras ---------------------------------------------------------------------

export interface BarChartSimpleProps {
  readonly datos: readonly PuntoSerie[];
  readonly etiquetaValor?: (v: number) => string;
  readonly alto?: number;
  readonly sinDatos?: string;
}

/**
 * Una magnitud por dia (no una serie continua): barra en vez de linea. CSS/flexbox, NO SVG estirado: un
 * `preserveAspectRatio="none"` deforma las esquinas redondeadas. Solo la polilinea (rectas) vive en un SVG
 * que se estira; los puntos son divs reales para que sigan siendo circulos.
 */
export function BarChartSimple({ datos, etiquetaValor = (v) => String(v), alto = 96, sinDatos = "Sin datos en este periodo" }: BarChartSimpleProps) {
  if (datos.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...datos.map((d) => d.valor), 1);
  const altoBarras = alto - 24; // deja lugar a la etiqueta del dia abajo
  const n = datos.length;
  // Mismo % que la altura de cada barra: el punto queda exacto en su tope.
  const pcts = datos.map((d) => (d.valor > 0 ? Math.max(4, (d.valor / max) * 100) : 0));
  const xPct = (i: number) => ((i + 0.5) / n) * 100;
  return (
    <div data-testid="bar-chart" style={{ height: alto }}>
      <div className="relative flex items-end gap-2 border-b border-border" style={{ height: altoBarras }}>
        {datos.map((d, i) => (
          <div key={d.dia} className="group relative flex h-full flex-1 cursor-default items-end justify-center">
            {d.valor > 0 && <div data-testid="bar-chart-barra" className="w-full max-w-14 rounded-t-[4px] bg-primary opacity-80" style={{ height: `${pcts[i]}%`, minHeight: 3 }} />}
            <div
              className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100"
              style={{ bottom: `calc(${pcts[i]}% + 8px)` }}
            >
              {etiquetaValor(d.valor)}
            </div>
          </div>
        ))}
        <svg width="100%" height="100%" className="pointer-events-none absolute inset-0" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={pcts.map((p, i) => `${xPct(i)},${100 - p}`).join(" ")} fill="none" stroke={TRAZO} strokeWidth={1.5} strokeOpacity={0.4} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {pcts.map((p, i) => (
          <div key={datos[i]!.dia} className="pointer-events-none absolute size-[7px] rounded-full bg-primary" style={{ left: `${xPct(i)}%`, bottom: `${p}%`, transform: "translate(-50%, 50%)", boxShadow: "0 0 0 2px hsl(var(--card))" }} />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {datos.map((d) => (
          <div key={d.dia} className="flex-1 text-center text-xs text-muted-foreground">
            {d.dia.slice(8)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Dona -----------------------------------------------------------------------

const RADIO_OUT = 90;
const RADIO_IN = 66;
const CENTRO = 96;
const GAP_DEG = 2.4; // separacion angular entre rebanadas

/** Punto de un circulo (0 grados = arriba, sentido horario), redondeado a 3 decimales para que servidor y navegador impriman igual. */
export function puntoEnCirculo(r: number, anguloDeg: number): [number, number] {
  const rad = ((anguloDeg - 90) * Math.PI) / 180;
  return [Math.round((CENTRO + r * Math.cos(rad)) * 1000) / 1000, Math.round((CENTRO + r * Math.sin(rad)) * 1000) / 1000];
}

/** Sector anular entre dos angulos: UNA figura cerrada por rebanada (sin costura de sub-pixel entre rebanadas). */
export function pathRebanada(anguloIni: number, anguloFin: number): string {
  const largeArc = anguloFin - anguloIni > 180 ? 1 : 0;
  const [xOi, yOi] = puntoEnCirculo(RADIO_OUT, anguloIni);
  const [xOf, yOf] = puntoEnCirculo(RADIO_OUT, anguloFin);
  const [xIf, yIf] = puntoEnCirculo(RADIO_IN, anguloFin);
  const [xIi, yIi] = puntoEnCirculo(RADIO_IN, anguloIni);
  return [`M ${xOi} ${yOi}`, `A ${RADIO_OUT} ${RADIO_OUT} 0 ${largeArc} 1 ${xOf} ${yOf}`, `L ${xIf} ${yIf}`, `A ${RADIO_IN} ${RADIO_IN} 0 ${largeArc} 0 ${xIi} ${yIi}`, "Z"].join(" ");
}

export interface DonaSegmento {
  readonly etiqueta: string;
  readonly valor: number;
}

/**
 * Dona de una categoria: la identidad es la OPACIDAD (monocromo), con leyenda directa. El SVG vive en un
 * `div` `aspect-square` y no con ancho fijo propio, para que ceda en una tarjeta angosta sin volverse ovalo.
 */
export function Dona({ segmentos, sinDatos = "Sin datos en este periodo" }: { segmentos: readonly DonaSegmento[]; sinDatos?: string }) {
  const total = segmentos.reduce((s, x) => s + x.valor, 0);
  if (segmentos.length === 0 || total <= 0) return <SinDatos texto={sinDatos} />;
  const pasos = segmentos.length <= 1 ? [1] : segmentos.map((_, i) => 0.35 + (0.65 * i) / (segmentos.length - 1));
  const acumulados = segmentos.reduce<number[]>((acc, s) => {
    acc.push((acc.length ? acc[acc.length - 1]! : 0) + s.valor / total);
    return acc;
  }, []);
  const gap = segmentos.length > 1 ? GAP_DEG : 0;
  return (
    <div data-testid="dona" className="flex min-w-0 items-center gap-6">
      <div className="aspect-square min-w-0 shrink" style={{ width: 160 }}>
        <svg viewBox="0 0 192 192" width="100%" height="100%" className="block" role="img" aria-label="Gráfica de dona">
          <circle cx={CENTRO} cy={CENTRO} r={(RADIO_OUT + RADIO_IN) / 2} fill="none" stroke={LINEA} strokeWidth={RADIO_OUT - RADIO_IN} />
          {segmentos.map((s, i) => {
            const ini = (i === 0 ? 0 : acumulados[i - 1]!) * 360 + gap / 2;
            const fin = Math.max(ini, acumulados[i]! * 360 - gap / 2);
            // Un segmento de 0 no dibuja rebanada (su leyenda dice 0 %).
            return s.valor > 0 ? <path key={s.etiqueta} d={pathRebanada(ini, fin)} fill={TRAZO} opacity={pasos[i]} /> : null;
          })}
        </svg>
      </div>
      <div className="min-w-0 space-y-2">
        {segmentos.map((s, i) => (
          <div key={s.etiqueta} className="flex items-center gap-2 text-ui">
            <span className="inline-block size-2.5 shrink-0 rounded-full bg-primary" style={{ opacity: pasos[i] }} />
            <span className="truncate font-medium">{s.etiqueta}</span>
            <span className="shrink-0 text-muted-foreground">{Math.round((s.valor / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Barras horizontales ----------------------------------------------------------

export interface HBarsProps {
  readonly datos: readonly { readonly etiqueta: string; readonly valor: number }[];
  readonly formato?: FormatoPreset;
  readonly sinDatos?: string;
}

/** Barras horizontales: comparar categorias. La barra nace con su valor real (nunca una pista vacia que se lea como 0 %). */
export function HBars({ datos, formato = "numero", sinDatos = "Sin datos en este periodo" }: HBarsProps) {
  if (datos.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...datos.map((d) => d.valor), 1);
  const fmt = resolverFormato(formato);
  return (
    <div data-testid="hbars" className="space-y-2.5">
      {datos.map((d) => (
        <div key={d.etiqueta} className="flex items-center gap-3">
          <div className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground" title={d.etiqueta}>
            {d.etiqueta}
          </div>
          <div className="h-5 flex-1 overflow-hidden rounded-md bg-sunken">
            <div data-testid="hbars-barra" className="h-full rounded-md bg-chart-5 motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${Math.max(0, (d.valor / max) * 100)}%` }} />
          </div>
          <div className="w-16 shrink-0 text-right text-xs font-medium tabular-nums">{fmt(d.valor)}</div>
        </div>
      ))}
    </div>
  );
}

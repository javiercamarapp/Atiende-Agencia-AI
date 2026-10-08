// CFO-07 · gráficas nuevas del CFO de restaurantes. Mismo estilo que `graficas.tsx` (kit Likida): plano, monocromo (el dato en
// `--primary`, lo recesivo en `--muted-foreground`), hover por CSS, todo por props y aviso honesto cuando no hay datos.
//
// Reglas:
//  - Nunca se inventa una cifra: `null` = «sin dato» (se dice «—»), jamás un 0. Una celda/barra sin dato NO se dibuja como 0.
//  - Ningún estado depende solo del color (semáforo con texto, negativos con signo y etiqueta, atípicos con marca de texto).
//  - Cada gráfica lleva `aria-label` con la cifra y, si se pasa `datosTabla`, el `<details>` «Ver datos» (`TablaDatosGrafica`).
//  - Los números llegan ya formateados por la página (`formato`); estas piezas no calculan ni redondean dinero.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

const TENUE = "hsl(var(--muted-foreground))";
const TRAZO = "hsl(var(--primary))";

function SinDatos({ texto, className }: { texto: string; className?: string }) {
  return (
    <p role="status" data-testid="grafica-sin-datos" className={cn("py-6 text-center text-xs text-faint", className)}>
      {texto}
    </p>
  );
}

const SIN_DATO = "—";
const fmtDefecto = (v: number): string => String(v);

// ---- Tabla «Ver datos» ---------------------------------------------------------------------------------------------------------------

export interface TablaDatosGraficaProps {
  readonly titulo: string;
  readonly encabezados: readonly string[];
  /** Celdas ya formateadas; `null` se pinta «—». */
  readonly filas: ReadonlyArray<readonly (string | number | null)[]>;
  readonly etiqueta?: string;
  readonly className?: string;
}

/** `<details>` accesible con los datos de una gráfica en forma de tabla (alternativa textual para lectores de pantalla y para copiar). */
export function TablaDatosGrafica({ titulo, encabezados, filas, etiqueta = "Ver datos", className }: TablaDatosGraficaProps) {
  if (filas.length === 0) return null;
  return (
    <details data-testid="tabla-datos-grafica" className={cn("mt-2 text-xs", className)}>
      <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-md px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{etiqueta}</summary>
      <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border">
        <table className="w-full min-w-max border-collapse text-left tabular-nums">
          <caption className="sr-only">{titulo}</caption>
          <thead>
            <tr>
              {encabezados.map((e) => (
                <th key={e} scope="col" className="sticky top-0 border-b border-border bg-canvas px-2 py-1 font-medium text-muted-foreground">
                  {e}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filas.map((fila, i) => (
              <tr key={`${String(fila[0])}-${i}`} className="border-b border-line2 last:border-0">
                {fila.map((celda, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="px-2 py-1 font-normal text-foreground">
                      {celda ?? SIN_DATO}
                    </th>
                  ) : (
                    <td key={j} className="px-2 py-1">
                      {celda ?? SIN_DATO}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---- Semáforo -------------------------------------------------------------------------------------------------------------------------

export type EstadoSemaforo = "verde" | "ambar" | "rojo" | "sin_dato";

const SEMAFORO: Readonly<Record<EstadoSemaforo, { readonly texto: string; readonly punto: string; readonly clase: string }>> = {
  verde: { texto: "En orden", punto: "bg-success", clase: "text-success" },
  ambar: { texto: "Atención", punto: "bg-warning", clase: "text-warning" },
  rojo: { texto: "Crítico", punto: "bg-destructive", clase: "text-destructive" },
  sin_dato: { texto: "Sin dato", punto: "bg-faint", clase: "text-muted-foreground" },
};

export const TEXTO_SEMAFORO: Readonly<Record<EstadoSemaforo, string>> = { verde: SEMAFORO.verde.texto, ambar: SEMAFORO.ambar.texto, rojo: SEMAFORO.rojo.texto, sin_dato: SEMAFORO.sin_dato.texto };

/** Punto + texto: el estado nunca se comunica solo con color. `texto` reemplaza la palabra por defecto («En orden», «Atención», «Crítico»). */
export function Semaforo({ estado, texto, className }: { readonly estado: EstadoSemaforo; readonly texto?: string; readonly className?: string }) {
  const s = SEMAFORO[estado];
  return (
    <span data-testid="semaforo" data-estado={estado} className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.clase, className)}>
      <span aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-full", s.punto)} />
      {texto ?? s.texto}
    </span>
  );
}

// ---- Heatmap 7 × 24 -------------------------------------------------------------------------------------------------------------------

export interface CeldaHeatmapUi {
  /** 0..filas-1 (para 7 × 24: 0 = lunes). */
  readonly fila: number;
  /** 0..columnas-1 (hora 0..23). */
  readonly columna: number;
  /** `null` = sin dato (celda vacía, distinta de una celda con 0). */
  readonly valor: number | null;
}

export interface HeatmapProps {
  readonly celdas: readonly CeldaHeatmapUi[];
  readonly etiquetasFilas?: readonly string[];
  readonly filas?: number;
  readonly columnas?: number;
  readonly formato?: (v: number) => string;
  /** Nombre de la métrica (para tooltips y aria-label). */
  readonly metrica?: string;
  readonly ariaLabel?: string;
  readonly sinDatos?: string;
}

const DIAS_CORTOS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const;

/** Escala secuencial de un solo tono (opacidad del color primario). Celda sin dato = contorno punteado sin relleno; celda con 0 = tono mínimo. */
export function Heatmap({ celdas, etiquetasFilas = DIAS_CORTOS, filas = 7, columnas = 24, formato = fmtDefecto, metrica = "valor", ariaLabel, sinDatos = "Sin datos en este periodo" }: HeatmapProps) {
  const conDato = celdas.filter((c): c is CeldaHeatmapUi & { valor: number } => c.valor !== null && Number.isFinite(c.valor));
  if (conDato.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...conDato.map((c) => c.valor), 0);
  const porClave = new Map(conDato.map((c) => [`${c.fila}:${c.columna}`, c.valor] as const));
  const IZQ = 34;
  const TOP = 16;
  const LADO = 22;
  const GAP = 2;
  const ancho = IZQ + columnas * (LADO + GAP);
  const alto = TOP + filas * (LADO + GAP);
  const pico = conDato.reduce((m, c) => (c.valor > m.valor ? c : m), conDato[0]!);
  const etiqueta = ariaLabel ?? `Mapa de calor de ${metrica} por día de la semana y hora. Máximo: ${formato(pico.valor)} el ${etiquetasFilas[pico.fila] ?? "día"} a las ${pico.columna} h.`;
  return (
    <div data-testid="heatmap" className="overflow-x-auto">
      <svg viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label={etiqueta} className="block h-auto min-w-[34rem] w-full">
        {Array.from({ length: columnas }, (_, c) =>
          c % 3 === 0 ? (
            <text key={`h${c}`} x={IZQ + c * (LADO + GAP) + LADO / 2} y={10} textAnchor="middle" fontSize={9} fill={TENUE}>
              {c}
            </text>
          ) : null,
        )}
        {Array.from({ length: filas }, (_, f) => (
          <g key={`f${f}`}>
            <text x={IZQ - 6} y={TOP + f * (LADO + GAP) + LADO / 2 + 3} textAnchor="end" fontSize={10} fill={TENUE}>
              {etiquetasFilas[f] ?? String(f + 1)}
            </text>
            {Array.from({ length: columnas }, (_, c) => {
              const x = IZQ + c * (LADO + GAP);
              const y = TOP + f * (LADO + GAP);
              const v = porClave.get(`${f}:${c}`);
              if (v === undefined) {
                return (
                  <rect key={c} data-testid="heatmap-celda-vacia" x={x} y={y} width={LADO} height={LADO} rx={4} fill="none" stroke={TENUE} strokeOpacity={0.35} strokeDasharray="2 2">
                    <title>{`${etiquetasFilas[f] ?? f + 1}, ${c} h: sin datos`}</title>
                  </rect>
                );
              }
              const intensidad = max > 0 ? 0.12 + 0.88 * (v / max) : 0.12;
              return (
                <rect key={c} data-testid="heatmap-celda" data-valor={v} x={x} y={y} width={LADO} height={LADO} rx={4} fill={TRAZO} fillOpacity={intensidad}>
                  <title>{`${etiquetasFilas[f] ?? f + 1}, ${c} h: ${formato(v)}`}</title>
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
      <p className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
        <span aria-hidden="true" className="inline-block h-2 w-16 rounded bg-gradient-to-r from-primary/10 to-primary" />
        menos → más {metrica} · celda punteada = sin datos
      </p>
    </div>
  );
}

// ---- Cascada (waterfall horizontal) ---------------------------------------------------------------------------------------------------

export interface PasoCascada {
  readonly etiqueta: string;
  /** Monto con signo POSITIVO en magnitud; `tipo` dice si suma, resta o es un total. `null` = sin dato. */
  readonly valor: number | null;
  /** `total` = barra que parte de 0 (bruta, neta); `resta` = baja desde el total corriente. */
  readonly tipo: "total" | "resta";
}

export interface CascadaProps {
  readonly pasos: readonly PasoCascada[];
  readonly formato?: (v: number) => string;
  readonly ariaLabel?: string;
  readonly sinDatos?: string;
}

/**
 * Bruta → descuentos → compensaciones → neta → IVA → sin IVA. Las barras de resta flotan desde el total corriente en tono recesivo y
 * con su signo («−») y etiqueta; los totales parten de 0. Un paso sin dato dice «—» y no dibuja barra.
 */
export function Cascada({ pasos, formato = fmtDefecto, ariaLabel, sinDatos = "Sin datos en este periodo" }: CascadaProps) {
  const medibles = pasos.filter((p) => p.valor !== null && Number.isFinite(p.valor));
  if (medibles.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...medibles.map((p) => Math.abs(p.valor as number)), 1);
  let corriente = 0;
  const filas = pasos.map((p) => {
    if (p.valor === null || !Number.isFinite(p.valor)) return { ...p, ini: 0, fin: 0, medible: false as const };
    const v = Math.abs(p.valor);
    if (p.tipo === "total") {
      corriente = v;
      return { ...p, ini: 0, fin: v, medible: true as const };
    }
    const ini = Math.max(0, corriente - v);
    const fila = { ...p, ini, fin: corriente, medible: true as const };
    corriente = ini;
    return fila;
  });
  const resumen = pasos.map((p) => `${p.etiqueta}: ${p.valor === null ? "sin dato" : `${p.tipo === "resta" ? "menos " : ""}${formato(Math.abs(p.valor))}`}`).join("; ");
  return (
    <div data-testid="cascada" role="group" aria-label={ariaLabel ?? `Cascada de ventas. ${resumen}`} className="space-y-2">
      {filas.map((f) => (
        <div key={f.etiqueta} data-testid="cascada-paso" data-tipo={f.tipo} className="flex items-center gap-3">
          <div className="w-32 shrink-0 text-right text-xs text-muted-foreground sm:w-44" title={f.etiqueta}>
            {f.etiqueta}
          </div>
          <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-sunken" aria-hidden="true">
            {f.medible && (
              <div
                data-testid="cascada-barra"
                className={cn("absolute inset-y-0 rounded-md", f.tipo === "total" ? "bg-primary" : "bg-muted-foreground/40")}
                style={{ left: `${(f.ini / max) * 100}%`, width: `${Math.max(((f.fin - f.ini) / max) * 100, 0.8)}%` }}
              />
            )}
          </div>
          <div className="w-24 shrink-0 text-right text-xs font-medium tabular-nums">{!f.medible ? SIN_DATO : `${f.tipo === "resta" ? "−" : ""}${formato(Math.abs(f.valor as number))}`}</div>
        </div>
      ))}
    </div>
  );
}

// ---- Ranking de barras ----------------------------------------------------------------------------------------------------------------

export interface FilaRanking {
  readonly id: string;
  readonly etiqueta: string;
  readonly valor: number | null;
  /** Participación en el total, en %. `null` = no se calcula. */
  readonly participacionPct?: number | null;
  readonly outlier?: boolean;
  /** Posición explícita; si falta, se numera por orden de llegada. */
  readonly posicion?: number;
}

export interface RankingBarrasProps {
  readonly filas: readonly FilaRanking[];
  readonly formato?: (v: number) => string;
  readonly etiquetaOutlier?: string;
  readonly ariaLabel?: string;
  readonly sinDatos?: string;
}

/** HBars con posición, participación y marca de atípico (texto, no solo color). */
export function RankingBarras({ filas, formato = fmtDefecto, etiquetaOutlier = "Atípica", ariaLabel, sinDatos = "Sin datos en este periodo" }: RankingBarrasProps) {
  if (filas.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...filas.map((f) => (f.valor === null ? 0 : Math.abs(f.valor))), 1);
  const resumen = filas.map((f, i) => `${f.posicion ?? i + 1}. ${f.etiqueta} ${f.valor === null ? "sin dato" : formato(f.valor)}`).join("; ");
  return (
    <ol data-testid="ranking-barras" aria-label={ariaLabel ?? `Ranking. ${resumen}`} className="space-y-2.5">
      {filas.map((f, i) => (
        <li key={f.id} data-testid="ranking-fila" className="flex items-center gap-3">
          <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">{f.posicion ?? i + 1}</span>
          <span className="w-24 shrink-0 truncate text-xs sm:w-32" title={f.etiqueta}>
            {f.etiqueta}
          </span>
          <span className="h-5 flex-1 overflow-hidden rounded-md bg-sunken" aria-hidden="true">
            {f.valor !== null && <span data-testid="ranking-barra" className="block h-full rounded-md bg-primary motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${Math.max(0, (Math.abs(f.valor) / max) * 100)}%` }} />}
          </span>
          <span className="w-20 shrink-0 text-right text-xs font-medium tabular-nums">{f.valor === null ? SIN_DATO : formato(f.valor)}</span>
          <span className="hidden w-12 shrink-0 text-right text-2xs tabular-nums text-muted-foreground sm:block">{f.participacionPct == null ? "" : `${f.participacionPct} %`}</span>
          {f.outlier ? (
            <span data-testid="ranking-outlier" className="shrink-0 rounded-full border border-warning/30 bg-warning-tint px-1.5 py-0.5 text-2xs font-medium text-warning">
              {etiquetaOutlier}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// ---- Barras agrupadas -----------------------------------------------------------------------------------------------------------------

export const MAX_GRUPOS_BARRAS = 8;

export interface SerieBarras {
  readonly id: string;
  readonly etiqueta: string;
}

export interface GrupoBarras {
  readonly etiqueta: string;
  /** serie.id → valor (`null`/ausente = sin dato). */
  readonly valores: Readonly<Record<string, number | null>>;
}

export interface BarrasAgrupadasProps {
  readonly series: readonly SerieBarras[];
  readonly grupos: readonly GrupoBarras[];
  readonly formato?: (v: number) => string;
  readonly ariaLabel?: string;
  readonly sinDatos?: string;
}

/** Sucursal × métrica. Máximo 8 grupos (los demás se avisan, no se amontonan). Cada serie conserva su escala PROPIA solo si se pasa una sola serie; con varias comparten escala. */
export function BarrasAgrupadas({ series, grupos, formato = fmtDefecto, ariaLabel, sinDatos = "Sin datos en este periodo" }: BarrasAgrupadasProps) {
  const visibles = grupos.slice(0, MAX_GRUPOS_BARRAS);
  const todos = visibles.flatMap((g) => series.map((s) => g.valores[s.id] ?? null)).filter((v): v is number => v !== null && Number.isFinite(v));
  if (visibles.length === 0 || todos.length === 0) return <SinDatos texto={sinDatos} />;
  const max = Math.max(...todos.map(Math.abs), 1);
  const OPACIDAD = [1, 0.55, 0.3, 0.18];
  const resumen = visibles.map((g) => `${g.etiqueta}: ${series.map((s) => `${s.etiqueta} ${g.valores[s.id] == null ? "sin dato" : formato(g.valores[s.id] as number)}`).join(", ")}`).join("; ");
  return (
    <div data-testid="barras-agrupadas" role="group" aria-label={ariaLabel ?? `Barras agrupadas. ${resumen}`}>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
          {series.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block size-2.5 rounded-sm bg-primary" style={{ opacity: OPACIDAD[i] ?? 0.18 }} />
              {s.etiqueta}
            </span>
          ))}
        </div>
      )}
      <div className="space-y-3">
        {visibles.map((g) => (
          <div key={g.etiqueta} data-testid="barras-grupo" className="flex items-start gap-3">
            <div className="w-24 shrink-0 truncate pt-0.5 text-right text-xs text-muted-foreground sm:w-32" title={g.etiqueta}>
              {g.etiqueta}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              {series.map((s, i) => {
                const v = g.valores[s.id] ?? null;
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="h-4 flex-1 overflow-hidden rounded-md bg-sunken" aria-hidden="true">
                      {v !== null && <div data-testid="barras-barra" className="h-full rounded-md bg-primary" style={{ width: `${Math.max(0, (Math.abs(v) / max) * 100)}%`, opacity: OPACIDAD[i] ?? 0.18 }} />}
                    </div>
                    <span className="w-24 shrink-0 text-right text-2xs font-medium tabular-nums">{v === null ? SIN_DATO : formato(v)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {grupos.length > MAX_GRUPOS_BARRAS && (
        <p data-testid="barras-recortadas" className="mt-2 text-2xs text-muted-foreground">
          Se muestran {MAX_GRUPOS_BARRAS} de {grupos.length} grupos; el resto está en la tabla de datos.
        </p>
      )}
    </div>
  );
}

/** Contenedor de una gráfica con su tabla «Ver datos»: el patrón que usan todas las pantallas del CFO. */
export function GraficaConDatos({ children, tabla }: { readonly children: ReactNode; readonly tabla?: TablaDatosGraficaProps }) {
  return (
    <div data-testid="grafica-con-datos">
      {children}
      {tabla ? <TablaDatosGrafica {...tabla} /> : null}
    </div>
  );
}

// Graficas inline del Copiloto en SVG propio (sin libreria de graficas). Las elige el CATALOGO (bloque.chart) y los
// datos vienen del bloque que armo el servidor: aqui no hay datos propios. Si el bloque no alcanza para dibujar lo que
// pide (columna inexistente, valores no numericos, una sola observacion en una linea...), `planGrafica` devuelve null y
// el mensaje muestra la tabla en lugar de inventar una grafica. Apariencia de atiende-restaurantes: trazo 2, punto r3,
// activo r5, ejes mono de 10 px en muted-foreground, tooltip popover y entrada de 450 ms (apagada con movimiento reducido).
import { useState } from "react";
import type { PointerEvent as EventoPuntero, ReactNode } from "react";
import { Card, CardContent } from "../ui/card";
import { formatoCelda } from "./formato";
import type { CopilotoBloque, CopilotoCelda, CopilotoColumna, CopilotoColumnaTipo } from "./tipos";

const ACENTO = "hsl(var(--copiloto-acento, 224 76% 48%))";
const TEXTO_TENUE = "hsl(var(--muted-foreground))";
const BORDE = "hsl(var(--border))";
const FUENTE_EJE = { fontFamily: "IBM Plex Mono, ui-monospace, monospace", fontSize: 10, fill: TEXTO_TENUE } as const;

export const MAX_BARRAS = 12;
export const MAX_SEGMENTOS_DONA = 6;
export const UMBRAL_SEMANAL = 90;
export const MAX_KPI = 4;

export interface Punto {
  readonly etiqueta: string;
  readonly valor: number;
}

export interface Segmento extends Punto {
  readonly porcentaje: number;
}

export interface ItemKpi {
  readonly etiqueta: string;
  readonly texto: string;
}

export type PlanGrafica =
  | { readonly tipo: "bar"; readonly puntos: readonly Punto[]; readonly horizontal: boolean; readonly omitidos: number; readonly kind: CopilotoColumnaTipo }
  | { readonly tipo: "line"; readonly puntos: readonly Punto[]; readonly agrupadoPorSemana: boolean; readonly kind: CopilotoColumnaTipo }
  | { readonly tipo: "donut"; readonly segmentos: readonly Segmento[]; readonly total: number; readonly agrupados: boolean; readonly kind: CopilotoColumnaTipo }
  | { readonly tipo: "kpi"; readonly items: readonly ItemKpi[] };

function finito(v: CopilotoCelda | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function columna(b: CopilotoBloque, key: string): CopilotoColumna | undefined {
  return b.columns.find((c) => c.key === key);
}

const NUMERICAS: ReadonlySet<CopilotoColumnaTipo> = new Set(["integer", "mxn", "percent", "decimal"]);

/** Puntos (etiqueta, valor) de las filas con valor numerico finito. Una fila sin valor no se dibuja (no se inventa un 0). */
function puntosDe(b: CopilotoBloque, xKey: string, yKey: string): { puntos: Punto[]; crudos: Array<{ x: string; y: number }>; kind: CopilotoColumnaTipo } | null {
  const cx = columna(b, xKey);
  const cy = columna(b, yKey);
  if (!cx || !cy || !NUMERICAS.has(cy.kind)) return null;
  const crudos: Array<{ x: string; y: number }> = [];
  const puntos: Punto[] = [];
  for (const r of b.rows) {
    const y = r[cy.key];
    if (!finito(y)) continue;
    const x = r[cx.key] ?? null;
    crudos.push({ x: typeof x === "string" ? x : String(x ?? ""), y });
    puntos.push({ etiqueta: formatoCelda(cx.kind, x), valor: y });
  }
  return { puntos, crudos, kind: cy.kind };
}

const FECHA = /^(\d{4})-(\d{2})-(\d{2})/;

/** Lunes (yyyy-mm-dd, UTC) de la semana de una fecha yyyy-mm-dd. */
export function lunesDe(fecha: string): string | null {
  const m = FECHA.exec(fecha);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const dif = (d.getUTCDay() + 6) % 7;
  return new Date(t - dif * 86_400_000).toISOString().slice(0, 10);
}

/** Con mas de 90 puntos y fechas ISO, agrupa por semana: suma las magnitudes aditivas (MXN, enteros) y promedia el resto. */
export function agruparPorSemana(crudos: ReadonlyArray<{ x: string; y: number }>, kind: CopilotoColumnaTipo): Punto[] | null {
  const por = new Map<string, number[]>();
  for (const c of crudos) {
    const lunes = lunesDe(c.x);
    if (!lunes) return null;
    por.set(lunes, [...(por.get(lunes) ?? []), c.y]);
  }
  const aditivo = kind === "mxn" || kind === "integer";
  return [...por.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([lunes, vs]) => {
      const suma = vs.reduce((a, b) => a + b, 0);
      return { etiqueta: `Sem. ${lunes}`, valor: aditivo ? suma : suma / vs.length };
    });
}

/** Decide que dibujar. null = no hay con que: se muestra la tabla. */
export function planGrafica(b: CopilotoBloque): PlanGrafica | null {
  const chart = b.chart;
  if (!chart || b.rows.length === 0) return null;

  if (chart.kind === "kpi") {
    if (b.rows.length !== 1) return null;
    const fila = b.rows[0]!;
    const items: ItemKpi[] = [];
    for (const c of b.columns) {
      if (!NUMERICAS.has(c.kind)) continue;
      const v = fila[c.key];
      if (!finito(v)) continue;
      items.push({ etiqueta: c.label, texto: formatoCelda(c.kind, v) });
    }
    return items.length > 0 ? { tipo: "kpi", items: items.slice(0, MAX_KPI) } : null;
  }

  const datos = puntosDe(b, chart.x, chart.y);
  if (!datos) return null;
  const { puntos, crudos, kind } = datos;

  if (chart.kind === "bar") {
    if (puntos.length === 0) return null;
    const largo = Math.max(...puntos.map((p) => p.etiqueta.length));
    return { tipo: "bar", puntos: puntos.slice(0, MAX_BARRAS), horizontal: largo > 10, omitidos: Math.max(0, puntos.length - MAX_BARRAS), kind };
  }

  if (chart.kind === "line") {
    let serie: Punto[] = puntos;
    let agrupado = false;
    if (puntos.length > UMBRAL_SEMANAL) {
      const g = agruparPorSemana(crudos, kind);
      if (g) {
        serie = g;
        agrupado = true;
      }
    }
    return serie.length >= 2 ? { tipo: "line", puntos: serie, agrupadoPorSemana: agrupado, kind } : null;
  }

  // donut: solo valores positivos (una proporcion negativa o cero no se dibuja); mas de 6 se agrupan en "Otros".
  const positivos = puntos.filter((p) => p.valor > 0);
  if (positivos.length === 0) return null;
  const ordenados = [...positivos].sort((a, c) => c.valor - a.valor);
  let base: Punto[] = ordenados;
  const agrupados = ordenados.length > MAX_SEGMENTOS_DONA;
  if (agrupados) {
    const resto = ordenados.slice(MAX_SEGMENTOS_DONA - 1);
    base = [...ordenados.slice(0, MAX_SEGMENTOS_DONA - 1), { etiqueta: "Otros", valor: resto.reduce((a, p) => a + p.valor, 0) }];
  }
  const total = base.reduce((a, p) => a + p.valor, 0);
  return { tipo: "donut", segmentos: base.map((p) => ({ ...p, porcentaje: (p.valor / total) * 100 })), total, agrupados, kind };
}

const compacto = new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 });

/** Valor corto para ejes. */
export function valorCompacto(kind: CopilotoColumnaTipo, v: number): string {
  const t = compacto.format(v);
  if (kind === "mxn") return `$${t}`;
  if (kind === "percent") return `${t} %`;
  return t;
}

function recortar(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Resumen para lectores de pantalla: titulo, tipo y valores (todos si son pocos; si no, extremos). */
export function resumenAria(titulo: string, plan: PlanGrafica): string {
  switch (plan.tipo) {
    case "kpi":
      return `${titulo}: ${plan.items.map((i) => `${i.etiqueta} ${i.texto}`).join("; ")}.`;
    case "donut":
      return `${titulo}, composición: ${plan.segmentos.map((s) => `${s.etiqueta} ${formatoCelda("percent", Math.round(s.porcentaje * 10) / 10)}`).join("; ")}.`;
    case "bar":
    case "line": {
      const f = (p: Punto) => `${p.etiqueta} ${formatoCelda(plan.kind, p.valor)}`;
      const nombre = plan.tipo === "bar" ? "barras" : plan.agrupadoPorSemana ? "línea por semana" : "línea";
      const n = plan.puntos.length;
      if (n <= 8) return `${titulo}, ${nombre}: ${plan.puntos.map(f).join("; ")}.`;
      const max = plan.puntos.reduce((a, p) => (p.valor > a.valor ? p : a));
      const min = plan.puntos.reduce((a, p) => (p.valor < a.valor ? p : a));
      return `${titulo}, ${nombre}, ${n} valores: de ${f(plan.puntos[0]!)} a ${f(plan.puntos[n - 1]!)}; máximo ${f(max)}; mínimo ${f(min)}.`;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Primitivos SVG

function Tooltip({ x, y, etiqueta, valor, ancho }: { x: number; y: number; etiqueta: string; valor: string; ancho: number }) {
  const w = Math.max(70, Math.min(220, Math.max(etiqueta.length, valor.length) * 6.4 + 20));
  const h = 38;
  const izq = Math.min(Math.max(x - w / 2, 2), ancho - w - 2);
  const arriba = y - h - 10 >= 2 ? y - h - 10 : y + 10;
  return (
    <g pointerEvents="none" data-testid="copiloto-tooltip">
      <rect x={izq} y={arriba} width={w} height={h} rx={10} fill="hsl(var(--popover))" stroke={BORDE} style={{ filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.08))" }} />
      <text x={izq + 10} y={arriba + 15} style={{ ...FUENTE_EJE, fontSize: 11 }}>
        {recortar(etiqueta, 28)}
      </text>
      <text x={izq + 10} y={arriba + 30} style={{ fontSize: 12, fontWeight: 600, fill: "hsl(var(--popover-foreground))" }}>
        {valor}
      </text>
    </g>
  );
}

/** Marcas "agradables" entre min y max (n+1 valores). */
export function marcasEje(min: number, max: number, n = 3): number[] {
  const paso = (max - min) / n;
  return Array.from({ length: n + 1 }, (_, i) => min + paso * i);
}

function dominio(valores: readonly number[], incluirCero: boolean): [number, number] {
  let min = Math.min(...valores);
  let max = Math.max(...valores);
  if (incluirCero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const d = Math.abs(min) || 1;
    return [min - d * 0.5, max + d * 0.5];
  }
  if (!incluirCero) {
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }
  return [min, max];
}

const ANCHO = 640;
const ALTO = 180;
const M = { izq: 52, der: 12, arr: 12, abajo: 24 } as const;

export function Barras({ plan, etiqueta }: { plan: Extract<PlanGrafica, { tipo: "bar" }>; etiqueta: string }) {
  const [activo, setActivo] = useState<number | null>(null);
  const { puntos, kind } = plan;
  const [min, max] = dominio(puntos.map((p) => p.valor), true);
  const rango = max - min || 1;

  if (plan.horizontal) {
    const fila = 24;
    const alto = puntos.length * fila + 8;
    const x0 = 150;
    const x1 = ANCHO - 70;
    const px = (v: number) => x0 + ((v - min) / rango) * (x1 - x0);
    const cero = px(0);
    return (
      <svg viewBox={`0 0 ${ANCHO} ${alto}`} role="img" aria-label={etiqueta} className="w-full h-auto copiloto-grafica-entra">
        {puntos.map((p, i) => {
          const y = 4 + i * fila;
          const a = Math.min(cero, px(p.valor));
          const w = Math.max(1, Math.abs(px(p.valor) - cero));
          return (
            <g key={i} onPointerEnter={() => setActivo(i)} onPointerLeave={() => setActivo(null)} opacity={activo === null || activo === i ? 1 : 0.55}>
              <text x={x0 - 8} y={y + 14} textAnchor="end" style={FUENTE_EJE}>
                {recortar(p.etiqueta, 24)}
              </text>
              <rect x={a} y={y + 3} width={w} height={fila - 8} rx={3} fill={ACENTO} />
              <text x={a + w + 6} y={y + 14} style={FUENTE_EJE}>
                {valorCompacto(kind, p.valor)}
              </text>
              <title>{`${p.etiqueta}: ${formatoCelda(kind, p.valor)}`}</title>
            </g>
          );
        })}
      </svg>
    );
  }

  const x0 = M.izq;
  const x1 = ANCHO - M.der;
  const y0 = ALTO - M.abajo;
  const y1 = M.arr;
  const py = (v: number) => y0 - ((v - min) / rango) * (y0 - y1);
  const slot = (x1 - x0) / puntos.length;
  const ancho = Math.min(56, slot * 0.62);
  const cadaN = puntos.length > 6 ? 2 : 1;
  const act = activo === null ? null : puntos[activo];
  return (
    <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} role="img" aria-label={etiqueta} className="w-full h-full copiloto-grafica-entra">
      {marcasEje(min, max).map((v, i) => (
        <g key={i}>
          <line x1={x0} x2={x1} y1={py(v)} y2={py(v)} stroke={BORDE} strokeDasharray="3 3" />
          <text x={x0 - 8} y={py(v) + 3} textAnchor="end" style={FUENTE_EJE}>
            {valorCompacto(kind, v)}
          </text>
        </g>
      ))}
      {puntos.map((p, i) => {
        const cx = x0 + slot * i + slot / 2;
        const top = py(Math.max(p.valor, 0));
        const alto = Math.max(1, Math.abs(py(p.valor) - py(0)));
        return (
          <g key={i} onPointerEnter={() => setActivo(i)} onPointerLeave={() => setActivo(null)} opacity={activo === null || activo === i ? 1 : 0.55}>
            <rect x={cx - slot / 2} y={y1} width={slot} height={y0 - y1} fill="transparent" />
            <rect x={cx - ancho / 2} y={top} width={ancho} height={alto} rx={3} fill={ACENTO} />
            {i % cadaN === 0 ? (
              <text x={cx} y={ALTO - 8} textAnchor="middle" style={FUENTE_EJE}>
                {recortar(p.etiqueta, 10)}
              </text>
            ) : null}
            <title>{`${p.etiqueta}: ${formatoCelda(kind, p.valor)}`}</title>
          </g>
        );
      })}
      {act && activo !== null ? <Tooltip x={x0 + slot * activo + slot / 2} y={py(Math.max(act.valor, 0))} etiqueta={act.etiqueta} valor={formatoCelda(kind, act.valor)} ancho={ANCHO} /> : null}
    </svg>
  );
}

export function Linea({ plan, etiqueta }: { plan: Extract<PlanGrafica, { tipo: "line" }>; etiqueta: string }) {
  const [activo, setActivo] = useState<number | null>(null);
  const { puntos, kind } = plan;
  const [min, max] = dominio(puntos.map((p) => p.valor), false);
  const x0 = M.izq;
  const x1 = ANCHO - M.der;
  const y0 = ALTO - M.abajo;
  const y1 = M.arr;
  const px = (i: number) => x0 + (i / (puntos.length - 1)) * (x1 - x0);
  const py = (v: number) => y0 - ((v - min) / (max - min)) * (y0 - y1);
  const trazo = puntos.map((p, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)} ${py(p.valor).toFixed(1)}`).join(" ");
  const cadaN = Math.max(1, Math.ceil(puntos.length / 6));
  const act = activo === null ? null : puntos[activo];

  const mover = (e: EventoPuntero<SVGRectElement>) => {
    const caja = e.currentTarget.getBoundingClientRect();
    if (caja.width === 0) return;
    const fx = ((e.clientX - caja.left) / caja.width) * (x1 - x0);
    setActivo(Math.min(puntos.length - 1, Math.max(0, Math.round((fx / (x1 - x0)) * (puntos.length - 1)))));
  };

  return (
    <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} role="img" aria-label={etiqueta} className="w-full h-full copiloto-grafica-entra">
      {marcasEje(min, max).map((v, i) => (
        <g key={i}>
          <line x1={x0} x2={x1} y1={py(v)} y2={py(v)} stroke={BORDE} strokeDasharray="3 3" />
          <text x={x0 - 8} y={py(v) + 3} textAnchor="end" style={FUENTE_EJE}>
            {valorCompacto(kind, v)}
          </text>
        </g>
      ))}
      {puntos.map((p, i) =>
        i % cadaN === 0 ? (
          <text key={i} x={px(i)} y={ALTO - 8} textAnchor={i === 0 ? "start" : "middle"} style={FUENTE_EJE}>
            {recortar(p.etiqueta, 12)}
          </text>
        ) : null,
      )}
      <path d={trazo} fill="none" stroke={ACENTO} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {puntos.length <= 40
        ? puntos.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.valor)} r={i === activo ? 5 : 3} fill={ACENTO} />)
        : act && activo !== null
          ? <circle cx={px(activo)} cy={py(act.valor)} r={5} fill={ACENTO} />
          : null}
      <rect x={x0} y={y1} width={x1 - x0} height={y0 - y1} fill="transparent" onPointerMove={mover} onPointerDown={mover} onPointerLeave={() => setActivo(null)} />
      {act && activo !== null ? <Tooltip x={px(activo)} y={py(act.valor)} etiqueta={act.etiqueta} valor={formatoCelda(kind, act.valor)} ancho={ANCHO} /> : null}
    </svg>
  );
}

const RADIO_EXT = 90;
const RADIO_INT = 66;
const HUECO_GRADOS = 2.4;

function punto(cx: number, cy: number, r: number, grados: number): [number, number] {
  const rad = ((grados - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Trazo de un segmento de anillo entre dos angulos (grados, 0 = arriba, sentido horario). */
export function trazoAnillo(cx: number, cy: number, rExt: number, rInt: number, a0: number, a1: number): string {
  const grande = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = punto(cx, cy, rExt, a0);
  const [x1, y1] = punto(cx, cy, rExt, a1);
  const [x2, y2] = punto(cx, cy, rInt, a1);
  const [x3, y3] = punto(cx, cy, rInt, a0);
  const f = (n: number) => n.toFixed(2);
  return `M${f(x0)} ${f(y0)} A${rExt} ${rExt} 0 ${grande} 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${rInt} ${rInt} 0 ${grande} 0 ${f(x3)} ${f(y3)} Z`;
}

/** Opacidad de cada segmento: de 1 (el mayor) a 0.35 (el menor), como la dona de Likida. */
export function opacidadSegmento(i: number, n: number): number {
  return n <= 1 ? 1 : 1 - (i * 0.65) / (n - 1);
}

export function Dona({ plan, etiqueta }: { plan: Extract<PlanGrafica, { tipo: "donut" }>; etiqueta: string }) {
  const { segmentos, kind, total } = plan;
  const n = segmentos.length;
  let acumulado = 0;
  const arcos = segmentos.map((s, i) => {
    const grados = (s.valor / total) * 360;
    const ini = acumulado;
    acumulado += grados;
    if (n === 1) return { i, d: `${trazoAnillo(96, 96, RADIO_EXT, RADIO_INT, 0, 179.99)} ${trazoAnillo(96, 96, RADIO_EXT, RADIO_INT, 180, 359.99)}` };
    const hueco = Math.min(HUECO_GRADOS, grados / 2);
    return { i, d: trazoAnillo(96, 96, RADIO_EXT, RADIO_INT, ini + hueco / 2, ini + grados - hueco / 2) };
  });
  const aditivo = kind === "mxn" || kind === "integer";
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <svg viewBox="0 0 192 192" role="img" aria-label={etiqueta} className="w-[140px] h-[140px] shrink-0 copiloto-grafica-entra">
        {arcos.map((a) => (
          <path key={a.i} d={a.d} fill={ACENTO} fillOpacity={opacidadSegmento(a.i, n)}>
            <title>{`${segmentos[a.i]!.etiqueta}: ${formatoCelda(kind, segmentos[a.i]!.valor)}`}</title>
          </path>
        ))}
        {aditivo ? (
          <text x={96} y={101} textAnchor="middle" style={{ fontSize: 14, fontWeight: 600, fill: "hsl(var(--foreground))" }}>
            {valorCompacto(kind, total)}
          </text>
        ) : null}
      </svg>
      <ul className="space-y-1.5 text-sm min-w-[140px] flex-1" aria-hidden="true">
        {segmentos.map((s, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: ACENTO, opacity: opacidadSegmento(i, n) }} />
            <span className="truncate flex-1">{s.etiqueta}</span>
            <span className="font-mono tabular-nums text-muted-foreground text-xs">{formatoCelda("percent", Math.round(s.porcentaje * 10) / 10)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Mini serie de 64x16 para una celda de tabla. Con menos de 2 valores finitos no dibuja nada (no hay tendencia que mostrar). */
export function Sparkline({ valores, etiqueta }: { valores: readonly number[]; etiqueta: string }) {
  const v = valores.filter((n) => Number.isFinite(n));
  if (v.length < 2) return <span className="text-muted-foreground" aria-label={`${etiqueta}: sin datos suficientes`}>—</span>;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const y = (n: number) => (max === min ? 8 : 15 - ((n - min) / (max - min)) * 14);
  const d = v.map((n, i) => `${i === 0 ? "M" : "L"}${((i / (v.length - 1)) * 62 + 1).toFixed(1)} ${y(n).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 64 16" width={64} height={16} role="img" aria-label={`${etiqueta}: ${v.length} puntos, de ${formatoCelda("decimal", v[0]!)} a ${formatoCelda("decimal", v[v.length - 1]!)}`} className="inline-block align-middle">
      <path d={d} fill="none" stroke={ACENTO} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Kpi({ items }: { items: readonly ItemKpi[] }) {
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="copiloto-kpi">
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground truncate">{it.etiqueta}</dt>
          <dd className="font-display text-[22px] font-semibold tabular-nums leading-tight mt-0.5 break-words">{it.texto}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Bloque con grafica: tarjeta con el titulo, la grafica elegida por el catalogo y "Ver como tabla" (los mismos datos
 * como tabla, para accesibilidad). Devuelve null si el bloque no se puede dibujar: el llamador muestra la tabla.
 */
export function GraficaBloque({ bloque, tabla }: { bloque: CopilotoBloque; tabla: ReactNode }) {
  const plan = planGrafica(bloque);
  if (!plan) return null;
  const etiqueta = resumenAria(bloque.title, plan);
  const alturaFija = plan.tipo === "bar" && !plan.horizontal ? true : plan.tipo === "line";
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground mb-2">{bloque.title}</p>
        <div className={alturaFija ? "h-[180px]" : undefined} data-testid="copiloto-grafica" data-tipo={plan.tipo}>
          {plan.tipo === "bar" ? <Barras plan={plan} etiqueta={etiqueta} /> : null}
          {plan.tipo === "line" ? <Linea plan={plan} etiqueta={etiqueta} /> : null}
          {plan.tipo === "donut" ? <Dona plan={plan} etiqueta={etiqueta} /> : null}
          {plan.tipo === "kpi" ? <Kpi items={plan.items} /> : null}
        </div>
        {plan.tipo === "line" && plan.agrupadoPorSemana ? <p className="text-xs text-muted-foreground mt-2">Más de {UMBRAL_SEMANAL} días: se agrupan por semana.</p> : null}
        {plan.tipo === "bar" && plan.omitidos > 0 ? <p className="text-xs text-muted-foreground mt-2">Se grafican las primeras {MAX_BARRAS} filas.</p> : null}
        {plan.tipo === "donut" && plan.agrupados ? <p className="text-xs text-muted-foreground mt-2">Los segmentos menores se agrupan en «Otros»; el detalle está en la tabla (hasta 10 filas).</p> : null}
        <details className="mt-3 group">
          <summary className="text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none transition-colors">Ver como tabla</summary>
          <div className="mt-2">{tabla}</div>
        </details>
      </CardContent>
    </Card>
  );
}

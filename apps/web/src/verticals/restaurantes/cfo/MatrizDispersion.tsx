// CFO-08 · matriz popularidad × ingreso de los platillos: dispersión SVG simple. Eje X = unidades vendidas, eje Y = ingreso; las líneas guía son la
// mediana de cada eje y dividen los cuadrantes Estrella / Caballo / Puzzle / Perro (la misma regla que usa el servicio). SIN margen: el cuadrante
// no usa el costo del platillo hasta que se capture (fase 2); el rótulo lo dice. Cada punto lleva su nombre en `<title>` y en el texto cuando cabe.
import type { PuntoMatriz } from "@atiende/domain-restaurantes/cfo";
import { cn, etiquetasTraducidas, useT } from "@atiende/ui";
import { restaurantesCfoPlatillos } from "@atiende/ui/i18n/restaurantes/cfoPlatillos";

type Cuadrante = PuntoMatriz["cuadrante"];
const CUADRANTES: readonly Cuadrante[] = ["estrella", "popular", "rentable", "revisar"];
/** Etiquetas en el idioma activo (i18n): cada lectura traduce; en espanol, los textos de siempre. */
export const ETIQUETA_CUADRANTE: Readonly<Record<Cuadrante, string>> = etiquetasTraducidas<Cuadrante>(CUADRANTES, (c) => `restaurantes.cfoPlatillos.cuadrante.${c}` as const, restaurantesCfoPlatillos);
const DESCRIPCION: Readonly<Record<Cuadrante, string>> = etiquetasTraducidas<Cuadrante>(CUADRANTES, (c) => `restaurantes.cfoPlatillos.desc.${c}` as const, restaurantesCfoPlatillos);

const ANCHO = 520;
const ALTO = 300;
const MARGEN = { izq: 56, der: 16, arr: 16, abajo: 34 } as const;
const TENUE = "hsl(var(--muted-foreground))";
const TRAZO = "hsl(var(--primary))";
const MAX_ETIQUETAS = 10;

const mediana = (v: readonly number[]): number => {
  const o = [...v].sort((a, b) => a - b);
  if (o.length === 0) return 0;
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 1 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

export interface MatrizDispersionProps {
  readonly puntos: readonly PuntoMatriz[];
  readonly formatoIngreso: (centavos: number) => string;
  readonly formatoUnidades: (n: number) => string;
  readonly sinDatos?: string;
}

export function MatrizDispersion({ puntos, formatoIngreso, formatoUnidades, sinDatos }: MatrizDispersionProps) {
  const t = useT(restaurantesCfoPlatillos);
  if (puntos.length === 0) {
    return (
      <p role="status" data-testid="grafica-sin-datos" className="py-6 text-center text-xs text-faint">
        {sinDatos ?? t("restaurantes.cfoPlatillos.sinVentasMatriz")}
      </p>
    );
  }
  const maxX = Math.max(...puntos.map((p) => p.unidades), 1);
  const maxY = Math.max(...puntos.map((p) => p.ingresoCentavos), 1);
  const medX = mediana(puntos.map((p) => p.unidades));
  const medY = mediana(puntos.map((p) => p.ingresoCentavos));
  const w = ANCHO - MARGEN.izq - MARGEN.der;
  const h = ALTO - MARGEN.arr - MARGEN.abajo;
  // Escala de raíz cuadrada: un platillo que domina las ventas no aplasta a los demás contra el origen (los ejes lo dicen).
  const x = (v: number): number => MARGEN.izq + Math.sqrt(v / maxX) * w;
  const y = (v: number): number => MARGEN.arr + h - Math.sqrt(v / maxY) * h;
  const conEtiqueta = new Set([...puntos].sort((a, b) => b.ingresoCentavos - a.ingresoCentavos).slice(0, MAX_ETIQUETAS).map((p) => p.productoRef));
  const resumen = (["estrella", "popular", "rentable", "revisar"] as const)
    .map((c) => `${ETIQUETA_CUADRANTE[c]}: ${puntos.filter((p) => p.cuadrante === c).map((p) => p.nombre).join(", ") || t("restaurantes.cfoPlatillos.ninguno")}`)
    .join("; ");
  return (
    <div data-testid="matriz-dispersion" className="min-w-0">
      <svg viewBox={`0 0 ${ANCHO} ${ALTO}`} role="img" aria-label={t("restaurantes.cfoPlatillos.matrizAria", { resumen })} className="block h-auto w-full">
        <rect x={MARGEN.izq} y={MARGEN.arr} width={w} height={h} fill="none" stroke={TENUE} strokeOpacity={0.3} />
        <line x1={x(medX)} x2={x(medX)} y1={MARGEN.arr} y2={MARGEN.arr + h} stroke={TENUE} strokeOpacity={0.5} strokeDasharray="4 3" data-testid="matriz-mediana-x" />
        <line x1={MARGEN.izq} x2={MARGEN.izq + w} y1={y(medY)} y2={y(medY)} stroke={TENUE} strokeOpacity={0.5} strokeDasharray="4 3" data-testid="matriz-mediana-y" />
        <text x={MARGEN.izq + w - 4} y={MARGEN.arr + 12} textAnchor="end" fontSize={10} fill={TENUE}>
          {ETIQUETA_CUADRANTE.estrella}
        </text>
        <text x={MARGEN.izq + w - 4} y={MARGEN.arr + h - 6} textAnchor="end" fontSize={10} fill={TENUE}>
          {ETIQUETA_CUADRANTE.popular}
        </text>
        <text x={MARGEN.izq + 4} y={MARGEN.arr + 12} fontSize={10} fill={TENUE}>
          {ETIQUETA_CUADRANTE.rentable}
        </text>
        <text x={MARGEN.izq + 4} y={MARGEN.arr + h - 6} fontSize={10} fill={TENUE}>
          {ETIQUETA_CUADRANTE.revisar}
        </text>
        <text x={MARGEN.izq + w / 2} y={ALTO - 6} textAnchor="middle" fontSize={10} fill={TENUE}>
          {t("restaurantes.cfoPlatillos.ejeX", { max: formatoUnidades(maxX) })}
        </text>
        <text x={12} y={MARGEN.arr + h / 2} textAnchor="middle" fontSize={10} fill={TENUE} transform={`rotate(-90 12 ${MARGEN.arr + h / 2})`}>
          {t("restaurantes.cfoPlatillos.ejeY", { max: formatoIngreso(maxY) })}
        </text>
        {puntos.map((p) => {
          const fuerte = p.cuadrante === "estrella";
          return (
            <g key={p.productoRef} data-testid="matriz-punto" data-cuadrante={p.cuadrante}>
              <circle cx={x(p.unidades)} cy={y(p.ingresoCentavos)} r={fuerte ? 6 : 5} fill={TRAZO} fillOpacity={fuerte ? 0.95 : p.cuadrante === "revisar" ? 0.35 : 0.65} stroke={TRAZO}>
                <title>{t("restaurantes.cfoPlatillos.puntoTitulo", { nombre: p.nombre, unidades: formatoUnidades(p.unidades), ingreso: formatoIngreso(p.ingresoCentavos), cuadrante: ETIQUETA_CUADRANTE[p.cuadrante], descripcion: DESCRIPCION[p.cuadrante] })}</title>
              </circle>
              {conEtiqueta.has(p.productoRef) && (
                <text x={Math.min(x(p.unidades) + 8, ANCHO - 70)} y={y(p.ingresoCentavos) + 3} fontSize={9} fill={TENUE}>
                  {p.nombre.length > 18 ? `${p.nombre.slice(0, 17)}…` : p.nombre}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className={cn("mt-1 text-2xs text-muted-foreground")} data-testid="matriz-sin-margen">
        {t("restaurantes.cfoPlatillos.matrizNota")}

      </p>
    </div>
  );
}

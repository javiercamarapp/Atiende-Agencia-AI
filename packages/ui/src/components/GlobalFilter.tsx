// Filtro de rango 7d / 30d / Todo de Likida (`admin/ui/global-filter.tsx`), para react-router. El rango vive
// en la URL (`?rango=`): la pagina lo lee con `resolverRango` y decide que consulta correr, nunca un filtro
// decorativo que no cambia el dato de abajo.
//
// `resolverRango` decide el DEFAULT en la misma llamada que lee el parametro y el filtro recibe ese objeto
// entero (no dos valores sueltos): en Likida el rango activo y el default se desincronizaron dos veces y el
// sintoma era un boton que no respondia. La opcion que ES el default se enlaza SIN `?rango=` (URL limpia).
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";

export type Rango = "7" | "30" | "todo";

const OPCIONES: readonly { readonly valor: Rango; readonly etiqueta: string }[] = [
  { valor: "7", etiqueta: "7d" },
  { valor: "30", etiqueta: "30d" },
  { valor: "todo", etiqueta: "Todo" },
];

export interface RangoResuelto {
  /** El rango que la pagina tiene que usar AHORA. */
  readonly rango: Rango;
  /** Cual opcion se asume cuando no hay `?rango=`. */
  readonly pordefecto: Rango;
  /** Dias de la ventana (con `todo` cae al default de la pagina para consultas secundarias). */
  readonly ventanaDias: number;
  /** Ventana para las consultas: `undefined` con `todo` = sin corte. */
  readonly ventana: number | undefined;
}

export function resolverRango(crudo: string | null | undefined, pordefecto: Rango): RangoResuelto {
  const rango: Rango = crudo === "7" || crudo === "30" || crudo === "todo" ? crudo : pordefecto;
  const efectivo = rango === "todo" ? pordefecto : rango;
  const ventanaDias = efectivo === "30" ? 30 : 7;
  return { rango, pordefecto, ventanaDias, ventana: rango === "todo" ? undefined : ventanaDias };
}

/** A donde apunta cada pildora; pura y exportada para el viaje redondo (construir la URL y volver a leerla con `resolverRango`). */
export function urlDeRango(base: string, rango: Rango, pordefecto: Rango, extra?: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams(extra);
  if (rango !== pordefecto) params.set("rango", rango);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export interface GlobalFilterProps {
  /** Ruta de la pagina (p. ej. `/superadmin/analitica`). */
  readonly base: string;
  readonly r: RangoResuelto;
  /** Parametros que ya vivian en la URL y no son `rango`, para no perderlos al cambiar de rango. */
  readonly extra?: Readonly<Record<string, string>>;
  readonly className?: string;
}

export function GlobalFilter({ base, r, extra, className }: GlobalFilterProps) {
  return (
    <div role="group" aria-label="Rango de fechas" className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-canvas p-0.5", className)}>
      {OPCIONES.map((o) => {
        const activo = r.rango === o.valor;
        return (
          <Link
            key={o.valor}
            to={urlDeRango(base, o.valor, r.pordefecto, extra)}
            replace
            preventScrollReset
            aria-current={activo ? "true" : undefined}
            className={cn("rounded-full px-2.5 py-1 text-xs font-medium transition-colors", activo ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {o.etiqueta}
          </Link>
        );
      })}
    </div>
  );
}

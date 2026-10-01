import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "../lib/utils";
import { EstadoCargando } from "./EstadoCargando";
import { EstadoError } from "./EstadoError";
import { EstadoVacio } from "./EstadoVacio";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export type DataTableEstado = "loading" | "error" | "empty" | "ok";
export type DataTableDireccion = "asc" | "desc";
export interface DataTableOrden {
  readonly columnaId: string;
  readonly direccion: DataTableDireccion;
}
export type DataTableValorOrden = string | number | boolean | Date | null | undefined;

export interface DataTableColumna<T> {
  readonly id: string;
  readonly encabezado: React.ReactNode;
  /** Texto del encabezado para lectores de pantalla / tarjetas cuando `encabezado` no es texto. */
  readonly etiqueta?: string;
  readonly celda: (fila: T) => React.ReactNode;
  /** Con `valorOrden`, el encabezado se vuelve un boton que ordena (asc -> desc -> sin orden). */
  readonly valorOrden?: (fila: T) => DataTableValorOrden;
  readonly alinear?: "left" | "center" | "right";
  readonly className?: string;
  /** En la vista de tarjetas esta columna es el titulo de la tarjeta (solo se usa la primera marcada). */
  readonly principal?: boolean;
  /** Omite la columna en la vista de tarjetas (p. ej. una columna de acciones repetida). */
  readonly ocultarEnTarjeta?: boolean;
}

export interface DataTableProps<T> {
  readonly columnas: readonly DataTableColumna<T>[];
  readonly filas: readonly T[];
  readonly obtenerId: (fila: T) => string;
  /** Nombre accesible de la tabla (obligatorio: describe el contenido a los lectores de pantalla). */
  readonly etiqueta: string;
  /** Si se omite: "empty" cuando no hay filas y "ok" en el resto. */
  readonly estado?: DataTableEstado;
  readonly vacio?: { readonly titulo?: string; readonly mensaje: string; readonly accion?: React.ReactNode };
  readonly error?: { readonly titulo?: string; readonly mensaje?: string; readonly onReintentar?: () => void };

  /** Orden controlado. Sin esto la tabla ordena internamente. */
  readonly orden?: DataTableOrden | null;
  readonly onOrdenChange?: (orden: DataTableOrden | null) => void;

  /** Paginacion en cliente. `false` la desactiva. @default { tamano: 10 } */
  readonly paginacion?: false | { readonly tamano?: number; readonly pagina?: number; readonly onPaginaChange?: (pagina: number) => void };

  readonly seleccionable?: boolean;
  readonly seleccion?: ReadonlySet<string>;
  readonly onSeleccionChange?: (seleccion: ReadonlySet<string>) => void;

  /** Fila clicable accesible: foco con Tab, Enter/Espacio la activan. */
  readonly onFilaClick?: (fila: T) => void;

  /** "auto" cambia a tarjetas por debajo de 768 px. @default "auto" */
  readonly vista?: "auto" | "tabla" | "tarjetas";
  readonly className?: string;
}

const ALINEAR = { left: "text-left", center: "text-center", right: "text-right" } as const;
const CONSULTA_ESCRITORIO = "(min-width: 768px)";

/** true en >= md. Sin matchMedia (jsdom, SSR) asume escritorio. */
function useEsEscritorio(): boolean {
  const leer = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(CONSULTA_ESCRITORIO).matches : true);
  const [v, setV] = React.useState(leer);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(CONSULTA_ESCRITORIO);
    const alCambiar = () => setV(mq.matches);
    alCambiar();
    mq.addEventListener("change", alCambiar);
    return () => mq.removeEventListener("change", alCambiar);
  }, []);
  return v;
}

function comparar(a: DataTableValorOrden, b: DataTableValorOrden): number {
  const vacioA = a === null || a === undefined || a === "";
  const vacioB = b === null || b === undefined || b === "";
  if (vacioA || vacioB) return vacioA === vacioB ? 0 : vacioA ? 1 : -1; // vacios siempre al final
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

/** Ordena sin mutar y de forma estable. Exportado para pruebas. */
export function ordenarFilas<T>(filas: readonly T[], columna: DataTableColumna<T> | undefined, direccion: DataTableDireccion): T[] {
  const copia = [...filas];
  const valor = columna?.valorOrden;
  if (!valor) return copia;
  const signo = direccion === "asc" ? 1 : -1;
  return copia
    .map((fila, i) => ({ fila, i }))
    .sort((x, y) => {
      const a = valor(x.fila);
      const b = valor(y.fila);
      const vacio = (v: DataTableValorOrden) => v === null || v === undefined || v === "";
      // Los vacios van al final en ambas direcciones.
      if (vacio(a) || vacio(b)) return comparar(a, b) || x.i - y.i;
      return signo * comparar(a, b) || x.i - y.i;
    })
    .map((x) => x.fila);
}

function textoColumna<T>(c: DataTableColumna<T>): string {
  return c.etiqueta ?? (typeof c.encabezado === "string" ? c.encabezado : c.id);
}

/**
 * Tabla de datos con la receta de Likida (filas de ~37 px, cabecera mono, filas punteadas): ordenar, paginar, seleccionar, estados cargando/error/
 * vacio, y vista de tarjetas en movil. Accesible: `<table>` con nombre, `aria-sort`
 * en el encabezado activo, encabezados ordenables como botones, casillas con
 * etiqueta, filas clicables enfocables (Enter/Espacio) y avisos `aria-live`.
 */
export function DataTable<T>({
  columnas,
  filas,
  obtenerId,
  etiqueta,
  estado,
  vacio = { mensaje: "No hay registros que mostrar." },
  error,
  orden: ordenControlado,
  onOrdenChange,
  paginacion = {},
  seleccionable = false,
  seleccion: seleccionControlada,
  onSeleccionChange,
  onFilaClick,
  vista = "auto",
  className,
}: DataTableProps<T>) {
  const esEscritorio = useEsEscritorio();
  const comoTarjetas = vista === "tarjetas" || (vista === "auto" && !esEscritorio);

  // ---- orden (controlado o interno) ----
  const [ordenInterno, setOrdenInterno] = React.useState<DataTableOrden | null>(null);
  const orden = ordenControlado !== undefined ? ordenControlado : ordenInterno;
  const cambiarOrden = (nuevo: DataTableOrden | null) => {
    if (ordenControlado === undefined) setOrdenInterno(nuevo);
    onOrdenChange?.(nuevo);
  };
  const alternarOrden = (columnaId: string) => {
    if (orden?.columnaId !== columnaId) return cambiarOrden({ columnaId, direccion: "asc" });
    if (orden.direccion === "asc") return cambiarOrden({ columnaId, direccion: "desc" });
    cambiarOrden(null);
  };

  // ---- seleccion (controlada o interna) ----
  const [seleccionInterna, setSeleccionInterna] = React.useState<ReadonlySet<string>>(() => new Set());
  const seleccion = seleccionControlada ?? seleccionInterna;
  const cambiarSeleccion = (nueva: ReadonlySet<string>) => {
    if (seleccionControlada === undefined) setSeleccionInterna(nueva);
    onSeleccionChange?.(nueva);
  };

  // ---- datos visibles ----
  const columnaOrden = orden ? columnas.find((c) => c.id === orden.columnaId) : undefined;
  const ordenadas = React.useMemo(
    () => (orden && columnaOrden ? ordenarFilas(filas, columnaOrden, orden.direccion) : [...filas]),
    [filas, orden, columnaOrden],
  );

  const pag = paginacion === false ? null : paginacion;
  const tamano = Math.max(1, pag?.tamano ?? 10);
  const totalPaginas = pag ? Math.max(1, Math.ceil(ordenadas.length / tamano)) : 1;
  const [paginaInterna, setPaginaInterna] = React.useState(1);
  const paginaSolicitada = pag?.pagina ?? paginaInterna;
  const pagina = Math.min(Math.max(1, paginaSolicitada), totalPaginas);
  const irAPagina = (p: number) => {
    const destino = Math.min(Math.max(1, p), totalPaginas);
    if (pag?.pagina === undefined) setPaginaInterna(destino);
    pag?.onPaginaChange?.(destino);
  };
  // Si el conjunto se encoge (filtro, borrado) y la pagina queda fuera de rango, se corrige.
  React.useEffect(() => {
    if (pag && paginaInterna > totalPaginas && pag.pagina === undefined) setPaginaInterna(totalPaginas);
  }, [pag, paginaInterna, totalPaginas]);

  const visibles = pag ? ordenadas.slice((pagina - 1) * tamano, pagina * tamano) : ordenadas;
  const desde = ordenadas.length === 0 ? 0 : (pag ? (pagina - 1) * tamano : 0) + 1;
  const hasta = (pag ? (pagina - 1) * tamano : 0) + visibles.length;

  const estadoEfectivo: DataTableEstado = estado ?? (filas.length === 0 ? "empty" : "ok");

  if (estadoEfectivo === "loading") return <EstadoCargando variante="tabla" etiqueta={`Cargando ${etiqueta}`} className={className} />;
  if (estadoEfectivo === "error") {
    return <EstadoError titulo={error?.titulo} mensaje={error?.mensaje} onReintentar={error?.onReintentar} className={className} compacto />;
  }
  if (estadoEfectivo === "empty") {
    return <EstadoVacio titulo={vacio.titulo ?? "Sin registros"} mensaje={vacio.mensaje} accion={vacio.accion} className={className} compacto />;
  }

  const idsVisibles = visibles.map(obtenerId);
  const seleccionadasVisibles = idsVisibles.filter((id) => seleccion.has(id)).length;
  const todasVisibles = idsVisibles.length > 0 && seleccionadasVisibles === idsVisibles.length;
  const algunasVisibles = seleccionadasVisibles > 0 && !todasVisibles;

  const alternarTodas = () => {
    const nueva = new Set(seleccion);
    if (todasVisibles) idsVisibles.forEach((id) => nueva.delete(id));
    else idsVisibles.forEach((id) => nueva.add(id));
    cambiarSeleccion(nueva);
  };
  const alternarFila = (id: string) => {
    const nueva = new Set(seleccion);
    if (nueva.has(id)) nueva.delete(id);
    else nueva.add(id);
    cambiarSeleccion(nueva);
  };

  /** Enter/Espacio sobre la fila (no sobre un control interno) la activan. */
  const teclaFila = (e: React.KeyboardEvent, fila: T) => {
    if (!onFilaClick || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onFilaClick(fila);
    }
  };
  /** Un clic sobre un control interno (boton, enlace, casilla) no cuenta como clic de fila. */
  const clicFila = (e: React.MouseEvent, fila: T) => {
    if (!onFilaClick) return;
    if ((e.target as HTMLElement).closest("a, button, input, select, textarea, label, [role='checkbox']")) return;
    onFilaClick(fila);
  };

  const principal = columnas.find((c) => c.principal) ?? columnas[0];

  return (
    <div className={cn("grid min-w-0 gap-2.5", className)}>
      {comoTarjetas ? (
        <ul aria-label={etiqueta} className="grid gap-2">
          {seleccionable && (
            <li className="flex items-center rounded-lg border border-border bg-card px-3 py-2">
              <Checkbox
                label="Seleccionar todas"
                checked={todasVisibles}
                indeterminate={algunasVisibles}
                onChange={alternarTodas}
              />
            </li>
          )}
          {visibles.map((fila) => {
            const id = obtenerId(fila);
            const marcada = seleccion.has(id);
            return (
              <li
                key={id}
                data-state={marcada ? "selected" : undefined}
                tabIndex={onFilaClick ? 0 : undefined}
                onClick={(e) => clicFila(e, fila)}
                onKeyDown={(e) => teclaFila(e, fila)}
                className={cn(
                  "rounded-lg border border-border bg-card p-3 shadow-card data-[state=selected]:border-primary/50 data-[state=selected]:bg-sunken",
                  onFilaClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 text-sm font-medium text-foreground">{principal?.celda(fila)}</div>
                  {seleccionable && (
                    <Checkbox
                      aria-label={`Seleccionar ${textoColumna(principal!)} ${id}`}
                      checked={marcada}
                      onChange={() => alternarFila(id)}
                    />
                  )}
                </div>
                <dl className="mt-2 grid gap-1.5">
                  {columnas
                    .filter((c) => c !== principal && !c.ocultarEnTarjeta)
                    .map((c) => (
                      <div key={c.id} className="flex items-baseline justify-between gap-3 text-ui">
                        <dt className="shrink-0 text-xs text-muted-foreground">{textoColumna(c)}</dt>
                        <dd className="min-w-0 text-right text-foreground">{c.celda(fila)}</dd>
                      </div>
                    ))}
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <Table aria-label={etiqueta} className="[&_tbody_tr]:border-dashed">
          <TableHeader>
            <TableRow>
              {seleccionable && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Seleccionar todas las filas de la página"
                    checked={todasVisibles}
                    indeterminate={algunasVisibles}
                    onChange={alternarTodas}
                  />
                </TableHead>
              )}
              {columnas.map((c) => {
                const ordenable = c.valorOrden !== undefined;
                const activa = orden?.columnaId === c.id;
                const ariaSort = !ordenable ? undefined : activa ? (orden!.direccion === "asc" ? "ascending" : "descending") : "none";
                const Icono = !activa ? ArrowUpDown : orden!.direccion === "asc" ? ArrowUp : ArrowDown;
                return (
                  <TableHead key={c.id} scope="col" aria-sort={ariaSort} className={cn(ALINEAR[c.alinear ?? "left"], c.className)}>
                    {ordenable ? (
                      <button
                        type="button"
                        onClick={() => alternarOrden(c.id)}
                        className={cn(
                          "-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium transition-[color,background-color] duration-fast ease-brand hover:bg-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          activa && "text-foreground",
                        )}
                      >
                        {c.encabezado}
                        <Icono aria-hidden="true" className={cn("size-3.5", !activa && "opacity-50")} />
                      </button>
                    ) : (
                      c.encabezado
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibles.map((fila) => {
              const id = obtenerId(fila);
              const marcada = seleccion.has(id);
              return (
                <TableRow
                  key={id}
                  data-state={marcada ? "selected" : undefined}
                  tabIndex={onFilaClick ? 0 : undefined}
                  onClick={(e) => clicFila(e, fila)}
                  onKeyDown={(e) => teclaFila(e, fila)}
                  className={cn(onFilaClick && "cursor-pointer focus-visible:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
                >
                  {seleccionable && (
                    <TableCell className="w-10">
                      <Checkbox aria-label={`Seleccionar fila ${id}`} checked={marcada} onChange={() => alternarFila(id)} />
                    </TableCell>
                  )}
                  {columnas.map((c) => (
                    <TableCell key={c.id} className={cn(ALINEAR[c.alinear ?? "left"], c.className)}>
                      {c.celda(fila)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {(pag || seleccionable) && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-muted-foreground">
          <p role="status" aria-live="polite">
            {seleccionable && seleccion.size > 0 ? `${seleccion.size} seleccionada${seleccion.size === 1 ? "" : "s"} · ` : ""}
            {ordenadas.length === 0 ? "Sin resultados" : `Mostrando ${desde}–${hasta} de ${ordenadas.length}`}
          </p>
          {pag && totalPaginas > 1 && (
            <nav aria-label="Paginación" className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="h-7 rounded-lg px-2.5 text-xs" iconLeft={<ChevronLeft aria-hidden="true" />} disabled={pagina <= 1} onClick={() => irAPagina(pagina - 1)}>
                Anterior
              </Button>
              <span aria-current="page" className="min-w-[5.5rem] text-center">
                Página {pagina} de {totalPaginas}
              </span>
              <Button type="button" variant="outline" size="sm" className="h-7 rounded-lg px-2.5 text-xs" iconRight={<ChevronRight aria-hidden="true" />} disabled={pagina >= totalPaginas} onClick={() => irAPagina(pagina + 1)}>
                Siguiente
              </Button>
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

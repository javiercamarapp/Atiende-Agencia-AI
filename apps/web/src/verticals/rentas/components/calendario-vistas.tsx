// Rn-06 -- vistas del calendario visual de rentas: mes, línea de tiempo por unidad, agenda (móvil) y panel de detalle.
// Presentacionales: reciben elementos ya filtrados (lib/calendario-visual.ts) y no llaman a la red.
//
// Accesibilidad: la rejilla del mes es un `role="grid"` con una sola parada de Tab (tabindex móvil) y flechas/Inicio/Fin/
// RePág/AvPág; cada día es un botón con un `aria-label` que resume su contenido. El color nunca es la única señal: cada barra
// lleva icono + texto (huésped, canal, motivo) y los estados provisional/conflicto/bloqueo también se distinguen por borde
// y por icono. Los tonos salen de los tokens del DS v2 (texto `x` sobre fondo `x-tint`, contraste medido en claro y oscuro).
import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { AlertTriangle, Ban, BedDouble, CalendarDays, Sparkles } from "lucide-react";
import { EstadoVacio, StatusBadge } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { cn } from "@atiende/ui";
import {
  ABREV_DIA_SEMANA,
  agendaDelMes,
  contenidoPorDia,
  diasDelMes,
  diasEntre,
  etiquetaCanal,
  etiquetaDiaLarga,
  etiquetaMes,
  etiquetaRango,
  limitarPorDia,
  resumenDia,
  segmentosDeUnidad,
  semanasDeRejilla,
  sumarDias,
  tonoDeElemento,
  moverMes,
  claveMesDe,
} from "../lib/calendario-visual.ts";
import type { ClaveMes, ElementoCalendario, FechaLocal } from "../lib/calendario-visual.ts";
import type { UnidadOption } from "../lib/calendario-client.ts";

/** Clases por tono: las mismas parejas `texto x / fondo x-tint` de <StatusBadge>, para barras y chips. */
export const CLASE_TONO: Readonly<Record<StatusTone, string>> = {
  neutral: "border-border bg-muted text-muted-foreground",
  info: "border-info/25 bg-info-tint text-info",
  success: "border-success/25 bg-success-tint text-success",
  warning: "border-warning/25 bg-warning-tint text-warning",
  danger: "border-destructive/25 bg-destructive-tint text-destructive",
};

/** Máximo de chips por celda del mes; el resto se resume en "+N más" (rendimiento y legibilidad con cientos de reservas). */
export const MAX_CHIPS_POR_DIA = 3;

/** Columnas de la línea de tiempo: literales completos para que Tailwind los vea (no se pueden construir con plantillas). */
const GRID_DIAS: Readonly<Record<number, string>> = {
  28: "grid-cols-[repeat(28,2.25rem)]",
  29: "grid-cols-[repeat(29,2.25rem)]",
  30: "grid-cols-[repeat(30,2.25rem)]",
  31: "grid-cols-[repeat(31,2.25rem)]",
};
const COL_INICIO: readonly string[] = ["col-start-1", "col-start-2", "col-start-3", "col-start-4", "col-start-5", "col-start-6", "col-start-7", "col-start-8", "col-start-9", "col-start-10", "col-start-11", "col-start-12", "col-start-13", "col-start-[14]", "col-start-[15]", "col-start-[16]", "col-start-[17]", "col-start-[18]", "col-start-[19]", "col-start-[20]", "col-start-[21]", "col-start-[22]", "col-start-[23]", "col-start-[24]", "col-start-[25]", "col-start-[26]", "col-start-[27]", "col-start-[28]", "col-start-[29]", "col-start-[30]", "col-start-[31]"];
// Indice = noches visibles (1..31); el 0 no se usa.
const COL_SPAN: readonly string[] = ["", "col-span-1", "col-span-2", "col-span-3", "col-span-4", "col-span-5", "col-span-6", "col-span-7", "col-span-8", "col-span-9", "col-span-10", "col-span-11", "col-span-12", "col-span-[13]", "col-span-[14]", "col-span-[15]", "col-span-[16]", "col-span-[17]", "col-span-[18]", "col-span-[19]", "col-span-[20]", "col-span-[21]", "col-span-[22]", "col-span-[23]", "col-span-[24]", "col-span-[25]", "col-span-[26]", "col-span-[27]", "col-span-[28]", "col-span-[29]", "col-span-[30]", "col-span-[31]"];
const FILA_CARRIL: readonly string[] = ["row-start-1", "row-start-2", "row-start-3", "row-start-4", "row-start-5", "row-start-6"];

function IconoElemento({ e }: { readonly e: ElementoCalendario }) {
  const clase = "size-3 shrink-0";
  if (e.enConflicto) return <AlertTriangle aria-hidden="true" className={clase} strokeWidth={2} />;
  if (e.tipo === "bloqueo") return <Ban aria-hidden="true" className={clase} strokeWidth={2} />;
  if (e.tipo === "limpieza") return <Sparkles aria-hidden="true" className={clase} strokeWidth={2} />;
  return <BedDouble aria-hidden="true" className={clase} strokeWidth={2} />;
}

/** Borde por tipo: bloqueo = punteado, provisional = punteado, conflicto = grueso; refuerzan el tono sin depender del color. */
function claseBorde(e: ElementoCalendario): string {
  if (e.enConflicto) return "border-2";
  if (e.tipo === "bloqueo" || e.estado === "provisional") return "border border-dashed";
  return "border";
}

function Chip({ e, canales, titulo }: { readonly e: ElementoCalendario; readonly canales: readonly string[]; readonly titulo?: string }) {
  return (
    <span title={titulo} className={cn("flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-2xs font-medium leading-tight", CLASE_TONO[tonoDeElemento(e, canales)], claseBorde(e), e.apagado && "opacity-60")}>
      <IconoElemento e={e} />
      <span className="truncate">{e.etiqueta}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Leyenda
// ---------------------------------------------------------------------------------------------------------------------

export function Leyenda({ canales }: { readonly canales: readonly string[] }) {
  const muestra = (tono: StatusTone, icono: ElementoCalendario, texto: string) => (
    <li key={texto} className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("flex items-center rounded px-1 py-0.5", CLASE_TONO[tono], claseBorde(icono))}>
        <IconoElemento e={icono} />
      </span>
      {texto}
    </li>
  );
  const base = { unidadId: "", inicio: "", fin: "", etiqueta: "", descripcion: "", canal: null, estado: "confirmado", enConflicto: false, apagado: false } as const;
  return (
    <ul aria-label="Leyenda" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
      {(canales.length > 0 ? canales : ["manual"]).map((c) => muestra(tonoDeElemento({ ...base, id: c, tipo: "reserva", canal: c }, canales), { ...base, id: c, tipo: "reserva", canal: c }, `Reserva ${etiquetaCanal(c).toLowerCase()}`))}
      {muestra("warning", { ...base, id: "p", tipo: "reserva", estado: "provisional" }, "Provisional")}
      {muestra("neutral", { ...base, id: "b", tipo: "bloqueo" }, "Bloqueo")}
      {muestra("neutral", { ...base, id: "l", tipo: "limpieza" }, "Limpieza")}
      {muestra("danger", { ...base, id: "c", tipo: "reserva", enConflicto: true }, "Conflicto")}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Vista mes
// ---------------------------------------------------------------------------------------------------------------------

export interface VistaMesProps {
  readonly mes: ClaveMes;
  readonly hoy: FechaLocal;
  readonly elementos: readonly ElementoCalendario[];
  readonly canales: readonly string[];
  /** Nombre de la unidad de un elemento: va en el tooltip de cada chip (la rejilla mezcla las unidades). */
  readonly nombreUnidad: (id: string) => string;
  /** Día con tabindex 0 (parada de Tab de la rejilla). */
  readonly foco: FechaLocal;
  readonly diaSeleccionado: FechaLocal | null;
  /** `true` cuando el último cambio de foco vino del teclado: solo entonces se mueve el foco real del DOM. */
  readonly moverFocoDom: boolean;
  readonly onFoco: (dia: FechaLocal, desdeTeclado: boolean) => void;
  readonly onSeleccionarDia: (dia: FechaLocal) => void;
  readonly onCambiarMes: (mes: ClaveMes) => void;
}

export function VistaMes({ mes, hoy, elementos, canales, nombreUnidad, foco, diaSeleccionado, moverFocoDom, onFoco, onSeleccionarDia, onCambiarMes }: VistaMesProps) {
  const semanas = semanasDeRejilla(mes);
  const dias = semanas.flat();
  const contenido = contenidoPorDia(elementos, dias);
  const rejilla = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moverFocoDom) return;
    rejilla.current?.querySelector<HTMLButtonElement>(`button[data-fecha="${foco}"]`)?.focus();
  }, [foco, moverFocoDom, mes]);

  function mover(destino: FechaLocal) {
    // Si el destino sale de la rejilla visible se cambia de mes (la rejilla del mes nuevo ya lo incluye).
    if (!dias.includes(destino)) onCambiarMes(claveMesDe(destino));
    onFoco(destino, true);
  }

  function alTeclear(ev: KeyboardEvent<HTMLDivElement>) {
    const paso: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (ev.key in paso) {
      ev.preventDefault();
      mover(sumarDias(foco, paso[ev.key]!));
    } else if (ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      const semana = semanas.find((s) => s.includes(foco));
      if (semana) mover(ev.key === "Home" ? semana[0]! : semana[6]!);
    } else if (ev.key === "PageUp" || ev.key === "PageDown") {
      ev.preventDefault();
      const siguiente = moverMes(claveMesDe(foco), ev.key === "PageUp" ? -1 : 1);
      const dia = Number(foco.slice(8, 10));
      const maximo = diasDelMes(siguiente).length;
      mover(`${siguiente}-${String(Math.min(dia, maximo)).padStart(2, "0")}`);
    }
  }

  return (
    <div ref={rejilla} role="grid" aria-label={`Calendario de ${etiquetaMes(mes)}`} onKeyDown={alTeclear} className="overflow-hidden rounded-lg border border-border bg-card">
      <div role="row" className="grid grid-cols-7 border-b border-border bg-muted">
        {ABREV_DIA_SEMANA.map((d) => (
          <div key={d} role="columnheader" className="px-2 py-1.5 text-center font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
            {d}
          </div>
        ))}
      </div>
      {semanas.map((semana) => (
        <div key={semana[0]} role="row" className="grid grid-cols-7 border-b border-border last:border-b-0">
          {semana.map((dia) => {
            const c = contenido.get(dia);
            const { visibles, ocultos } = limitarPorDia(c?.noches ?? [], MAX_CHIPS_POR_DIA);
            const fuera = claveMesDe(dia) !== mes;
            const esHoy = dia === hoy;
            const salidas = c?.salidas.length ?? 0;
            return (
              <div key={dia} role="gridcell" aria-selected={diaSeleccionado === dia} className="min-w-0 border-r border-border last:border-r-0">
                <button
                  type="button"
                  data-fecha={dia}
                  tabIndex={dia === foco ? 0 : -1}
                  aria-label={resumenDia(dia, c, esHoy)}
                  aria-current={esHoy ? "date" : undefined}
                  onFocus={() => onFoco(dia, false)}
                  onClick={() => onSeleccionarDia(dia)}
                  className={cn(
                    "flex h-full min-h-24 w-full flex-col items-stretch gap-1 p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    fuera && "bg-muted/40",
                    diaSeleccionado === dia && "bg-primary/10",
                  )}
                >
                  <span className={cn("inline-flex size-6 items-center justify-center self-start rounded-full text-xs font-semibold", esHoy ? "bg-primary text-primary-foreground" : fuera ? "text-muted-foreground" : "text-foreground")}>{Number(dia.slice(8, 10))}</span>
                  {visibles.map((e) => (
                    <Chip key={e.id} e={e} canales={canales} titulo={`${nombreUnidad(e.unidadId)}: ${e.descripcion}`} />
                  ))}
                  {ocultos > 0 && <span className="px-1 text-2xs font-medium text-muted-foreground">+{ocultos} más</span>}
                  {salidas > 0 && (
                    <span className="mt-auto px-1 text-2xs text-muted-foreground">
                      {salidas} {salidas === 1 ? "salida" : "salidas"}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Línea de tiempo por unidad
// ---------------------------------------------------------------------------------------------------------------------

export interface VistaLineaProps {
  readonly mes: ClaveMes;
  readonly hoy: FechaLocal;
  readonly unidades: readonly UnidadOption[];
  readonly elementos: readonly ElementoCalendario[];
  readonly canales: readonly string[];
  readonly seleccionadoId: string | null;
  readonly onSeleccionar: (e: ElementoCalendario) => void;
}

export function VistaLinea({ mes, hoy, unidades, elementos, canales, seleccionadoId, onSeleccionar }: VistaLineaProps) {
  const dias = diasDelMes(mes);
  const desde = dias[0]!;
  const hasta = sumarDias(dias[dias.length - 1]!, 1);
  const grid = GRID_DIAS[dias.length] ?? GRID_DIAS[31]!;
  const indiceHoy = hoy >= desde && hoy < hasta ? diasEntre(desde, hoy) : -1;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <div className="w-max min-w-full">
        <div className="flex border-b border-border bg-muted">
          <div className="sticky left-0 z-10 w-36 shrink-0 border-r border-border bg-muted px-3 py-1.5 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">Unidad</div>
          <div aria-hidden="true" className={cn("grid", grid)}>
            {dias.map((d, i) => (
              <div key={d} className={cn("py-1.5 text-center text-2xs", i === indiceHoy ? "font-bold text-primary" : "text-muted-foreground")}>
                {Number(d.slice(8, 10))}
              </div>
            ))}
          </div>
        </div>
        {unidades.map((u) => {
          const { segmentos, carriles } = segmentosDeUnidad(
            elementos.filter((e) => e.unidadId === u.id),
            desde,
            hasta,
          );
          return (
            <div key={u.id} role="group" aria-label={u.nombre} className="flex border-b border-border last:border-b-0">
              <div className="sticky left-0 z-10 w-36 shrink-0 border-r border-border bg-card px-3 py-2 text-sm font-medium text-foreground">
                <span className="line-clamp-2">{u.nombre}</span>
              </div>
              <div className="relative">
                <div aria-hidden="true" className={cn("absolute inset-0 grid", grid)}>
                  {dias.map((d, i) => (
                    <div key={d} className={cn("border-r border-border/60", i === indiceHoy && "bg-primary/10")} />
                  ))}
                </div>
                <div className={cn("relative grid auto-rows-[1.75rem] gap-y-1 py-1.5", grid)}>
                  {segmentos.slice(0, 200).map((s) => (
                    <button
                      key={s.elemento.id}
                      type="button"
                      aria-label={`${u.nombre}: ${s.elemento.descripcion}, ${etiquetaRango(s.elemento.inicio, s.elemento.fin)}${s.elemento.enConflicto ? ", con conflicto" : ""}`}
                      aria-pressed={seleccionadoId === s.elemento.id}
                      onClick={() => onSeleccionar(s.elemento)}
                      className={cn(
                        "flex min-w-0 items-center gap-1 px-1.5 text-2xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        CLASE_TONO[tonoDeElemento(s.elemento, canales)],
                        claseBorde(s.elemento),
                        COL_INICIO[s.columna],
                        COL_SPAN[s.span],
                        FILA_CARRIL[Math.min(s.carril, FILA_CARRIL.length - 1)],
                        s.continuaAntes ? "rounded-l-none border-l-0" : "rounded-l-md",
                        s.continuaDespues ? "rounded-r-none border-r-0" : "rounded-r-md",
                        s.elemento.apagado && "opacity-60",
                        seleccionadoId === s.elemento.id && "ring-2 ring-ring",
                      )}
                    >
                      <IconoElemento e={s.elemento} />
                      <span className="truncate">{s.elemento.etiqueta}</span>
                    </button>
                  ))}
                  {carriles > FILA_CARRIL.length && <span className="sr-only">Hay más elementos solapados de los que caben en pantalla; usa la vista de mes.</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Agenda (móvil)
// ---------------------------------------------------------------------------------------------------------------------

export interface VistaAgendaProps {
  readonly mes: ClaveMes;
  readonly hoy: FechaLocal;
  readonly elementos: readonly ElementoCalendario[];
  readonly canales: readonly string[];
  readonly nombreUnidad: (id: string) => string;
  readonly onSeleccionar: (e: ElementoCalendario) => void;
}

export function VistaAgenda({ mes, hoy, elementos, canales, nombreUnidad, onSeleccionar }: VistaAgendaProps) {
  const agenda = agendaDelMes(elementos, mes);
  const primero = diasDelMes(mes)[0]!;
  if (agenda.length === 0) return <EstadoVacio icon={CalendarDays} titulo="Sin actividad este mes" mensaje="No hay reservas, bloqueos ni limpiezas con los filtros elegidos." compacto />;
  return (
    <ol aria-label={`Agenda de ${etiquetaMes(mes)}`} className="m-0 flex list-none flex-col gap-3 p-0">
      {agenda.map((d) => (
        <li key={d.fecha}>
          <h3 className={cn("m-0 mb-1.5 text-sm font-semibold", d.fecha === hoy ? "text-primary" : "text-foreground")}>
            {etiquetaDiaLarga(d.fecha)}
            {d.fecha === hoy && <span className="ml-2 text-xs font-medium">(hoy)</span>}
          </h3>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {d.elementos.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSeleccionar(e)}
                  className={cn("flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", CLASE_TONO[tonoDeElemento(e, canales)], claseBorde(e), e.apagado && "opacity-60")}
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    <IconoElemento e={e} />
                    {e.etiqueta}
                    {e.enConflicto && <span className="text-xs font-medium">· conflicto</span>}
                  </span>
                  <span className="text-xs">
                    {nombreUnidad(e.unidadId)} · {e.descripcion}
                  </span>
                  <span className="text-xs">
                    {e.inicio < primero ? "Desde antes del mes · " : ""}
                    {e.tipo === "limpieza" ? "Programada" : etiquetaRango(e.inicio, e.fin)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------------------------------------------------

export interface DetalleProps {
  readonly titulo: string;
  readonly noches: readonly ElementoCalendario[];
  readonly salidas: readonly ElementoCalendario[];
  readonly canales: readonly string[];
  readonly nombreUnidad: (id: string) => string;
  readonly monitorHref: string;
  readonly onGestionar: (unidadId: string) => void;
  readonly puedeGestionar: boolean;
}

function FilaDetalle({ e, canales, nombreUnidad, monitorHref, onGestionar, puedeGestionar }: { readonly e: ElementoCalendario } & Omit<DetalleProps, "titulo" | "noches" | "salidas">) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-sm font-semibold text-foreground">{e.etiqueta}</p>
        <StatusBadge tone={tonoDeElemento(e, canales)}>{e.enConflicto ? "Conflicto abierto" : e.tipo === "reserva" ? etiquetaCanal(e.canal) : e.tipo === "bloqueo" ? "Bloqueo" : "Limpieza"}</StatusBadge>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        {nombreUnidad(e.unidadId)} · {e.descripcion}
        {e.tipo !== "limpieza" ? ` · ${etiquetaRango(e.inicio, e.fin)}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {e.enConflicto && (
          <a href={monitorHref} className="text-xs font-medium text-primary underline underline-offset-2">
            Revisar en el Monitor de conflictos
          </a>
        )}
        {puedeGestionar && e.tipo !== "limpieza" && (
          <button type="button" onClick={() => onGestionar(e.unidadId)} className="text-xs font-medium text-primary underline underline-offset-2">
            Gestionar en la lista de esta unidad
          </button>
        )}
      </div>
    </li>
  );
}

export function PanelDetalle(props: DetalleProps) {
  const { titulo, noches, salidas } = props;
  return (
    <section aria-live="polite" aria-label="Detalle" className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <h3 className="m-0 text-sm font-semibold text-foreground">{titulo}</h3>
      {noches.length === 0 && salidas.length === 0 && <p className="m-0 text-sm text-muted-foreground">Sin reservas, bloqueos ni limpiezas con los filtros elegidos.</p>}
      {noches.length > 0 && (
        <>
          <p className="m-0 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">Ocupan la noche</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {noches.map((e) => (
              <FilaDetalle key={e.id} e={e} {...props} />
            ))}
          </ul>
        </>
      )}
      {salidas.length > 0 && (
        <>
          <p className="m-0 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">Salen este día (check-out)</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {salidas.map((e) => (
              <FilaDetalle key={`s-${e.id}`} e={e} {...props} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}


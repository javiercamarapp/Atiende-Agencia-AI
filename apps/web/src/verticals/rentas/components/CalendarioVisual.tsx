// Rn-06 -- calendario visual de rentas: vista mes, línea de tiempo por unidad y agenda móvil, con capas (reservas por canal,
// bloqueos, limpiezas y conflictos de Rn-02), filtros por unidad y canal, navegación por mes y "Hoy".
//
// Datos (solo lectura, sin SQL nuevo): una lectura por ventana de las ocupaciones de TODA la property (`GET .../calendario`),
// más dos capas opcionales que se piden en paralelo y que, si fallan o el rol no las incluye, dejan el calendario funcionando
// con un aviso honesto: tareas de limpieza (`GET .../tareas?desde&hasta`) y conflictos abiertos (`GET .../conflictos`).
//
// "Hoy" y el mes inicial salen de la zona IANA de la property (la que devuelve el servidor), nunca de la zona del navegador.
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Callout, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Label, NativeSelect } from "@atiende/ui";
import { fetchCalendarioVentana, fetchUnidades } from "../lib/calendario-client.ts";
import type { UnidadOption, VentanaCalendario } from "../lib/calendario-client.ts";
import {
  CAPAS_POR_DEFECTO,
  canalesPresentes,
  claveMesDe,
  construirElementos,
  contenidoPorDia,
  esClaveMesValida,
  etiquetaCanal,
  etiquetaDiaLarga,
  etiquetaMes,
  filtrarElementos,
  hoyEnZona,
  moverMes,
  sumarDias,
  ventanaDeRejilla,
} from "../lib/calendario-visual.ts";
import type { CapasVisibles, ClaveMes, ElementoCalendario, FechaLocal } from "../lib/calendario-visual.ts";
import { fetchConflictos } from "../lib/ical-monitor-client.ts";
import type { ConflictoCalendario } from "../lib/ical-monitor-client.ts";
import { fetchTareas } from "../lib/limpieza-client.ts";
import type { TareaOperativa } from "../lib/limpieza-client.ts";
import { Leyenda, PanelDetalle, VistaAgenda, VistaLinea, VistaMes } from "./calendario-vistas.tsx";

export interface CalendarioVisualProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Lleva a la lista de gestión (crear/modificar/cancelar) con la unidad indicada ya elegida. */
  readonly onGestionar: (unidadId: string) => void;
}

type Vista = "mes" | "linea";

/** Estado de una capa opcional: `null` mientras carga; `{ error }` si no se pudo leer (rol sin acceso, red, base sin migrar...). */
type CapaOpcional<T> = { readonly estado: "cargando" } | { readonly estado: "ok"; readonly datos: T } | { readonly estado: "no-disponible"; readonly motivo: string };

function mensajeDe(err: unknown, porDefecto: string): string {
  return err instanceof Error && err.message ? err.message : porDefecto;
}

export function CalendarioVisual({ apiBaseUrl, token, propertyId, orgSlug, onGestionar }: CalendarioVisualProps) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [datos, setDatos] = useState<VentanaCalendario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tareas, setTareas] = useState<CapaOpcional<readonly TareaOperativa[]>>({ estado: "cargando" });
  const [conflictos, setConflictos] = useState<CapaOpcional<readonly ConflictoCalendario[]>>({ estado: "cargando" });
  const [reintento, setReintento] = useState(0);

  // `null` = "el mes actual de la property": se resuelve con su zona horaria en cuanto llega la primera respuesta.
  const [mesElegido, setMesElegido] = useState<ClaveMes | null>(null);
  const [vista, setVista] = useState<Vista>("mes");
  const [unidadFiltro, setUnidadFiltro] = useState<string | null>(null);
  const [canalFiltro, setCanalFiltro] = useState<string | null>(null);
  const [capas, setCapas] = useState<CapasVisibles>(CAPAS_POR_DEFECTO);
  const [foco, setFoco] = useState<FechaLocal | null>(null);
  const [focoPorTeclado, setFocoPorTeclado] = useState(false);
  const [diaSeleccionado, setDiaSeleccionado] = useState<FechaLocal | null>(null);
  const [elementoSeleccionado, setElementoSeleccionado] = useState<ElementoCalendario | null>(null);

  // La zona de la property se recuerda aparte de `datos` (que se vacía al cambiar de mes): si se derivara de `datos`, el
  // mes "actual" parpadearía entre la zona por defecto y la real alrededor del cambio de mes.
  const [zona, setZona] = useState<string | null>(null);
  const hoy = hoyEnZona(zona);
  const mes: ClaveMes = mesElegido && esClaveMesValida(mesElegido) ? mesElegido : claveMesDe(hoy);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const lista = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (!cancelado) setUnidades(lista);
      } catch (err) {
        if (!cancelado) setError(mensajeDe(err, "No se pudieron cargar las unidades de esta propiedad."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, reintento]);

  useEffect(() => {
    let cancelado = false;
    const { inicio, fin } = ventanaDeRejilla(mes);
    setDatos(null);
    setError(null);
    setTareas({ estado: "cargando" });
    setConflictos({ estado: "cargando" });
    fetchCalendarioVentana(fetch, apiBaseUrl, token, propertyId, { inicio, fin }).then(
      (v) => {
        if (cancelado) return;
        setDatos(v);
        setZona(v.zonaHoraria);
      },
      (err: unknown) => {
        if (!cancelado) setError(mensajeDe(err, "No se pudo cargar el calendario."));
      },
    );
    fetchTareas(fetch, apiBaseUrl, token, propertyId, { desde: inicio, hasta: sumarDias(fin, -1) }).then(
      (lista) => {
        if (!cancelado) setTareas({ estado: "ok", datos: lista });
      },
      (err: unknown) => {
        if (!cancelado) setTareas({ estado: "no-disponible", motivo: mensajeDe(err, "No se pudieron leer las limpiezas.") });
      },
    );
    fetchConflictos(fetch, apiBaseUrl, token, propertyId, "abiertos").then(
      (r) => {
        if (!cancelado) setConflictos({ estado: "ok", datos: r.conflictos });
      },
      (err: unknown) => {
        if (!cancelado) setConflictos({ estado: "no-disponible", motivo: mensajeDe(err, "No se pudieron leer los conflictos.") });
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, mes, reintento]);

  const todos = useMemo(
    () =>
      construirElementos({
        ocupaciones: datos?.ocupaciones ?? [],
        tareas: tareas.estado === "ok" ? tareas.datos : [],
        conflictos: conflictos.estado === "ok" ? conflictos.datos : [],
      }),
    [datos, tareas, conflictos],
  );
  const canales = useMemo(() => canalesPresentes(todos), [todos]);
  const visibles = useMemo(() => filtrarElementos(todos, { unidadId: unidadFiltro, canal: canalFiltro, capas }), [todos, unidadFiltro, canalFiltro, capas]);
  const unidadesVisibles = useMemo(() => (unidadFiltro ? (unidades ?? []).filter((u) => u.id === unidadFiltro) : (unidades ?? [])), [unidades, unidadFiltro]);
  const nombreUnidad = (id: string) => unidades?.find((u) => u.id === id)?.nombre ?? "Unidad";

  const focoEfectivo = foco ?? (claveMesDe(hoy) === mes ? hoy : `${mes}-01`);

  function irAMes(destino: ClaveMes) {
    setMesElegido(destino);
    setDiaSeleccionado(null);
    setElementoSeleccionado(null);
    setFoco(null);
    setFocoPorTeclado(false);
  }

  function seleccionarDia(dia: FechaLocal) {
    setElementoSeleccionado(null);
    setDiaSeleccionado(dia);
    setFoco(dia);
  }

  function alCambiarCapa(clave: keyof CapasVisibles, valor: boolean) {
    setCapas((c) => ({ ...c, [clave]: valor }));
  }

  const detalleDia = useMemo(() => {
    if (!diaSeleccionado) return null;
    const c = contenidoPorDia(visibles, [diaSeleccionado]).get(diaSeleccionado);
    return { noches: c?.noches ?? [], salidas: c?.salidas ?? [] };
  }, [diaSeleccionado, visibles]);

  const cargando = !datos && !error;
  const sinUnidades = unidades !== null && unidades.length === 0;
  const conflictosAbiertos = conflictos.estado === "ok" ? conflictos.datos.length : 0;
  const monitorHref = `/rentas/${orgSlug}/monitor-sync`;
  const avisos: string[] = [];
  if (tareas.estado === "no-disponible") avisos.push(`La capa de limpiezas no está disponible: ${tareas.motivo}`);
  if (conflictos.estado === "no-disponible") avisos.push(`La capa de conflictos no está disponible: ${conflictos.motivo}`);

  return (
    <div className="flex flex-col gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" aria-label="Mes anterior" onClick={() => irAMes(moverMes(mes, -1))}>
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </Button>
          <Button type="button" variant="outline" size="sm" aria-label="Mes siguiente" onClick={() => irAMes(moverMes(mes, 1))}>
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              irAMes(claveMesDe(hoyEnZona(zona)));
              setFoco(hoyEnZona(zona));
            }}
          >
            Hoy
          </Button>
          <h2 aria-live="polite" className="m-0 ml-1 font-display text-lg font-semibold text-foreground">
            {etiquetaMes(mes).replace(/^./, (c) => c.toUpperCase())}
          </h2>
        </div>
        <div role="group" aria-label="Tipo de vista" className="hidden gap-1.5 md:flex">
          <Button type="button" size="sm" variant={vista === "mes" ? "default" : "outline"} aria-pressed={vista === "mes"} onClick={() => setVista("mes")}>
            Mes
          </Button>
          <Button type="button" size="sm" variant={vista === "linea" ? "default" : "outline"} aria-pressed={vista === "linea"} onClick={() => setVista("linea")}>
            Línea de tiempo
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <Label className="flex min-w-40 flex-col gap-1.5 text-sm text-foreground">
          Unidad
          <NativeSelect value={unidadFiltro ?? ""} onChange={(e) => setUnidadFiltro(e.target.value || null)} disabled={!unidades}>
            <option value="">Todas las unidades</option>
            {unidades?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.nombre}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="flex min-w-40 flex-col gap-1.5 text-sm text-foreground">
          Canal de las reservas
          <NativeSelect value={canalFiltro ?? ""} onChange={(e) => setCanalFiltro(e.target.value || null)}>
            <option value="">Todos los canales</option>
            {canales.map((c) => (
              <option key={c} value={c}>
                {etiquetaCanal(c)}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 border-0 p-0">
          <legend className="mb-1 p-0 text-sm text-foreground">Capas</legend>
          <Checkbox label="Reservas" checked={capas.reservas} onChange={(e) => alCambiarCapa("reservas", e.target.checked)} />
          <Checkbox label="Bloqueos" checked={capas.bloqueos} onChange={(e) => alCambiarCapa("bloqueos", e.target.checked)} />
          <Checkbox label="Limpiezas" checked={capas.limpiezas} disabled={tareas.estado === "no-disponible"} onChange={(e) => alCambiarCapa("limpiezas", e.target.checked)} />
          <Checkbox label="Conflictos" checked={capas.conflictos} disabled={conflictos.estado === "no-disponible"} onChange={(e) => alCambiarCapa("conflictos", e.target.checked)} />
        </fieldset>
      </div>

      <Leyenda canales={canales} />

      {conflictosAbiertos > 0 && capas.conflictos && (
        <Callout
          tone="danger"
          titulo={`${conflictosAbiertos} ${conflictosAbiertos === 1 ? "conflicto abierto" : "conflictos abiertos"} de calendario`}
          accion={
            <a href={monitorHref} className="text-sm font-medium text-primary underline underline-offset-2">
              Abrir el Monitor de conflictos
            </a>
          }
        >
          Las reservas involucradas se marcan con el icono de alerta y borde grueso.
        </Callout>
      )}
      {avisos.map((a) => (
        <Callout key={a} tone="neutral">
          {a}
        </Callout>
      ))}
      {datos?.truncado && (
        <Callout tone="warning" titulo="Hay más reservas de las que se pueden mostrar">
          Este periodo tiene {datos.total} ocupaciones y se muestran las primeras {datos.ocupaciones.length}. Filtra por unidad para ver el resto.
        </Callout>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => setReintento((n) => n + 1)} />}
      {cargando && <EstadoCargando lineas={1} etiqueta="Cargando el calendario…" />}
      {sinUnidades && !error && <EstadoVacio icon={CalendarDays} titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />}

      {/* La rejilla se queda montada mientras llega el mes nuevo (vacía, sin datos viejos): así el foco del teclado no se pierde
          al cambiar de mes con RePág/AvPág o con la flecha que sale de la rejilla. */}
      {!error && !sinUnidades && (
        <>
          <div className="hidden md:block">
            {vista === "mes" ? (
              <VistaMes
                mes={mes}
                hoy={hoy}
                elementos={visibles}
                canales={canales}
                nombreUnidad={nombreUnidad}
                foco={focoEfectivo}
                diaSeleccionado={diaSeleccionado}
                moverFocoDom={focoPorTeclado}
                onFoco={(dia, teclado) => {
                  setFoco(dia);
                  setFocoPorTeclado(teclado);
                }}
                onSeleccionarDia={seleccionarDia}
                onCambiarMes={(m) => {
                  setMesElegido(m);
                  setDiaSeleccionado(null);
                  setElementoSeleccionado(null);
                }}
              />
            ) : (
              <VistaLinea
                mes={mes}
                hoy={hoy}
                unidades={unidadesVisibles}
                elementos={visibles}
                canales={canales}
                seleccionadoId={elementoSeleccionado?.id ?? null}
                onSeleccionar={(e) => {
                  setDiaSeleccionado(null);
                  setElementoSeleccionado(e);
                }}
              />
            )}
          </div>
          <div className="md:hidden">
            <VistaAgenda
              mes={mes}
              hoy={hoy}
              elementos={visibles}
              canales={canales}
              nombreUnidad={nombreUnidad}
              onSeleccionar={(e) => {
                setDiaSeleccionado(null);
                setElementoSeleccionado(e);
              }}
            />
          </div>

          {detalleDia && (
            <PanelDetalle titulo={etiquetaDiaLarga(diaSeleccionado!)} noches={detalleDia.noches} salidas={detalleDia.salidas} canales={canales} nombreUnidad={nombreUnidad} monitorHref={monitorHref} onGestionar={onGestionar} puedeGestionar />
          )}
          {elementoSeleccionado && !detalleDia && (
            <PanelDetalle titulo={elementoSeleccionado.etiqueta} noches={[elementoSeleccionado]} salidas={[]} canales={canales} nombreUnidad={nombreUnidad} monitorHref={monitorHref} onGestionar={onGestionar} puedeGestionar />
          )}
        </>
      )}
    </div>
  );
}

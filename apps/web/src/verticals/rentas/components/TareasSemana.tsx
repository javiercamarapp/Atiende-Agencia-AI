// Tablero de turnos "Próximos 7 días" (paridad3 rentas): TODA la limpieza del equipo agrupada por día y por persona, para que la
// gestión vea quién tiene qué y qué sigue sin responsable. Contrapartida del TableroTurnos del repo suelto: a diferencia de "Mis
// tareas" (solo lo mío), pide `GET .../tareas?desde&hasta` SIN filtro de asignación y los nombres a `GET .../tareas/asignables`.
//
// Solo gestión (admin_gestora y operadores): el rol `limpieza` ni lo monta MisTareas ni el servidor le devuelve tareas ajenas.
// Estados honestos: cargando, error con reintento, semana vacía, y -- si la base aún no tiene la migración 033 -- las personas se
// muestran sin nombre con un aviso (no hay lista de personas que consultar; nada se inventa).
// Marca "Proveedor externo" (`esProveedorExterno`, que hasta hoy nadie pintaba) y "SLA vencido".
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, StatusBadge, statusTone } from "@atiende/ui";
import { hoyFechaSolo, parseFechaSolo, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import { ESTADO_TAREA_LABELS, fetchAsignables, fetchTareas, TIPO_TAREA_LABELS } from "../lib/limpieza-client.ts";
import type { AsignableLimpieza, TareaOperativa } from "../lib/limpieza-client.ts";
import { ESTADO_TAREA_TONES } from "../lib/status-tones.ts";

const DIAS_VISTA = 7;
const ESTADOS_VISIBLES = ["pendiente", "asignada", "en_progreso", "bloqueada", "completada"] as const;
const SIN_ASIGNAR = "__sin_asignar__";

const FORMATO_DIA = new Intl.DateTimeFormat("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function etiquetaDia(fecha: string): string {
  return FORMATO_DIA.format(parseFechaSolo(fecha));
}

function slaVencido(t: TareaOperativa): boolean {
  return t.slaVenceEn !== null && new Date(t.slaVenceEn).getTime() < Date.now() && t.estado !== "completada" && t.estado !== "cancelada";
}

export interface TareasSemanaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Cambia cuando otra parte de la pantalla reparte o crea una tarea: vuelve a pedir la semana. */
  readonly recarga?: number;
}

interface GrupoPersona {
  readonly clave: string;
  readonly nombre: string;
  readonly tareas: readonly TareaOperativa[];
}

export function TareasSemana({ apiBaseUrl, token, propertyId, recarga = 0 }: TareasSemanaProps) {
  const [inicio, setInicio] = useState(() => hoyFechaSolo());
  const [tareas, setTareas] = useState<readonly TareaOperativa[] | null>(null);
  const [personas, setPersonas] = useState<readonly AsignableLimpieza[]>([]);
  const [nombresDisponibles, setNombresDisponibles] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);

  const fin = sumarDiasFechaSolo(inicio, DIAS_VISTA - 1);

  useEffect(() => {
    let cancelado = false;
    setTareas(null);
    setError(null);
    Promise.all([
      fetchTareas(fetch, apiBaseUrl, token, propertyId, { desde: inicio, hasta: fin, estados: ESTADOS_VISIBLES }),
      // Los nombres son un complemento: si faltan (base sin migrar, 403 de un rol sin acceso) el tablero sigue sirviendo sin ellos.
      fetchAsignables(fetch, apiBaseUrl, token, propertyId).catch(() => ({ asignables: [] as readonly AsignableLimpieza[], disponible: false })),
    ]).then(
      ([lista, asignables]) => {
        if (cancelado) return;
        setTareas(lista);
        setPersonas(asignables.asignables);
        setNombresDisponibles(asignables.disponible);
      },
      (err: unknown) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el tablero de turnos.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, inicio, fin, recarga, reintento]);

  const dias = useMemo(() => Array.from({ length: DIAS_VISTA }, (_, i) => sumarDiasFechaSolo(inicio, i)), [inicio]);
  const nombrePorId = useMemo(() => new Map(personas.map((p) => [p.id, p.nombre])), [personas]);

  const porDia = useMemo(() => {
    const mapa = new Map<string, TareaOperativa[]>();
    for (const t of tareas ?? []) mapa.set(t.programadaPara, [...(mapa.get(t.programadaPara) ?? []), t]);
    return mapa;
  }, [tareas]);

  const gruposDe = useCallback(
    (delDia: readonly TareaOperativa[]): GrupoPersona[] => {
      const grupos = new Map<string, TareaOperativa[]>();
      for (const t of delDia) {
        const clave = t.asignadoA ?? SIN_ASIGNAR;
        grupos.set(clave, [...(grupos.get(clave) ?? []), t]);
      }
      return [...grupos.entries()]
        .map(([clave, lista]) => ({
          clave,
          nombre: clave === SIN_ASIGNAR ? "Sin asignar" : (nombrePorId.get(clave) ?? "Persona asignada"),
          tareas: lista,
        }))
        // "Sin asignar" primero: es lo que la gestión tiene que repartir; después por nombre.
        .sort((a, b) => (a.clave === SIN_ASIGNAR ? -1 : b.clave === SIN_ASIGNAR ? 1 : a.nombre.localeCompare(b.nombre, "es")));
    },
    [nombrePorId],
  );

  const total = tareas?.length ?? 0;
  const sinResponsable = (tareas ?? []).filter((t) => t.asignadoA === null).length;

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <CalendarDays className="h-4 w-4" strokeWidth={1.75} /> Próximos 7 días
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {etiquetaDia(inicio)} – {etiquetaDia(fin)}
            </span>
            <Button type="button" variant="outline" size="sm" aria-label="Semana anterior" onClick={() => setInicio((d) => sumarDiasFechaSolo(d, -DIAS_VISTA))}>
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setInicio(hoyFechaSolo())}>
              Hoy
            </Button>
            <Button type="button" variant="outline" size="sm" aria-label="Semana siguiente" onClick={() => setInicio((d) => sumarDiasFechaSolo(d, DIAS_VISTA))}>
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        </div>
        {tareas !== null && (
          <p className="m-0 text-xs text-muted-foreground">
            {total === 0 ? "Sin turnos en estos 7 días." : `${total} ${total === 1 ? "tarea" : "tareas"}${sinResponsable > 0 ? ` · ${sinResponsable} sin responsable` : ""}.`}
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-4 pt-0">
        {error && <EstadoError mensaje={error} onReintentar={() => setReintento((n) => n + 1)} />}
        {!error && tareas === null && <EstadoCargando etiqueta="Cargando turnos…" lineas={3} />}
        {!error && tareas !== null && !nombresDisponibles && (
          <p className="m-0 rounded-lg border border-dashed border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            No disponible aún: los nombres del equipo requieren la migración 033 de rentas. Se muestran las tareas sin el nombre de la persona.
          </p>
        )}
        {!error && tareas !== null && total === 0 && <EstadoVacio icon={CalendarDays} titulo="Semana libre" mensaje="No hay tareas programadas en estos 7 días." />}
        {!error &&
          tareas !== null &&
          total > 0 &&
          dias.map((dia) => {
            const delDia = porDia.get(dia) ?? [];
            return (
              <section key={dia} aria-label={etiquetaDia(dia)} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="m-0 text-sm font-semibold capitalize text-foreground">{etiquetaDia(dia)}</h3>
                  <span className="text-xs text-muted-foreground">{delDia.length === 0 ? "Sin turnos" : `${delDia.length} ${delDia.length === 1 ? "tarea" : "tareas"}`}</span>
                </div>
                {gruposDe(delDia).map((g) => (
                  <div key={g.clave} className="flex flex-col gap-1">
                    <p className={g.clave === SIN_ASIGNAR ? "m-0 text-xs font-medium text-destructive" : "m-0 text-xs font-medium text-muted-foreground"}>{g.nombre}</p>
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {g.tareas.map((t) => (
                        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1 text-sm text-foreground">
                          <span>
                            <strong>{t.unidadNombre}</strong> · {TIPO_TAREA_LABELS[t.tipo]}
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {t.esProveedorExterno && <StatusBadge tone="info">Proveedor externo</StatusBadge>}
                            {slaVencido(t) ? <StatusBadge tone="danger">SLA vencido</StatusBadge> : <StatusBadge tone={statusTone(ESTADO_TAREA_TONES, t.estado)}>{ESTADO_TAREA_LABELS[t.estado]}</StatusBadge>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
      </CardContent>
    </Card>
  );
}

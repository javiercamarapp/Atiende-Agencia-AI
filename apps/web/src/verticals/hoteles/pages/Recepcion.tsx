// Recepcion / front desk (H-28) -- llegadas, salidas y en casa del dia, rack de habitaciones con el estado de limpieza,
// check-in y check-out de un clic y cambio de habitacion. Consume apps/api/.../hoteles/recepcion.ts. Los botones se
// muestran segun el rol de la sesion (cosmetico: el servidor es la unica barrera real, 403). Todo dato sale del servidor;
// el documento del huesped nunca viaja aqui, solo si ya hay una identidad registrada (la captura vive en Identidad).
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BedDouble, CalendarClock, LogIn, LogOut, RefreshCw, Repeat } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Tabs, TabsContent, TabsList, TabsTrigger } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { statusTone } from "@atiende/ui";
import {
  HABITACION_ESTADO_LABELS,
  RECEPCION_OPERATE_ROLES,
  RECEPCION_VIEW_ROLES,
  RESERVA_ESTADO_LABELS,
  cambiarHabitacion,
  checkIn,
  checkOut,
  fetchRecepcion,
  habitacionesCandidatas,
} from "../lib/recepcion-client.ts";
import type { Movimiento, RackHabitacion, Recepcion } from "../lib/recepcion-client.ts";
import { HABITACION_ESTADO_TONES } from "../lib/status-tones.ts";
import { CambiarFechasDialog } from "../components/CambiarFechasDialog.tsx";
import type { ReservaParaFechas } from "../components/CambiarFechasDialog.tsx";
import { FECHAS_ROLES } from "../lib/fechas-client.ts";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import type { HotelesShellContext } from "../HotelesShell.tsx";

const OCUPACION_TONES: Readonly<Record<string, StatusTone>> = { ocupada: "info", llegada: "warning", libre: "success" };
const OCUPACION_LABELS = { ocupada: "Ocupada", llegada: "Llega hoy", libre: "Libre" } as const;

function Resumen({ etiqueta, valor, detalle }: { etiqueta: string; valor: number; detalle?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{etiqueta}</p>
        <p className="text-xl font-display font-semibold text-foreground tabular-nums">{valor}</p>
        {detalle && <p className="text-xs text-muted-foreground">{detalle}</p>}
      </CardContent>
    </Card>
  );
}

export function RecepcionPage({ apiBaseUrl, token, propertyId, orgSlug, role }: HotelesShellContext) {
  const [fecha, setFecha] = useState<string | undefined>(undefined);
  const [data, setData] = useState<Recepcion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"llegadas" | "salidas" | "enCasa" | "rack">("llegadas");
  // Habitacion elegida para cada llegada sin habitacion, y panel de cambio abierto (una reserva a la vez).
  const [eleccion, setEleccion] = useState<Readonly<Record<string, string>>>({});
  const [cambio, setCambio] = useState<{ reservaId: string; roomId: string; motivo: string } | null>(null);
  // H-28: reserva cuyo dialogo "Cambiar fechas" esta abierto (null = cerrado).
  const [fechasDe, setFechasDe] = useState<ReservaParaFechas | null>(null);

  const puedeVer = RECEPCION_VIEW_ROLES.has(role);
  const puedeOperar = RECEPCION_OPERATE_ROLES.has(role);

  const load = useCallback(async () => {
    if (!puedeVer) return;
    setError(null);
    try {
      setData(await fetchRecepcion(fetch, apiBaseUrl, token, propertyId, fecha));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la recepcion.");
    }
  }, [apiBaseUrl, token, propertyId, fecha, puedeVer]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<string | null>) {
    setBusy(key);
    setError(null);
    setAviso(null);
    try {
      const msg = await fn();
      if (msg) setAviso(msg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la accion.");
    } finally {
      setBusy(null);
    }
  }

  if (!puedeVer) {
    return (
      <PageContainer padding="none" className="gap-4">
        <EstadoVacio mensaje="Tu rol no tiene acceso a la recepcion." />
      </PageContainer>
    );
  }

  const nombreHuesped = (m: Movimiento) => m.huesped?.nombre ?? "Huesped sin registrar";
  const esHoy = data !== null && fecha === undefined;

  function filaIdentidad(m: Movimiento) {
    if (m.identidadRegistrada === null || m.identidadRegistrada) return null;
    return (
      <p className="text-xs text-muted-foreground">
        Sin identidad registrada.{" "}
        <Link className="underline underline-offset-4" to={`/hoteles/${orgSlug}/identidad`}>
          Registrar en Identidad
        </Link>
      </p>
    );
  }

  // Funcion (no componente): un componente declarado aqui se remontaria en cada render y perderia el foco de sus selects.
  function fila(m: Movimiento, acciones?: ReactNode) {
    return (
      <Card>
        <CardContent className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground truncate">
              {m.huesped ? (
                <Link className="underline-offset-4 hover:underline" to={`/hoteles/${orgSlug}/huespedes/${m.huesped.id}`}>
                  {nombreHuesped(m)}
                </Link>
              ) : (
                nombreHuesped(m)
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {m.tipoHabitacion?.nombre ?? "Sin tipo"} · {m.habitacion?.codigo ? `Habitacion ${m.habitacion.codigo}` : "Sin habitacion asignada"} · {formatFechaSolo(m.entrada)} → {formatFechaSolo(m.salida)} ({m.noches} noche{m.noches === 1 ? "" : "s"})
            </p>
            {filaIdentidad(m)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={m.salidaVencida ? "danger" : m.estado === "confirmada" ? "warning" : "info"}>{m.salidaVencida ? "Salida vencida" : RESERVA_ESTADO_LABELS[m.estado]}</StatusBadge>
            {acciones}
          </div>
        </CardContent>
      </Card>
    );
  }

  /** "Cambiar fechas" (recotiza y confirma en un dialogo): lo ven los roles que administran reservas, incluido `reservations`. */
  function botonFechas(m: Movimiento) {
    if (!FECHAS_ROLES.has(role)) return null;
    return (
      <Button type="button" size="sm" variant="outline" disabled={busy === m.reservaId} onClick={() => setFechasDe({ id: m.reservaId, entrada: m.entrada, salida: m.salida, estado: m.estado, huesped: m.huesped?.nombre ?? null })}>
        <CalendarClock className="size-3.5" strokeWidth={1.75} />
        Cambiar fechas
      </Button>
    );
  }

  function accionesLlegada(m: Movimiento) {
    if (m.estado !== "confirmada" || !data) return null;
    if (!puedeOperar) return botonFechas(m);
    const sinHab = m.habitacion === null;
    const candidatas = habitacionesCandidatas(data.rack, m.tipoHabitacion?.id ?? null);
    const elegida = eleccion[m.reservaId] ?? "";
    return (
      <>
        {sinHab && (
          <NativeSelect
            size="sm"
            aria-label={`Habitacion para ${nombreHuesped(m)}`}
            value={elegida}
            onChange={(e) => setEleccion((prev) => ({ ...prev, [m.reservaId]: e.target.value }))}
          >
            <option value="">Elegir habitacion…</option>
            {candidatas.map((h) => (
              <option key={h.roomId} value={h.roomId}>
                {h.codigo} · {h.tipoHabitacion}
              </option>
            ))}
          </NativeSelect>
        )}
        <Button
          type="button"
          size="sm"
          disabled={busy === m.reservaId || (sinHab && elegida === "")}
          onClick={() =>
            void run(m.reservaId, async () => {
              const r = await checkIn(fetch, apiBaseUrl, token, propertyId, m.reservaId, sinHab ? elegida : undefined);
              return `Check-in de ${nombreHuesped(m)} en la habitacion ${r.habitacion.codigo}.${r.identidadRegistrada === false ? " Falta registrar su identidad." : ""}`;
            })
          }
        >
          <LogIn className="size-3.5" strokeWidth={1.75} />
          Check-in
        </Button>
        {botonFechas(m)}
      </>
    );
  }

  function accionesEnCasa(m: Movimiento) {
    if (!data) return null;
    if (!puedeOperar) return botonFechas(m);
    return (
      <>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy === m.reservaId}
          onClick={() => setCambio(cambio?.reservaId === m.reservaId ? null : { reservaId: m.reservaId, roomId: "", motivo: "" })}
        >
          <Repeat className="size-3.5" strokeWidth={1.75} />
          Cambiar habitacion
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy === m.reservaId}
          onClick={() =>
            void run(m.reservaId, async () => {
              const r = await checkOut(fetch, apiBaseUrl, token, propertyId, m.reservaId);
              const folios = r.foliosAbiertos > 0 ? ` Quedan ${r.foliosAbiertos} folio(s) abierto(s): cobra y cierra desde el folio.` : "";
              return `Check-out de ${nombreHuesped(m)}.${r.habitacionMarcadaSucia ? " La habitacion quedo sucia para limpieza." : ""}${folios}`;
            })
          }
        >
          <LogOut className="size-3.5" strokeWidth={1.75} />
          Check-out
        </Button>
        {botonFechas(m)}
      </>
    );
  }

  function panelCambio(m: Movimiento) {
    if (!data || cambio?.reservaId !== m.reservaId) return null;
    const candidatas = habitacionesCandidatas(data.rack, m.tipoHabitacion?.id ?? null, m.habitacion?.id ?? null);
    return (
      <Card>
        <CardContent className="p-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <FormField label="Nueva habitacion">
            <NativeSelect size="sm" value={cambio.roomId} onChange={(e) => setCambio({ ...cambio, roomId: e.target.value })}>
              <option value="">Elegir…</option>
              {candidatas.map((h) => (
                <option key={h.roomId} value={h.roomId}>
                  {h.codigo} · {h.tipoHabitacion}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Motivo (opcional)" className="sm:flex-1">
            <Input value={cambio.motivo} maxLength={200} onChange={(e) => setCambio({ ...cambio, motivo: e.target.value })} />
          </FormField>
          <Button
            type="button"
            size="sm"
            loading={busy === m.reservaId}
            disabled={busy === m.reservaId || cambio.roomId === ""}
            onClick={() =>
              void run(m.reservaId, async () => {
                const r = await cambiarHabitacion(fetch, apiBaseUrl, token, propertyId, m.reservaId, cambio.roomId, cambio.motivo.trim() || undefined);
                setCambio(null);
                const nueva = data.rack.find((h) => h.roomId === r.habitacionId)?.codigo ?? "nueva";
                return `${nombreHuesped(m)} cambio a la habitacion ${nueva}.`;
              })
            }
          >
            Confirmar cambio
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCambio(null)}>
            Cancelar
          </Button>
        </CardContent>
      </Card>
    );
  }

  function lista(items: readonly Movimiento[], vacio: string, acciones: (m: Movimiento) => ReactNode, conPanel = false) {
    if (items.length === 0) return <EstadoVacio mensaje={vacio} />;
    return (
      <div className="flex flex-col gap-2">
        {items.map((m) => (
          <div key={m.reservaId} className="flex flex-col gap-2">
            {fila(m, acciones(m))}
            {conPanel && panelCambio(m)}
          </div>
        ))}
      </div>
    );
  }

  function celdaRack(h: RackHabitacion) {
    return (
      <Card key={h.roomId}>
        <CardContent className="p-3 flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                <BedDouble className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                Habitacion {h.codigo}
              </p>
              <p className="text-xs text-muted-foreground">{h.tipoHabitacion}</p>
            </div>
            <StatusBadge tone={statusTone(HABITACION_ESTADO_TONES, h.estado)}>{HABITACION_ESTADO_LABELS[h.estado]}</StatusBadge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={statusTone(OCUPACION_TONES, h.ocupacion)}>{OCUPACION_LABELS[h.ocupacion]}</StatusBadge>
            {h.limpieza && <span className="text-xs text-muted-foreground">Limpieza: {h.limpieza.estado.replace("_", " ")}</span>}
          </div>
          {h.reserva && (
            <p className="text-xs text-foreground">
              {h.reserva.huesped ?? "Huesped sin registrar"} · {formatFechaSolo(h.reserva.entrada)} → {formatFechaSolo(h.reserva.salida)}
            </p>
          )}
          {h.fueraDeServicio && (
            <p className="text-xs text-foreground">
              {h.fueraDeServicio.motivo}
              {h.fueraDeServicio.regresoEstimado ? ` · regreso estimado ${h.fueraDeServicio.regresoEstimado}` : ""}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <PageContainer padding="none" className="gap-4">
      <PageHeader
        titulo="Recepción"
        descripcion="Llegadas, salidas, huéspedes en casa y rack de habitaciones del día."
        acciones={
          <div className="flex items-end gap-2 flex-wrap">
            <FormField label="Fecha">
              <Input type="date" value={data?.fecha ?? fecha ?? ""} onChange={(e) => setFecha(e.target.value || undefined)} />
            </FormField>
            {!esHoy && data && (
              <Button type="button" variant="outline" onClick={() => setFecha(undefined)}>
                Hoy
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => void load()} aria-label="Actualizar">
              <RefreshCw className="size-4" strokeWidth={1.75} />
            </Button>
          </div>
        }
      />

      {error && <EstadoError titulo="Ocurrió un problema" mensaje={error} onReintentar={() => void load()} />}
      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {!data && !error && <EstadoCargando etiqueta="Cargando recepción…" />}

      {data && !data.tareasDisponibles && (
        <Callout tone="info">El estado de limpieza por habitación aún no está activo en esta base de datos: el rack muestra solo el estado de cada habitación.</Callout>
      )}
      {data && !data.identidadDisponible && (
        <Callout tone="info">La bóveda de identidad aún no está activa en esta base de datos: no se puede mostrar si cada huésped ya registró su identidad.</Callout>
      )}

      {data && (
        <>
          <div className="grid gap-2 grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
            <Resumen etiqueta="Llegadas" valor={data.resumen.llegadas} detalle={`${data.resumen.llegadasPendientes} por llegar`} />
            <Resumen etiqueta="Salidas" valor={data.resumen.salidas} detalle={`${data.resumen.salidasPendientes} por salir`} />
            <Resumen etiqueta="En casa" valor={data.resumen.enCasa} />
            <Resumen etiqueta="Libres" valor={data.resumen.habitacionesLibres} />
            <Resumen etiqueta="Sucias" valor={data.resumen.habitacionesSucias} />
            <Resumen etiqueta="Fuera de servicio" valor={data.resumen.habitacionesFueraDeServicio} />
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="llegadas">Llegadas</TabsTrigger>
              <TabsTrigger value="salidas">Salidas</TabsTrigger>
              <TabsTrigger value="enCasa">En casa</TabsTrigger>
              <TabsTrigger value="rack">Rack</TabsTrigger>
            </TabsList>
            <TabsContent value="llegadas" className="mt-3">
              {lista(data.llegadas, "No hay llegadas para esta fecha.", accionesLlegada)}
            </TabsContent>
            <TabsContent value="salidas" className="mt-3">
              {lista(data.salidas, "No hay salidas para esta fecha.", (m) => (m.estado === "check_in" || m.estado === "en_estancia" ? accionesEnCasa(m) : null), true)}
            </TabsContent>
            <TabsContent value="enCasa" className="mt-3">
              {lista(data.enCasa, "No hay huéspedes en casa.", accionesEnCasa, true)}
            </TabsContent>
            <TabsContent value="rack" className="mt-3">
              {data.rack.length === 0 ? (
                <EstadoVacio mensaje="Esta propiedad aún no tiene habitaciones registradas." />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{data.rack.map(celdaRack)}</div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
      <CambiarFechasDialog
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        reserva={fechasDe}
        onClose={() => setFechasDe(null)}
        onDone={(msg) => {
          setAviso(msg);
          void load();
        }}
      />
    </PageContainer>
  );
}

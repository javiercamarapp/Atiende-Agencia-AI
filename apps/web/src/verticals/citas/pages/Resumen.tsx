// Resumen del panel de citas (C-05, paridad con el AdminDashboard del origen): citas de hoy y de
// la semana, pendientes por confirmar, no-shows y clientes nuevos. Solo lectura de conteos reales
// del servidor (GET .../resumen): si la carga falla se muestra el error, nunca un 0 inventado.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck, CalendarDays, CalendarX, Clock, UserPlus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, StatCard } from "@atiende/ui";
import { fetchCitasResumen, formatDiaCorto, formatDiaNegocio } from "../lib/resumen-client.ts";
import type { CitasResumen, EstadoCita } from "../lib/resumen-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const ETIQUETA_ESTADO: Readonly<Record<EstadoCita, string>> = {
  pending: "Pendientes",
  confirmed: "Confirmadas",
  completed: "Completadas",
  no_show: "No asistieron",
  cancelled: "Canceladas",
};
const ORDEN_ESTADOS: readonly EstadoCita[] = ["pending", "confirmed", "completed", "no_show", "cancelled"];

export function ResumenPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [resumen, setResumen] = useState<CitasResumen | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    setResumen(null);
    setError(null);
    fetchCitasResumen(fetch, apiBaseUrl, token, propertyId)
      .then((r) => !cancelado && setResumen(r))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el resumen."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-semibold text-foreground">Resumen</h1>
        {resumen && <p className="text-sm text-muted-foreground">{formatDiaNegocio(resumen.today.date)}</p>}
      </header>

      {error && <EstadoError mensaje={error} />}
      {!resumen && !error && <EstadoCargando etiqueta="Cargando resumen…" />}

      {resumen && (
        <>
          <section aria-label="Indicadores" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard icon={CalendarCheck} label="Citas hoy" value={String(resumen.today.total)} nota={`${resumen.today.byStatus.confirmed} confirmadas`} />
            <StatCard
              icon={CalendarDays}
              label="Citas esta semana"
              value={String(resumen.week.total)}
              nota={`${formatDiaCorto(resumen.week.fromDate)} – ${formatDiaCorto(resumen.week.toDate)}`}
            />
            <StatCard icon={Clock} label="Por confirmar" value={String(resumen.pendingToConfirm)} nota="próximos 30 días" />
            <StatCard icon={CalendarX} label="No asistieron" value={String(resumen.noShowsLast30Days)} nota="últimos 30 días" />
            <StatCard icon={UserPlus} label="Clientes nuevos" value={String(resumen.newCustomersLast30Days)} nota="últimos 30 días" />
          </section>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <DesglosePorEstado titulo="Hoy por estado" byStatus={resumen.today.byStatus} />
            <DesglosePorEstado titulo="Esta semana por estado" byStatus={resumen.week.byStatus} />
          </div>

          <p className="text-sm text-muted-foreground">
            Fechas en la zona horaria del negocio ({resumen.timezone}).{" "}
            <Link to={`/citas/${orgSlug}/agenda`} className="font-semibold text-foreground hover:underline">
              Ir a la agenda
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

function DesglosePorEstado({ titulo, byStatus }: { readonly titulo: string; readonly byStatus: CitasResumen["today"]["byStatus"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-1.5 text-sm">
          {ORDEN_ESTADOS.map((estado) => (
            <div key={estado} className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{ETIQUETA_ESTADO[estado]}</dt>
              <dd className="font-semibold tabular-nums text-foreground">{byStatus[estado]}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// H-42 -- KPI de room-nights directas (reservas del canal directo web vs total de noches reservadas, mes en curso).
// Datos reales de GET /hoteles/:propertyId/revenue/room-nights-directas; sin la migracion 044 muestra un estado honesto.
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError } from "@atiende/ui";
import { fetchRoomNightsDirectas } from "../lib/revenue-client.ts";
import type { RoomNightsDirectasKpi } from "../lib/revenue-client.ts";

export function RoomNightsDirectasCard({ apiBaseUrl, token, propertyId }: { apiBaseUrl: string; token: string; propertyId: string }) {
  const [kpi, setKpi] = useState<RoomNightsDirectasKpi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    setError(null);
    setKpi(null);
    fetchRoomNightsDirectas(fetch, apiBaseUrl, token, propertyId)
      .then((k) => vivo && setKpi(k))
      .catch((err: unknown) => vivo && setError(err instanceof Error ? err.message : "No se pudo cargar el KPI de room-nights directas."));
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId, intento]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Room-nights directas</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <EstadoError titulo="No se pudo cargar" mensaje={error} onReintentar={() => setIntento((n) => n + 1)} />
        ) : kpi === null ? (
          <EstadoCargando etiqueta="Cargando room-nights directas…" />
        ) : !kpi.disponible ? (
          <p className="text-sm text-muted-foreground">No disponible aún: la reserva directa web todavía no está habilitada en esta base.</p>
        ) : kpi.total === 0 ? (
          <p className="text-sm text-muted-foreground">Sin noches reservadas entre {kpi.desde} y {kpi.hasta}.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-2xl font-semibold text-foreground">{((kpi.porcentaje ?? 0) * 100).toFixed(1)}%</p>
            <p className="text-sm text-muted-foreground">
              {kpi.directas} de {kpi.total} noches reservadas entraron por el canal directo web ({kpi.desde} a {kpi.hasta}, hasta exclusivo).
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

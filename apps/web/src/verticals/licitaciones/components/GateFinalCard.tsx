// L-25 -- tarjeta "Gate final" de la sala de guerra: cuenta regresiva al cierre, semaforo por condicion
// (doble aprobacion, checklist, paquete, ZIP contra manifiesto, holgura de 24 h) y enlace a lo que falta.
// Todo viene de GET .../sala-guerra/gate (el servidor recalcula el sha256 del ZIP guardado); aqui no se
// inventa ningun dato: si la lectura falla se dice, con reintento. NO presenta nada ante ningun portal.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, StatusBadge, statusTone } from "@atiende/ui";
import { fetchGateSalaGuerra, formatCuentaRegresiva } from "../lib/sala-guerra-client.ts";
import type { GateCondition, GateLink, GateSalaGuerraResponse } from "../lib/sala-guerra-client.ts";
import { RESULTADO_CUMPLIMIENTO_TONES } from "../lib/status-tones.ts";

const COLOR_TEXT = { verde: "Verde", ambar: "Ámbar", rojo: "Rojo" } as const;

const LINK_TEXT: Readonly<Record<Exclude<GateLink, null>, string>> = {
  aprobaciones: "Ir a las aprobaciones",
  checklist: "Correr el checklist",
  paquete: "Ensamblar el paquete",
  sala_tablero: "Revisar la fecha de cierre",
};

export interface GateFinalCardProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly tenderId: string;
  readonly orgSlug: string;
  /** Cambia cuando el tablero se recarga: el gate se vuelve a pedir al servidor. */
  readonly refreshKey?: string;
}

function destino(link: Exclude<GateLink, null>, orgSlug: string, tenderId: string): string {
  const base = `/licitaciones/${orgSlug}/convocatorias/${tenderId}`;
  return link === "sala_tablero" ? base : `${base}/cierre`;
}

export function GateFinalCard({ apiBaseUrl, token, propertyId, tenderId, orgSlug, refreshKey }: GateFinalCardProps) {
  const [data, setData] = useState<GateSalaGuerraResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetchedAt = useRef(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchGateSalaGuerra(fetch, apiBaseUrl, token, propertyId, tenderId);
      fetchedAt.current = Date.now();
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el gate final.");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token, propertyId, tenderId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // La cuenta regresiva avanza sola cada 30 s a partir del instante del SERVIDOR (no del reloj del navegador).
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !data) return <EstadoCargando etiqueta="Calculando el gate final…" />;
  if (error && !data) return <EstadoError mensaje={error} onReintentar={() => void load()} />;
  if (!data) return null;

  const { gate } = data;
  const cuenta = gate.cuentaRegresiva;
  void tick;
  const restante = cuenta.msRestantes === null ? null : cuenta.msRestantes - (Date.now() - fetchedAt.current);

  return (
    <Card data-testid="gate-final">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Gate final</CardTitle>
          <StatusBadge tone={gate.listo ? "success" : "danger"}>{gate.listo ? "Listo para presentar" : "No listo"}</StatusBadge>
        </div>
        <CardDescription>
          Anti-desechamiento: checklist, paquete, ZIP contra manifiesto y doble aprobación. Atiende no envía nada a ComprasMX ni a ningún portal: lo presenta una persona por el canal oficial.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="gate-cuenta">
          {cuenta.estado === "sin_fecha" || restante === null ? (
            <span className="text-sm text-muted-foreground">La convocatoria no declara fecha de cierre: no hay cuenta regresiva.</span>
          ) : restante < 0 ? (
            <>
              <span className="font-display text-lg font-semibold text-destructive">Plazo vencido hace {formatCuentaRegresiva(restante)}</span>
              <span className="text-xs text-muted-foreground">
                Cierre: {cuenta.fechaCierreLocal} {cuenta.horaCierreLocal} ({cuenta.zonaHoraria})
              </span>
            </>
          ) : (
            <>
              <span className="font-display text-lg font-semibold text-foreground tabular-nums">Cierra en {formatCuentaRegresiva(restante)}</span>
              <span className="text-xs text-muted-foreground">
                Cierre: {cuenta.fechaCierreLocal} {cuenta.horaCierreLocal} ({cuenta.zonaHoraria})
              </span>
              {restante < 24 * 3_600_000 && <StatusBadge tone="warning">Menos de 24 h de holgura</StatusBadge>}
            </>
          )}
          {data.presentado && <StatusBadge tone="info">Presentación ya declarada</StatusBadge>}
        </div>

        {!gate.listo && gate.alerta24h && (
          <p role="alert" className="text-sm text-destructive">
            A menos de 24 horas del cierre el paquete no está listo. Resuelve lo que aparece en rojo.
          </p>
        )}

        <ul className="flex flex-col gap-2" aria-label="Condiciones del gate final">
          {gate.condiciones.map((c: GateCondition) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-xl border border-border p-3 text-sm" data-testid={`gate-${c.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={statusTone(RESULTADO_CUMPLIMIENTO_TONES, c.color)}>{COLOR_TEXT[c.color]}</StatusBadge>
                <span className="font-semibold text-foreground">{c.label}</span>
              </div>
              <p className="text-xs text-muted-foreground">{c.motivo}</p>
              {c.enlace && c.color !== "verde" && (
                <Link to={destino(c.enlace, orgSlug, tenderId)} className="inline-flex w-fit text-xs font-semibold text-foreground underline">
                  {LINK_TEXT[c.enlace]}
                </Link>
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
            {loading ? "Recalculando…" : "Recalcular gate"}
          </Button>
          {error && (
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

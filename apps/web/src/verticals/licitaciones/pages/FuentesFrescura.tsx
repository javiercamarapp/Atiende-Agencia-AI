// Fuentes y frescura (L-03) -- vista de solo lectura del estado real de cada
// conector de descubrimiento (CompraNet/ComprasMX, OCDS estatales, CSV
// historico, agregador, alta manual). Combina tres lecturas que ya existen en
// sources.ts: registro (identidad, cadencia, verificacion en vivo), frescura
// (REQ-149: edad del ultimo dato exitoso, obsolescencia SIEMPRE visible) y
// corridas recientes con evidencia (REQ-147/148: una falla nunca se muestra como
// "0 resultados"). No hay botones de accion: las corridas las dispara el cron
// del worker, ningun cliente inserta corridas a mano.
//
// Cada lectura falla por separado (Promise.allSettled): si la base aun no tiene
// una tabla, esa seccion muestra "no disponible aun" y el resto sigue operando.
import { useEffect, useState } from "react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { SOURCE_STATE_LABELS, fetchSourceConnectors, fetchSourceFreshness, fetchSourceRuns, formatAge } from "../lib/sources-client.ts";
import type { SourceConnectorInfo, SourceFreshness, SourceRun } from "../lib/sources-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

const DATE_TIME = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

function when(iso: string | null): string {
  return iso ? DATE_TIME.format(new Date(iso)) : "—";
}

export function FuentesFrescuraPage({ apiBaseUrl, token, propertyId }: LicitacionesShellContext) {
  const [connectors, setConnectors] = useState<readonly SourceConnectorInfo[] | null>(null);
  const [freshness, setFreshness] = useState<readonly SourceFreshness[] | null>(null);
  const [runs, setRuns] = useState<readonly SourceRun[] | null>(null);
  const [errors, setErrors] = useState<{ connectors?: string; freshness?: string; runs?: string }>({});
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [c, f, r] = await Promise.allSettled([
      fetchSourceConnectors(fetch, apiBaseUrl, token, propertyId),
      fetchSourceFreshness(fetch, apiBaseUrl, token, propertyId),
      fetchSourceRuns(fetch, apiBaseUrl, token, propertyId, { limit: 20 }),
    ]);
    const next: { connectors?: string; freshness?: string; runs?: string } = {};
    if (c.status === "fulfilled") setConnectors(c.value);
    else next.connectors = c.reason instanceof Error ? c.reason.message : "No se pudo cargar el registro de fuentes.";
    if (f.status === "fulfilled") setFreshness(f.value);
    else next.freshness = f.reason instanceof Error ? f.reason.message : "No se pudo cargar la frescura.";
    if (r.status === "fulfilled") setRuns(r.value);
    else next.runs = r.reason instanceof Error ? r.reason.message : "No se pudieron cargar las corridas.";
    setErrors(next);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  const freshnessById = new Map((freshness ?? []).map((f) => [f.source, f]));
  const labelById = new Map((connectors ?? []).map((c) => [c.id, c.label]));
  const staleCount = (freshness ?? []).filter((f) => f.stale).length;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Fuentes y frescura</h1>
        <p className="mt-1 max-w-[720px] text-[13px] text-muted-foreground">
          De dónde salen las convocatorias (CompraNet/ComprasMX, portales estatales con estándar OCDS y alta manual) y qué tan al día está cada fuente. Una fuente sin corridas exitosas se marca como obsoleta:
          nunca se presenta como si estuviera actualizada. Una fuente &quot;verificada&quot; solo lo es si se probó en vivo con evidencia.
        </p>
      </header>

      {loading && !connectors && !freshness && <EstadoCargando etiqueta="Cargando fuentes…" />}

      {errors.connectors && <EstadoError mensaje={errors.connectors} onReintentar={() => void load()} />}
      {errors.freshness && <EstadoError mensaje={`Frescura: ${errors.freshness}`} onReintentar={() => void load()} />}

      {connectors && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fuentes registradas</CardTitle>
            <CardDescription>
              {freshness ? `${staleCount} de ${freshness.length} fuente(s) obsoleta(s).` : "Frescura no disponible por ahora."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {connectors.length === 0 ? (
              <EstadoVacio mensaje="No hay fuentes registradas." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fuente</TableHead>
                      <TableHead>Verificación en vivo</TableHead>
                      <TableHead>Último estado</TableHead>
                      <TableHead>Último éxito</TableHead>
                      <TableHead>Frescura</TableHead>
                      <TableHead>Cadencia declarada</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {connectors.map((c) => {
                      const fr = freshnessById.get(c.id);
                      return (
                        <TableRow key={c.id}>
                          <TableCell className="p-3">
                            <div className="font-semibold text-foreground">{c.label}</div>
                            <div className="text-[11px] text-muted-foreground">{c.kind === "manual" ? "Manual" : "Automática"} · {c.id}</div>
                          </TableCell>
                          <TableCell className="p-3">
                            <Badge variant={c.liveVerification.verified ? "default" : "outline"}>{c.liveVerification.verified ? "Verificada" : "Sin verificar"}</Badge>
                            <div className="mt-1 max-w-[260px] text-[11px] text-muted-foreground">{c.liveVerification.note}</div>
                          </TableCell>
                          <TableCell className="p-3 text-muted-foreground">{fr ? (fr.lastRunState ? SOURCE_STATE_LABELS[fr.lastRunState] : "Sin corridas") : "—"}</TableCell>
                          <TableCell className="p-3 text-muted-foreground">{fr ? when(fr.lastSuccessAt) : "—"}</TableCell>
                          <TableCell className="p-3">
                            {fr ? (
                              <>
                                <Badge variant={fr.stale ? "destructive" : "default"}>{fr.stale ? "Obsoleta" : "Al día"}</Badge>
                                <div className="mt-1 text-[11px] text-muted-foreground">{formatAge(fr.staleForMs)}</div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">No disponible</span>
                            )}
                          </TableCell>
                          <TableCell className="p-3 text-[12px] text-muted-foreground">{c.cadence.minIntervalMinutes === 0 ? "A demanda" : `Cada ${c.cadence.minIntervalMinutes} min`} — {c.cadence.note}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Corridas recientes</CardTitle>
          <CardDescription>Evidencia y cobertura (esperado vs. obtenido) de las últimas 20 corridas de la organización.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {errors.runs && <div className="p-4"><EstadoError mensaje={errors.runs} onReintentar={() => void load()} /></div>}
          {runs && runs.length === 0 && <EstadoVacio mensaje="Todavía no hay corridas registradas." />}
          {runs && runs.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fuente</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Inicio</TableHead>
                    <TableHead>Cobertura</TableHead>
                    <TableHead>Evidencia</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run, i) => (
                    <TableRow key={run.id || `${run.source}-${run.startedAt}-${i}`}>
                      <TableCell className="p-3 font-medium text-foreground">{labelById.get(run.source) ?? run.source}</TableCell>
                      <TableCell className="p-3">
                        <Badge variant={run.state === "ok" ? "default" : "destructive"}>{SOURCE_STATE_LABELS[run.state]}</Badge>
                      </TableCell>
                      <TableCell className="p-3 text-muted-foreground">{when(run.startedAt)}</TableCell>
                      <TableCell className="p-3 tabular-nums text-muted-foreground">{run.evidence.coverage ? `${run.evidence.coverage.obtained} de ${run.evidence.coverage.expected}` : "—"}</TableCell>
                      <TableCell className="p-3 text-[12px] text-muted-foreground">
                        {run.evidence.message}
                        {run.notPersistedReason && <div className="text-[11px] text-destructive">No persistida: {run.notPersistedReason}</div>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

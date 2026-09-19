// Salud operativa — primera pieza del "cerebro" de backoffice del
// superadmin: el dueño hoy no tiene forma de saber si los 17 crons de
// vercel.json corrieron, si una cola de mensajería está atascada/con
// mensajes muertos, o si una fuente de licitaciones está caída. Backend
// real: GET /superadmin/salud[/crons|/colas|/licitaciones-fuentes]
// (apps/api/src/routes/superadmin-salud.ts), motor DETERMINISTA en
// apps/api/src/salud/motor.ts (nunca un LLM opinando). Mismo patrón que
// GastoApi.tsx/Facturacion.tsx: sin librerías de gráficas/fecha nuevas.
import { useEffect, useState } from "react";
import { AlertTriangle, CircleAlert, CircleCheck, Clock, DollarSign, ExternalLink, Inbox, Radio } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";

type SeveridadAlerta = "critica" | "alta" | "media";

interface Alerta {
  readonly severidad: SeveridadAlerta;
  readonly titulo: string;
  readonly detalle: string;
  readonly href: string;
}

type EstadoCron = "ok" | "vencido" | "sin_latido" | "error";

interface CronHeartbeat {
  readonly cronName: string;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastStatus: "ok" | "error" | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly consecutiveFailures: number;
}

interface CronConEstado {
  readonly cronName: string;
  readonly estado: EstadoCron;
  readonly heartbeat: CronHeartbeat | null;
}

interface Cola {
  readonly queueName: string;
  readonly pendingCount: number;
  readonly processingCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly deadCount: number;
  readonly oldestPendingSeconds: number | null;
  readonly lastSentAt: string | null;
}

interface FuenteLicitaciones {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly source: string;
  readonly state: string;
  readonly finishedAt: string;
  readonly message: string;
}

interface Resumen {
  readonly alertas: readonly Alerta[];
  readonly resumen: {
    readonly crons: { total: number; ok: number; vencido: number; sinLatido: number; error: number } | null;
    readonly colas: { total: number; muertos: number; pendientes: number } | null;
    readonly licitacionesFuentes: { total: number; conAlerta: number } | null;
  };
}

const NOMBRE_VERTICAL: Record<string, string> = {
  citas: "Citas",
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
  licitaciones: "Licitaciones",
};

function tiempoRelativo(iso: string | null): string {
  if (!iso) return "nunca";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "hace un momento";
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return "hace segundos";
  if (minutos < 60) return `hace ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  return `hace ${dias} d`;
}

function duracion(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

function BadgeEstadoCron({ estado }: { readonly estado: EstadoCron }) {
  if (estado === "ok") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">ok</Badge>;
  if (estado === "vencido") return <Badge variant="secondary" className="bg-amber-500 text-white hover:bg-amber-500">vencido</Badge>;
  if (estado === "error") return <Badge variant="destructive">error</Badge>;
  return <Badge variant="outline">sin latido todavía</Badge>;
}

function BadgeSeveridad({ severidad }: { readonly severidad: SeveridadAlerta }) {
  if (severidad === "critica") return <Badge variant="destructive">crítica</Badge>;
  if (severidad === "alta") return <Badge className="bg-amber-500 text-white hover:bg-amber-500">alta</Badge>;
  return <Badge variant="secondary">media</Badge>;
}

function IconoSemaforo({ alertas }: { readonly alertas: readonly Alerta[] }) {
  if (alertas.length === 0) return <CircleCheck className="w-5 h-5 text-emerald-600" strokeWidth={1.75} />;
  if (alertas.some((a) => a.severidad === "critica")) return <CircleAlert className="w-5 h-5 text-destructive" strokeWidth={1.75} />;
  return <AlertTriangle className="w-5 h-5 text-amber-500" strokeWidth={1.75} />;
}

export function SuperAdminSaludPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [crons, setCrons] = useState<readonly CronConEstado[] | null>(null);
  const [colas, setColas] = useState<readonly Cola[] | null>(null);
  const [fuentes, setFuentes] = useState<readonly FuenteLicitaciones[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const [r, c, q, f] = await Promise.all([
        fetchJson<Resumen>(apiBaseUrl, token, "/superadmin/salud"),
        fetchJson<{ crons: CronConEstado[] }>(apiBaseUrl, token, "/superadmin/salud/crons"),
        fetchJson<{ colas: Cola[] }>(apiBaseUrl, token, "/superadmin/salud/colas"),
        fetchJson<{ fuentes: FuenteLicitaciones[] }>(apiBaseUrl, token, "/superadmin/salud/licitaciones-fuentes"),
      ]);
      setResumen(r);
      setCrons(c.crons);
      setColas(q.colas);
      setFuentes(f.fuentes);
    } catch {
      setError("No se pudo cargar la salud operativa.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  if (error && !resumen) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!resumen || !crons || !colas || !fuentes) return <EstadoCargando etiqueta="Cargando salud operativa…" />;

  const sinNingunLatidoTodavia = crons.length > 0 && crons.every((c) => c.estado === "sin_latido");

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <IconoSemaforo alertas={resumen.alertas} />
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Salud operativa</h1>
            <p className="text-sm text-muted-foreground mt-1">Crons, colas de mensajería y fuentes de licitaciones de las 6 verticales, en un solo lugar.</p>
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      {sinNingunLatidoTodavia && (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <EstadoVacio mensaje="Sin latidos todavía — ningún cron ha corrido en este entorno. Esto es normal justo después de un despliegue nuevo; vuelve en cuanto pase la primera cadencia de 24 h." />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Alertas accionables</CardTitle>
        </CardHeader>
        <CardContent>
          {resumen.alertas.length === 0 ? (
            <EstadoVacio mensaje="Sin alertas — todo lo que se pudo leer está dentro de lo esperado." />
          ) : (
            <ul className="flex flex-col gap-2">
              {resumen.alertas.map((a, i) => (
                <li key={`${a.titulo}-${i}`} className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <BadgeSeveridad severidad={a.severidad} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground">{a.titulo}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{a.detalle}</p>
                  </div>
                  <a href={a.href} className="text-xs text-primary flex items-center gap-1 shrink-0 hover:underline">
                    ver <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Radio className="w-5 h-5 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <p className="text-xs text-muted-foreground">Crons</p>
              <p className="text-lg font-semibold text-foreground">{resumen.resumen.crons ? `${resumen.resumen.crons.ok} / ${resumen.resumen.crons.total} ok` : "no disponible"}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Inbox className="w-5 h-5 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <p className="text-xs text-muted-foreground">Colas — mensajes muertos</p>
              <p className="text-lg font-semibold text-foreground">{resumen.resumen.colas ? resumen.resumen.colas.muertos : "no disponible"}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <p className="text-xs text-muted-foreground">Gasto de API de LLM</p>
              <a href="/superadmin/gasto-api" className="text-sm text-primary hover:underline">
                Ver detalle →
              </a>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Crons ({crons.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {crons.length === 0 ? (
            <EstadoVacio mensaje="vercel.json no declara ningún cron todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cron</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Último latido</TableHead>
                    <TableHead>Duración</TableHead>
                    <TableHead>Fallos consecutivos</TableHead>
                    <TableHead>Último error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {crons.map((c) => (
                    <TableRow key={c.cronName}>
                      <TableCell className="font-mono text-xs">{c.cronName}</TableCell>
                      <TableCell>
                        <BadgeEstadoCron estado={c.estado} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" strokeWidth={1.75} />
                          {tiempoRelativo(c.heartbeat?.lastFinishedAt ?? null)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{duracion(c.heartbeat?.lastDurationMs ?? null)}</TableCell>
                      <TableCell className={c.heartbeat && c.heartbeat.consecutiveFailures > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{c.heartbeat?.consecutiveFailures ?? 0}</TableCell>
                      <TableCell className="text-muted-foreground text-xs max-w-[280px] truncate" title={c.heartbeat?.lastError ?? undefined}>
                        {c.heartbeat?.lastError ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Colas de mensajería ({colas.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {colas.length === 0 ? (
            <EstadoVacio mensaje="Sin colas de mensajería registradas." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vertical</TableHead>
                    <TableHead>Pendientes</TableHead>
                    <TableHead>Procesando</TableHead>
                    <TableHead>Enviados</TableHead>
                    <TableHead>Fallidos</TableHead>
                    <TableHead>Muertos</TableHead>
                    <TableHead>Pendiente más viejo</TableHead>
                    <TableHead>Último enviado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {colas.map((q) => (
                    <TableRow key={q.queueName}>
                      <TableCell className="font-medium text-foreground">{NOMBRE_VERTICAL[q.queueName] ?? q.queueName}</TableCell>
                      <TableCell>{q.pendingCount}</TableCell>
                      <TableCell>{q.processingCount}</TableCell>
                      <TableCell>{q.sentCount}</TableCell>
                      <TableCell>{q.failedCount}</TableCell>
                      <TableCell className={q.deadCount > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{q.deadCount}</TableCell>
                      <TableCell className="text-muted-foreground">{q.oldestPendingSeconds === null ? "—" : `${Math.round(q.oldestPendingSeconds / 60)} min`}</TableCell>
                      <TableCell className="text-muted-foreground">{q.lastSentAt ? tiempoRelativo(q.lastSentAt) : "no disponible"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fuentes de licitaciones ({fuentes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {fuentes.length === 0 ? (
            <EstadoVacio mensaje="Sin corridas de fuentes de licitaciones registradas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Fuente</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Última corrida</TableHead>
                    <TableHead>Mensaje</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fuentes.map((f) => (
                    <TableRow key={`${f.organizationId}-${f.source}`}>
                      <TableCell>{f.organizationName}</TableCell>
                      <TableCell className="font-mono text-xs">{f.source}</TableCell>
                      <TableCell>
                        {f.state === "ok" ? (
                          <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">ok</Badge>
                        ) : f.state === "not_configured" ? (
                          <Badge variant="outline">not_configured</Badge>
                        ) : (
                          <Badge variant="destructive">{f.state}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{tiempoRelativo(f.finishedAt)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs max-w-[320px] truncate" title={f.message}>
                        {f.message}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}

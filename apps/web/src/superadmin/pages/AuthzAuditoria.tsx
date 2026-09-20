// Bitácora de denegaciones de acceso a /superadmin/* -- sink persistente,
// pendiente declarado del PR #162 (ver packages/db/migrations/
// 0021_superadmin_authz_audit_log.sql). Solo lectura (a diferencia de
// BreakGlass.tsx/Impersonacion.tsx, esta pantalla no abre/cierra nada -- el
// intento denegado ya ocurrió, aquí solo se audita). Backend real:
// GET /superadmin/authz-auditoria en apps/api/src/routes/superadmin.ts.
import { useEffect, useState } from "react";
import { ShieldOff } from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, StatCard, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";

export interface AuthzAuditLogEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorIp: string | null;
  readonly organizationId: string | null;
  readonly action: string;
  readonly route: string;
  readonly method: string;
  readonly decision: "allowed" | "denied";
  readonly reason: string | null;
  readonly metadata: Record<string, unknown>;
  readonly occurredAtMs: number;
}

const PAGE_SIZE = 50;

const REASON_LABELS: Record<string, string> = {
  insufficient_role: "Rol insuficiente",
  no_membership: "Sin membresía",
  rate_limited: "Límite de intentos",
  route_not_mapped: "Ruta sin mapear",
  // Marcador de desborde del tope defensivo (ver packages/db/migrations/
  // 0022_superadmin_bitacoras_endurecimiento.sql) -- una fila así significa
  // "a partir de aquí se descartaron denegaciones reales durante esta
  // ventana", nunca un intento denegado en sí mismo.
  audit_capacity_overflow_actor: "Desborde de bitácora (tope por actor)",
  audit_capacity_overflow_global: "Desborde de bitácora (tope global)",
};

function fechaHoraEsMx(ms: number): string {
  return new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

export function SuperAdminAuthzAuditoriaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [entradas, setEntradas] = useState<readonly AuthzAuditLogEntry[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);

  async function cargarPagina(offset: number, acumular: boolean) {
    const setLoading = acumular ? setCargandoMas : setCargando;
    setLoading(true);
    setError(null);
    try {
      const r = await fetchJson<{ available: boolean; entries: AuthzAuditLogEntry[]; hasMore: boolean }>(
        apiBaseUrl,
        token,
        `/superadmin/authz-auditoria?limit=${PAGE_SIZE}&offset=${offset}`,
      );
      setAvailable(r.available);
      setHasMore(r.hasMore);
      setEntradas((prev) => (acumular ? [...(prev ?? []), ...r.entries] : r.entries));
    } catch {
      // Mensaje genérico fijo (nunca el `err.message` crudo) -- mismo criterio
      // que Impersonacion.tsx/BreakGlass.tsx: si es la carga INICIAL, `entradas`
      // se queda en `null` para que el `EstadoError` de pantalla completa (con
      // botón "reintentar") sea lo que se muestre, en vez de mezclar un error
      // de red con una tabla ya renderizada.
      setError(acumular ? "No se pudo cargar la siguiente página de la bitácora de denegaciones." : "No se pudo cargar la bitácora de denegaciones.");
    } finally {
      setLoading(false);
    }
  }

  // Primera carga -- mismo patrón que Impersonacion.tsx/BreakGlass.tsx
  // (useEffect con [apiBaseUrl, token], nunca la función `cargarPagina` en
  // las dependencias).
  useEffect(() => {
    void cargarPagina(0, false);
  }, [apiBaseUrl, token]);

  async function cargarMas() {
    if (!entradas) return;
    await cargarPagina(entradas.length, true);
  }

  if (error && !entradas) return <EstadoError mensaje={error} onReintentar={() => void cargarPagina(0, false)} />;
  if (!entradas) return <EstadoCargando etiqueta="Cargando bitácora de denegaciones…" />;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <ShieldOff className="w-5 h-5 text-destructive" strokeWidth={1.75} />
          Auditoría de denegaciones
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cada intento DENEGADO de acceso al back office de plataforma (/superadmin/*), persistido de forma inalterable — quién, desde dónde, qué ruta y por qué.
        </p>
      </div>

      {!available && (
        <p role="alert" className="text-[13px] text-muted-foreground">
          La bitácora persistente todavía no está disponible en esta base (migración pendiente de aplicar) — los intentos denegados se siguen auditando en memoria, por proceso.
        </p>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard label="Mostrando" value={String(entradas.length)} icon={ShieldOff} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Intentos denegados — más recientes primero</CardTitle>
        </CardHeader>
        <CardContent>
          {entradas.length === 0 ? (
            <EstadoVacio mensaje="Sin denegaciones registradas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cuándo</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Desde</TableHead>
                    <TableHead>Ruta</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Organización</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entradas.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground">{fechaHoraEsMx(e.occurredAtMs)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.actorUserId ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{e.actorIp ?? "—"}</TableCell>
                      <TableCell className="max-w-[240px] truncate" title={`${e.method} ${e.route}`}>
                        {e.method} {e.route}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{(e.reason && REASON_LABELS[e.reason]) ?? e.reason ?? "—"}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.organizationId ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between gap-3 mt-3">
                <p className="text-xs text-muted-foreground">
                  Mostrando {entradas.length}
                  {hasMore ? " — hay más" : ""}
                </p>
                {hasMore && (
                  <Button variant="outline" size="sm" onClick={() => void cargarMas()} disabled={cargandoMas}>
                    {cargandoMas ? "Cargando…" : "Cargar más"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}

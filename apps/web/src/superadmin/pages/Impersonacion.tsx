// Impersonación de superadmin con bitácora -- Bloque C, conecta
// packages/core-authz/src/impersonation/* (construido pero sin ninguna ruta
// desde el 11-sep) a una sesión real verificada en Postgres. Backend real:
// apps/api/src/routes/superadmin-impersonacion.ts. Mismo patrón de
// sesión/manejo de errores/modal que BreakGlass.tsx (el mismo modelo de
// seguridad que esta pantalla copia).
import { useEffect, useState, type FormEvent } from "react";
import { History, LogIn, LogOut, ShieldAlert } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";

export interface ImpersonacionSesion {
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly actorEmail: string | null;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly activa: boolean;
  readonly remainingMs: number;
}

interface BitacoraEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly eventType: "start" | "end";
  readonly organizationId: string;
  readonly actorEmail: string | null;
  readonly reason: string | null;
  readonly occurredAtMs: number;
  readonly seq: number;
  readonly hash: string;
}

function fechaHoraEsMx(ms: number): string {
  return new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

function duracionRestante(remainingMs: number): string {
  const totalMin = Math.max(0, Math.floor(remainingMs / 60_000));
  return `${totalMin} min`;
}

export async function fetchImpersonacionJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

export function SuperAdminImpersonacionPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [sesiones, setSesiones] = useState<readonly ImpersonacionSesion[] | null>(null);
  const [bitacora, setBitacora] = useState<readonly BitacoraEntry[] | null>(null);
  // Default `false` -- re-revisión (hallazgo 8): aunque el `return` de
  // `EstadoCargando` de abajo (antes de renderizar el botón) ya evita en la
  // práctica que "Iniciar impersonación" aparezca habilitado antes de que
  // `cargar()` resuelva (sesiones/bitacora siguen `null` hasta entonces, y
  // `setAvailable` se actualiza en el MISMO batch que ellas), asumir "no
  // disponible" hasta que la API lo confirme es el default correcto en
  // profundidad -- nunca depender solo de dónde cae el `return` de arriba.
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const [abriendo, setAbriendo] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [terminando, setTerminando] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const [s, b] = await Promise.all([
        fetchImpersonacionJson<{ available: boolean; sessions: ImpersonacionSesion[] }>(apiBaseUrl, token, "/superadmin/impersonacion/sesiones"),
        fetchImpersonacionJson<{ available: boolean; entries: BitacoraEntry[] }>(apiBaseUrl, token, "/superadmin/impersonacion/bitacora"),
      ]);
      setAvailable(s.available && b.available);
      setSesiones(s.sessions);
      setBitacora(b.entries);
    } catch {
      setError("No se pudo cargar el estado de impersonación.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  function abrirModal() {
    setOrgId("");
    setMotivo("");
    setFormError(null);
    setAbriendo(true);
  }

  async function iniciarImpersonacion(e: FormEvent) {
    e.preventDefault();
    if (!orgId.trim()) {
      setFormError("El id de la organización es obligatorio.");
      return;
    }
    if (motivo.trim().length < 20) {
      setFormError("El motivo debe tener al menos 20 caracteres -- una justificación real, no un placeholder.");
      return;
    }
    setFormError(null);
    setGuardando(true);
    try {
      await fetchImpersonacionJson(apiBaseUrl, token, "/superadmin/impersonacion/sesiones", {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId.trim(), reason: motivo }),
      });
      setAbriendo(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo iniciar la impersonación.");
    } finally {
      setGuardando(false);
    }
  }

  async function terminarSesion(sesion: ImpersonacionSesion) {
    setTerminando(sesion.id);
    try {
      await fetchImpersonacionJson(apiBaseUrl, token, `/superadmin/impersonacion/sesiones/${sesion.id}/terminar`, { method: "POST" });
      await cargar();
    } catch {
      setError("No se pudo terminar la sesión de impersonación.");
    } finally {
      setTerminando(null);
    }
  }

  if (error && !sesiones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!sesiones || !bitacora) return <EstadoCargando etiqueta="Cargando impersonación…" />;

  const activas = sesiones.filter((s) => s.activa);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-destructive" strokeWidth={1.75} />
            Impersonación de superadmin
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sesión auditada de solo lectura, con motivo obligatorio y duración acotada (15 minutos), verificada en Postgres.
          </p>
        </div>
        <Button
          className="rounded-full gap-1.5"
          onClick={abrirModal}
          disabled={!available}
          title={!available ? "La impersonación no está disponible todavía -- migración pendiente de aplicar." : undefined}
        >
          <LogIn className="w-3.5 h-3.5" strokeWidth={1.75} />
          Iniciar impersonación
        </Button>
      </div>

      {!available && (
        <p role="alert" className="text-[13px] text-muted-foreground">
          La impersonación de superadmin todavía no está disponible en esta base (migración pendiente de aplicar) -- el
          botón "Iniciar impersonación" está deshabilitado mientras tanto.
        </p>
      )}

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard label="Sesiones activas ahora (plataforma)" value={String(activas.length)} icon={LogIn} />
        <StatCard label="Sesiones totales (histórico)" value={String(sesiones.length)} icon={History} />
        <StatCard label="Eventos en la bitácora" value={String(bitacora.length)} icon={ShieldAlert} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sesiones de impersonación — oversight de plataforma</CardTitle>
        </CardHeader>
        <CardContent>
          {sesiones.length === 0 ? (
            <EstadoVacio mensaje="Todavía no se ha iniciado ninguna sesión de impersonación." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Iniciada</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sesiones.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-muted-foreground">{s.actorEmail ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{s.organizationId}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={s.reason}>
                        {s.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{fechaHoraEsMx(s.startedAtMs)}</TableCell>
                      <TableCell>
                        {s.activa ? <Badge>Activa · {duracionRestante(s.remainingMs)} restantes</Badge> : <Badge variant="outline">Terminada / vencida</Badge>}
                      </TableCell>
                      <TableCell>
                        {s.activa && (
                          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void terminarSesion(s)} disabled={terminando === s.id}>
                            <LogOut className="w-3.5 h-3.5" strokeWidth={1.75} />
                            {terminando === s.id ? "Terminando…" : "Terminar"}
                          </Button>
                        )}
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
          <CardTitle>Bitácora inmutable (inicio/fin de cada sesión)</CardTitle>
        </CardHeader>
        <CardContent>
          {bitacora.length === 0 ? (
            <EstadoVacio mensaje="Sin eventos de impersonación registrados todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Cuándo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bitacora.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground">{e.seq}</TableCell>
                      <TableCell>
                        <Badge variant={e.eventType === "start" ? "default" : "outline"}>{e.eventType === "start" ? "Iniciada" : "Terminada"}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{e.actorEmail ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{e.organizationId}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={e.reason ?? ""}>
                        {e.reason ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{fechaHoraEsMx(e.occurredAtMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ModalFormularioLateral
        open={abriendo}
        onOpenChange={(open) => setAbriendo(open)}
        titulo="Iniciar impersonación"
        subtitulo="Solo lectura, auditada, con motivo obligatorio y 15 minutos de duración."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAbriendo(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-iniciar-impersonacion" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Iniciando…" : "Iniciar"}
            </Button>
          </>
        }
      >
        <form id="form-iniciar-impersonacion" onSubmit={iniciarImpersonacion} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="impersonacion-org-id">Id de la organización objetivo</Label>
            <Input id="impersonacion-org-id" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="uuid de la organización" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="impersonacion-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <textarea
              id="impersonacion-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              placeholder="Ej. Ticket SOP-9001: el tenant reporta que su checkout público falla, necesito revisar su configuración."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>

      {cargando && <p className="text-xs text-muted-foreground">Actualizando…</p>}
    </div>
  );
}

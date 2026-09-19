// "Romper cristal" (break-glass) -- Fase 10b, cierra el gap señalado por la
// auditoría del 18-sep-2026 ("break-glass de superadmin construido pero
// desconectado de toda ruta HTTP", y del panel). Backend real: apps/api/src/
// routes/superadmin-break-glass.ts (ya verificado contra las funciones security
// definer de rentas.break_glass_session/rentas.break_glass_access_log). Mismo
// patrón de sesión/manejo de errores que GastoApi.tsx/Prospectos.tsx.
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { AlertOctagon, Clock, DoorOpen, History, Lock, Unlock } from "lucide-react";
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

interface Sesion {
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly openedAtMs: number;
  readonly expiresAtMs: number;
  readonly closedAtMs: number | null;
  readonly closedBy: string | null;
  readonly activa: boolean;
  readonly remainingMs: number;
}

interface BitacoraEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly reason: string;
  readonly resourceType: string;
  readonly resourceScope: Record<string, unknown>;
  readonly resultSummary: { readonly total?: number } & Record<string, unknown>;
  readonly occurredAtMs: number;
  readonly seq: number;
  readonly hash: string;
}

interface ReservaResumen {
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly estado: string;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
}

const DURACIONES = [
  { minutos: 15, etiqueta: "15 minutos" },
  { minutos: 30, etiqueta: "30 minutos" },
  { minutos: 60, etiqueta: "1 hora" },
  { minutos: 120, etiqueta: "2 horas" },
  { minutos: 240, etiqueta: "4 horas (máximo)" },
];

function fechaHoraEsMx(ms: number): string {
  return new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}

function duracionRestante(remainingMs: number): string {
  const totalMin = Math.floor(remainingMs / 60_000);
  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;
  if (horas > 0) return `${horas}h ${minutos}min`;
  return `${minutos}min`;
}

function EstadoSesion({ sesion }: { readonly sesion: Sesion }) {
  if (sesion.activa) return <Badge>Activa · {duracionRestante(sesion.remainingMs)} restantes</Badge>;
  if (sesion.closedAtMs) return <Badge variant="outline">Cerrada manualmente</Badge>;
  return <Badge variant="outline">Vencida</Badge>;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
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

export function SuperAdminBreakGlassPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [sesiones, setSesiones] = useState<readonly Sesion[] | null>(null);
  const [bitacora, setBitacora] = useState<readonly BitacoraEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const [abriendo, setAbriendo] = useState(false);
  const [orgId, setOrgId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [duracionMinutos, setDuracionMinutos] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const [cerrando, setCerrando] = useState<string | null>(null);

  const [reservasSesionId, setReservasSesionId] = useState<string | null>(null);
  const [reservas, setReservas] = useState<readonly ReservaResumen[] | null>(null);
  const [reservasError, setReservasError] = useState<string | null>(null);
  const [reservasCargando, setReservasCargando] = useState(false);

  async function cargar() {
    setError(null);
    setCargando(true);
    try {
      const [s, b] = await Promise.all([
        fetchJson<{ sessions: Sesion[] }>(apiBaseUrl, token, "/superadmin/break-glass/sesiones"),
        fetchJson<{ entries: BitacoraEntry[] }>(apiBaseUrl, token, "/superadmin/break-glass/bitacora"),
      ]);
      setSesiones(s.sessions);
      setBitacora(b.entries);
    } catch {
      setError("No se pudo cargar el estado de romper-cristal.");
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
    setDuracionMinutos(30);
    setFormError(null);
    setAbriendo(true);
  }

  async function abrirAcceso(e: FormEvent) {
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
      await fetchJson(apiBaseUrl, token, "/superadmin/break-glass/sesiones", {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId.trim(), reason: motivo, durationMinutes: duracionMinutos }),
      });
      setAbriendo(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo abrir el acceso de emergencia.");
    } finally {
      setGuardando(false);
    }
  }

  async function cerrarAcceso(sesion: Sesion) {
    setCerrando(sesion.id);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/break-glass/sesiones/${sesion.id}/cerrar`, { method: "POST" });
      await cargar();
    } catch {
      setError("No se pudo cerrar el acceso.");
    } finally {
      setCerrando(null);
    }
  }

  async function verReservas(sesion: Sesion) {
    if (reservasSesionId === sesion.id) {
      setReservasSesionId(null);
      return;
    }
    setReservasSesionId(sesion.id);
    setReservas(null);
    setReservasError(null);
    setReservasCargando(true);
    try {
      const r = await fetchJson<{ reservas: ReservaResumen[] }>(apiBaseUrl, token, `/superadmin/break-glass/organizaciones/${sesion.organizationId}/reservas`);
      setReservas(r.reservas);
    } catch (err) {
      setReservasError(err instanceof Error ? err.message : "No se pudieron leer las reservas del tenant.");
    } finally {
      setReservasCargando(false);
    }
  }

  if (error && !sesiones) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!sesiones || !bitacora) return <EstadoCargando etiqueta="Cargando romper-cristal…" />;

  const activas = sesiones.filter((s) => s.activa);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <AlertOctagon className="w-5 h-5 text-destructive" strokeWidth={1.75} />
            Romper cristal
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Acceso de emergencia, auditado e inalterable, a los datos de un tenant de rentas fuera del flujo normal de autorización.
          </p>
        </div>
        <Button className="rounded-full gap-1.5" onClick={abrirModal}>
          <DoorOpen className="w-3.5 h-3.5" strokeWidth={1.75} />
          Abrir acceso de emergencia
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard label="Accesos activos ahora" value={String(activas.length)} icon={Unlock} />
        <StatCard label="Accesos totales (histórico)" value={String(sesiones.length)} icon={History} />
        <StatCard label="Lecturas en la bitácora" value={String(bitacora.length)} icon={Lock} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accesos de emergencia — activos e históricos</CardTitle>
        </CardHeader>
        <CardContent>
          {sesiones.length === 0 ? (
            <EstadoVacio mensaje="Todavía no has abierto ningún acceso de romper-cristal." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organización</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Abierto</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sesiones.map((s) => (
                    <Fragment key={s.id}>
                      <TableRow>
                        <TableCell className="font-mono text-xs">{s.organizationId}</TableCell>
                        <TableCell className="max-w-[320px] truncate" title={s.reason}>
                          {s.reason}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{fechaHoraEsMx(s.openedAtMs)}</TableCell>
                        <TableCell>
                          <EstadoSesion sesion={s} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 justify-end">
                            {s.activa && (
                              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void verReservas(s)}>
                                <Clock className="w-3.5 h-3.5" strokeWidth={1.75} />
                                {reservasSesionId === s.id ? "Ocultar reservas" : "Ver reservas"}
                              </Button>
                            )}
                            {s.activa && (
                              <Button variant="outline" size="sm" onClick={() => void cerrarAcceso(s)} disabled={cerrando === s.id}>
                                {cerrando === s.id ? "Cerrando…" : "Cerrar"}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {reservasSesionId === s.id && (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-muted/30">
                            {reservasCargando && <p className="text-xs text-muted-foreground p-2">Leyendo reservas del tenant…</p>}
                            {reservasError && (
                              <p role="alert" className="text-xs text-destructive p-2">
                                {reservasError}
                              </p>
                            )}
                            {reservas && reservas.length === 0 && <p className="text-xs text-muted-foreground p-2">El tenant no tiene reservas directas registradas.</p>}
                            {reservas && reservas.length > 0 && (
                              <div className="p-2 flex flex-col gap-1">
                                {reservas.map((r) => (
                                  <div key={r.ocupacionId} className="text-xs text-foreground">
                                    {r.checkIn} → {r.checkOut} · {r.estado} · {r.huespedNombre ?? "sin nombre registrado"}
                                  </div>
                                ))}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bitácora inmutable</CardTitle>
        </CardHeader>
        <CardContent>
          {bitacora.length === 0 ? (
            <EstadoVacio mensaje="Sin lecturas de romper-cristal registradas todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Organización</TableHead>
                    <TableHead>Recurso</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Resumen</TableHead>
                    <TableHead>Cuándo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bitacora.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-muted-foreground">{e.seq}</TableCell>
                      <TableCell className="font-mono text-xs">{e.organizationId}</TableCell>
                      <TableCell>{e.resourceType}</TableCell>
                      <TableCell className="max-w-[280px] truncate" title={e.reason}>
                        {e.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{typeof e.resultSummary.total === "number" ? `${e.resultSummary.total} registro(s)` : "—"}</TableCell>
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
        titulo="Abrir acceso de emergencia"
        subtitulo="Romper cristal — auditado, con motivo obligatorio y duración acotada."
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setAbriendo(false)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-abrir-break-glass" className="rounded-full px-6" disabled={guardando}>
              {guardando ? "Abriendo…" : "Abrir acceso"}
            </Button>
          </>
        }
      >
        <form id="form-abrir-break-glass" onSubmit={abrirAcceso} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-org-id">Id de la organización objetivo</Label>
            <Input id="break-glass-org-id" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="uuid de la organización" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
            <textarea
              id="break-glass-motivo"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={4}
              placeholder="Ej. Ticket SOP-4821: el tenant reporta un cobro duplicado, necesito revisar sus reservas para diagnosticar."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="break-glass-duracion">Duración</Label>
            <select
              id="break-glass-duracion"
              value={duracionMinutos}
              onChange={(e) => setDuracionMinutos(Number(e.target.value))}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {DURACIONES.map((d) => (
                <option key={d.minutos} value={d.minutos}>
                  {d.etiqueta}
                </option>
              ))}
            </select>
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

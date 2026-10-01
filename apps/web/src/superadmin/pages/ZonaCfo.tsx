// Zona CFO segura (SA-41): estado del rol propio, bitacora de cada consulta financiera y asignacion del rol
// `finanzas` (solo lectura). Backend real: apps/api/src/routes/superadmin-zona-cfo.ts y
// apps/api/src/superadmin-seguridad/zona-cfo.ts (corte por rol, step-up y registro de consultas).
// Las lecturas sensibles piden el codigo MFA con `fetchConStepUp` (reintenta una vez). Sin la migracion 0034
// el API responde `disponible: false` y la pantalla lo dice, sin inventar nada.
import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, Input, Label, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";

export interface EstadoZona {
  readonly disponible: boolean;
  readonly rol: "superadmin" | "finanzas" | null;
  readonly soloLectura: boolean;
  readonly mfaObligatoria: boolean;
  readonly mensaje?: string;
}

export interface EntradaBitacora {
  readonly seq: number;
  readonly actorUserId: string;
  readonly actorRol: "superadmin" | "finanzas";
  readonly accion: "consulta" | "exportacion" | "denegado" | "rol_asignado" | "rol_retirado";
  readonly recurso: string;
  readonly filtros: Readonly<Record<string, unknown>>;
  readonly ocurrioEnMs: number;
}

export interface RolAsignado {
  readonly usuarioId: string;
  readonly correo: string;
  readonly rol: "finanzas";
  readonly motivo: string;
  readonly desdeMs: number;
}

interface RespuestaBitacora {
  readonly disponible: boolean;
  readonly entradas: readonly EntradaBitacora[];
  readonly siguienteAntesDeSeq: number | null;
}

interface RespuestaRoles {
  readonly disponible: boolean;
  readonly roles: readonly RolAsignado[];
}

const ETIQUETA_ACCION: Record<EntradaBitacora["accion"], string> = {
  consulta: "Consulta",
  exportacion: "Exportación",
  denegado: "Denegado",
  rol_asignado: "Rol asignado",
  rol_retirado: "Rol retirado",
};

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

const fechaHora = (ms: number) => new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "medium" });
const resumenFiltros = (f: Readonly<Record<string, unknown>>) =>
  Object.entries(f)
    .filter(([k]) => k !== "_ruta")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ") || "—";

export function SuperAdminZonaCfoPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [estado, setEstado] = useState<EstadoZona | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bitacora, setBitacora] = useState<RespuestaBitacora | null>(null);
  const [roles, setRoles] = useState<RespuestaRoles | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [usuarioId, setUsuarioId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function cargarAdmin() {
    setAviso(null);
    try {
      const [b, r] = await Promise.all([
        fetchJson<RespuestaBitacora>(apiBaseUrl, token, "/superadmin/zona-cfo/bitacora?limite=50"),
        fetchJson<RespuestaRoles>(apiBaseUrl, token, "/superadmin/zona-cfo/roles"),
      ]);
      setBitacora(b);
      setRoles(r);
    } catch {
      setAviso("No se pudo cargar la bitácora ni los roles. Verifica tu código MFA y reintenta.");
    }
  }

  async function cargar() {
    setError(null);
    try {
      const e = await fetchJson<EstadoZona>(apiBaseUrl, token, "/superadmin/zona-cfo/estado");
      setEstado(e);
      if (e.disponible && e.rol === "superadmin") await cargarAdmin();
    } catch {
      setError("No se pudo cargar el estado de la zona CFO.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  async function masAntiguas() {
    if (!bitacora || bitacora.siguienteAntesDeSeq === null) return;
    try {
      const sig = await fetchJson<RespuestaBitacora>(apiBaseUrl, token, `/superadmin/zona-cfo/bitacora?limite=50&antesDeSeq=${bitacora.siguienteAntesDeSeq}`);
      setBitacora({ disponible: sig.disponible, entradas: [...bitacora.entradas, ...sig.entradas], siguienteAntesDeSeq: sig.siguienteAntesDeSeq });
    } catch {
      setAviso("No se pudieron cargar más registros.");
    }
  }

  async function cambiarRol(destino: string, rol: "finanzas" | null, motivoTexto: string) {
    setGuardando(true);
    setFormError(null);
    try {
      await fetchJson(apiBaseUrl, token, `/superadmin/zona-cfo/roles/${encodeURIComponent(destino)}`, { method: "PUT", body: JSON.stringify({ rol, motivo: motivoTexto }) });
      setUsuarioId("");
      setMotivo("");
      await cargarAdmin();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo cambiar el rol.");
    } finally {
      setGuardando(false);
    }
  }

  function asignar(e: FormEvent) {
    e.preventDefault();
    if (usuarioId.trim().length === 0) {
      setFormError("Indica el id del superadmin.");
      return;
    }
    if (motivo.trim().length < 20) {
      setFormError("El motivo debe tener al menos 20 caracteres.");
      return;
    }
    void cambiarRol(usuarioId.trim(), "finanzas", motivo.trim());
  }

  if (error && !estado) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!estado) return <EstadoCargando etiqueta="Cargando zona CFO…" />;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div>
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" strokeWidth={1.75} />
          Zona CFO segura
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cada consulta financiera queda registrada (quién, qué, cuándo y con qué filtros). Exportar datos y leer esta bitácora piden tu código MFA. El rol «finanzas» es de solo lectura y siempre exige MFA.
        </p>
      </div>

      {!estado.disponible && (
        <p role="alert" className="text-sm text-muted-foreground">
          {estado.mensaje ?? "La zona CFO segura todavía no está disponible en este despliegue."} Mientras tanto no hay rol de solo lectura ni bitácora de consultas.
        </p>
      )}

      {estado.disponible && (
        <Card>
          <CardHeader>
            <CardTitle>Tu acceso</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge tone={estado.soloLectura ? "neutral" : "info"}>{estado.soloLectura ? "Finanzas (solo lectura)" : "Superadmin"}</StatusBadge>
            <span className="text-muted-foreground">{estado.mfaObligatoria ? "MFA obligatoria para entrar a las pantallas financieras." : "MFA exigida si ya la enrolaste."}</span>
          </CardContent>
        </Card>
      )}

      {aviso && (
        <p role="alert" className="text-sm text-destructive">
          {aviso}
        </p>
      )}

      {estado.disponible && estado.rol === "superadmin" && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Rol «finanzas» (solo lectura)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <form onSubmit={asignar} className="flex flex-col gap-3" aria-label="Asignar rol finanzas">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="zona-usuario">Id del superadmin que quedará en solo lectura</Label>
                  <Input id="zona-usuario" value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} placeholder="uuid del superadmin" autoComplete="off" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="zona-motivo">Motivo (obligatorio, mínimo 20 caracteres)</Label>
                  <Textarea
                    id="zona-motivo"
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    rows={3}
                  />
                </div>
                {formError && (
                  <p role="alert" className="text-sm text-destructive">
                    {formError}
                  </p>
                )}
                <div>
                  <Button type="submit" className="rounded-full px-6" disabled={guardando}>
                    {guardando ? "Guardando…" : "Asignar rol finanzas"}
                  </Button>
                </div>
              </form>

              {roles && roles.roles.length === 0 && <p className="text-sm text-muted-foreground">Nadie tiene el rol «finanzas» todavía.</p>}
              {roles && roles.roles.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Usuario</TableHead>
                        <TableHead>Desde</TableHead>
                        <TableHead>Motivo</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {roles.roles.map((r) => (
                        <TableRow key={r.usuarioId}>
                          <TableCell>{r.correo}</TableCell>
                          <TableCell>{fechaHora(r.desdeMs)}</TableCell>
                          <TableCell className="max-w-[320px] truncate text-muted-foreground" title={r.motivo}>
                            {r.motivo}
                          </TableCell>
                          <TableCell>
                            <Button variant="outline" size="sm" disabled={guardando} onClick={() => void cambiarRol(r.usuarioId, null, "Retiro del rol finanzas desde la zona CFO.")}>
                              Retirar
                            </Button>
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
              <CardTitle>Bitácora de consultas financieras</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {bitacora && bitacora.entradas.length === 0 && <p className="text-sm text-muted-foreground">Sin consultas registradas todavía.</p>}
              {bitacora && bitacora.entradas.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cuándo</TableHead>
                        <TableHead>Quién</TableHead>
                        <TableHead>Acción</TableHead>
                        <TableHead>Recurso</TableHead>
                        <TableHead>Filtros</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bitacora.entradas.map((e) => (
                        <TableRow key={e.seq}>
                          <TableCell className="whitespace-nowrap">{fechaHora(e.ocurrioEnMs)}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {e.actorUserId.slice(0, 8)} <span className="text-muted-foreground">({e.actorRol})</span>
                          </TableCell>
                          <TableCell>
                            <StatusBadge tone={e.accion === "denegado" ? "danger" : "neutral"}>{ETIQUETA_ACCION[e.accion]}</StatusBadge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{e.recurso}</TableCell>
                          <TableCell className="max-w-[280px] truncate text-muted-foreground" title={resumenFiltros(e.filtros)}>
                            {resumenFiltros(e.filtros)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {bitacora && bitacora.siguienteAntesDeSeq !== null && (
                <div>
                  <Button variant="outline" className="rounded-full" onClick={() => void masAntiguas()}>
                    Cargar registros más antiguos
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {estado.disponible && estado.rol === "finanzas" && (
        <p className="text-sm text-muted-foreground">
          Tu rol es de solo lectura: puedes consultar Dashboard CFO, P&amp;L, Costos y margen, Planes y precios, Gasto de API y Facturación (resumen). La bitácora y la gestión de roles las ve un superadmin completo.
        </p>
      )}
    </PageContainer>
  );
}

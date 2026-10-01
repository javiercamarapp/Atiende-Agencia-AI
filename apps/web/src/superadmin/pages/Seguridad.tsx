// Seguridad del superadmin: MFA TOTP (estado, enrolar, activar), restablecer el factor
// de OTRO superadmin y bitacora de seguridad (mfa / interruptores / organizaciones).
// Backend real: apps/api/src/routes/superadmin-mfa.ts (ver docs/SUPERADMIN_MFA.md).
// Sin QR: no hay libreria de QR en este repo y no se agrega una dependencia nueva solo
// para esto -- se muestra el secreto para captura manual y el enlace otpauth:// (que las
// apps autenticadoras de escritorio y los gestores de contrasenas abren directo).
import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@atiende/ui";
import { fetchConStepUp, verificarMfa } from "../lib/stepup.ts";

interface MfaEstado {
  readonly disponible: boolean;
  readonly obligatoria: boolean;
  readonly inscrito: boolean;
  readonly pendiente: boolean;
  readonly bloqueadoHastaMs: number | null;
}

interface EventoSeguridad {
  readonly id: string;
  readonly seq: number;
  readonly area: "mfa" | "switch" | "org";
  readonly evento: string;
  readonly actorUserId: string | null;
  readonly targetUserId: string | null;
  readonly organizationId: string | null;
  readonly ocurrioEnMs: number;
}

const ETIQUETA_EVENTO: Record<string, string> = {
  mfa_enroll_started: "MFA: enrolamiento iniciado",
  mfa_activated: "MFA: activada",
  mfa_verified: "MFA: verificada",
  mfa_failed: "MFA: código incorrecto",
  mfa_locked: "MFA: bloqueada por intentos",
  mfa_replay: "MFA: código reusado",
  mfa_reset: "MFA: restablecida por otro superadmin",
  switch_set: "Interruptor cambiado",
  org_action_requested: "Organización: acción solicitada",
  org_action_executed: "Organización: acción ejecutada",
  org_action_cancelled: "Organización: acción cancelada",
  org_action_expired: "Organización: acción vencida",
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

const fechaHora = (ms: number) => new Date(ms).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });

export function SuperAdminSeguridadPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [estado, setEstado] = useState<MfaEstado | null>(null);
  const [eventos, setEventos] = useState<readonly EventoSeguridad[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [enrolamiento, setEnrolamiento] = useState<{ secreto: string; otpauthUri: string } | null>(null);
  const [codigo, setCodigo] = useState("");
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const [usuarioId, setUsuarioId] = useState("");
  const [motivo, setMotivo] = useState("");
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      const [e, b] = await Promise.all([
        fetchJson<MfaEstado>(apiBaseUrl, token, "/superadmin/mfa/estado"),
        fetchJson<{ disponible: boolean; eventos: EventoSeguridad[] }>(apiBaseUrl, token, "/superadmin/seguridad/bitacora?limit=50"),
      ]);
      setEstado(e);
      setEventos(b.eventos);
    } catch {
      setError("No se pudo cargar el estado de seguridad.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  async function enrolar() {
    setMensaje(null);
    setTrabajando(true);
    try {
      const r = await fetchJson<{ secreto: string; otpauthUri: string }>(apiBaseUrl, token, "/superadmin/mfa/enrolar", { method: "POST", body: JSON.stringify({}) });
      setEnrolamiento(r);
      setCodigo("");
    } catch (err) {
      setMensaje(err instanceof Error ? err.message : "No se pudo iniciar el enrolamiento.");
    } finally {
      setTrabajando(false);
    }
  }

  async function activar(e: FormEvent) {
    e.preventDefault();
    setMensaje(null);
    const limpio = codigo.replace(/\s+/gu, "");
    if (!/^\d{6}$/u.test(limpio)) {
      setMensaje("El código tiene 6 dígitos.");
      return;
    }
    setTrabajando(true);
    try {
      const r = await verificarMfa(apiBaseUrl, token, limpio);
      if (!r.ok) {
        setMensaje(r.message ?? "Código incorrecto.");
        return;
      }
      setEnrolamiento(null);
      setCodigo("");
      setMensaje(r.activado ? "MFA activada. Las acciones sensibles pedirán tu código." : "Verificación correcta.");
      await cargar();
    } finally {
      setTrabajando(false);
    }
  }

  async function restablecer(e: FormEvent) {
    e.preventDefault();
    setResetMsg(null);
    if (!usuarioId.trim() || motivo.trim().length < 20) {
      setResetMsg("Indica el id del superadmin y un motivo de al menos 20 caracteres.");
      return;
    }
    try {
      await fetchJson(apiBaseUrl, token, "/superadmin/mfa/reset", { method: "POST", body: JSON.stringify({ usuarioId: usuarioId.trim(), motivo }) });
      setResetMsg("Factor restablecido: esa persona debe enrolar de nuevo.");
      setUsuarioId("");
      setMotivo("");
      await cargar();
    } catch (err) {
      setResetMsg(err instanceof Error ? err.message : "No se pudo restablecer.");
    }
  }

  if (error && !estado) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!estado) return <EstadoCargando etiqueta="Cargando seguridad…" />;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div>
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" strokeWidth={1.75} />
          Seguridad (MFA)
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Autenticador TOTP para el superadmin. Las acciones sensibles (impersonar, romper cristal, cambiar topes, interruptores, gestionar organizaciones) piden tu código.
        </p>
      </div>

      {!estado.disponible && (
        <p role="alert" className="text-sm text-muted-foreground">
          La MFA todavía no está disponible en esta base (migración 0025 pendiente de aplicar). Las acciones sensibles siguen funcionando como hasta ahora.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="w-4 h-4" strokeWidth={1.75} />
            Tu autenticador
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {estado.inscrito ? <StatusBadge tone="success">MFA activa</StatusBadge> : <StatusBadge tone={estado.pendiente ? "warning" : "neutral"}>{estado.pendiente ? "Enrolamiento pendiente" : "Sin MFA"}</StatusBadge>}
            {estado.obligatoria && <StatusBadge tone="info">Obligatoria en este despliegue</StatusBadge>}
            {estado.bloqueadoHastaMs && <StatusBadge tone="danger">Bloqueada hasta {fechaHora(estado.bloqueadoHastaMs)}</StatusBadge>}
          </div>

          {estado.disponible && !estado.inscrito && !enrolamiento && (
            <div>
              <Button className="rounded-full" onClick={() => void enrolar()} disabled={trabajando}>
                {estado.pendiente ? "Reiniciar enrolamiento" : "Enrolar autenticador"}
              </Button>
            </div>
          )}

          {enrolamiento && (
            <form onSubmit={activar} className="flex flex-col gap-3 max-w-md">
              <p className="text-sm text-muted-foreground">
                Agrega esta cuenta en tu app autenticadora (Google Authenticator, 1Password, Authy…) con el secreto de abajo o abriendo el enlace, y escribe el primer código para activarla. El secreto se muestra solo ahora.
              </p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-secreto">Secreto</Label>
                <Input id="mfa-secreto" readOnly value={enrolamiento.secreto} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
              </div>
              <a href={enrolamiento.otpauthUri} className="text-sm underline break-all">
                Abrir en mi app autenticadora
              </a>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-codigo">Código de 6 dígitos</Label>
                <Input id="mfa-codigo" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="123456" />
              </div>
              <div>
                <Button type="submit" className="rounded-full" disabled={trabajando}>
                  {trabajando ? "Verificando…" : "Activar MFA"}
                </Button>
              </div>
            </form>
          )}

          {mensaje && (
            <p role="status" className="text-sm text-muted-foreground">
              {mensaje}
            </p>
          )}
        </CardContent>
      </Card>

      {estado.disponible && (
        <Card>
          <CardHeader>
            <CardTitle>Restablecer el factor de otro superadmin</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={restablecer} className="flex flex-col gap-3 max-w-md">
              <p className="text-sm text-muted-foreground">Para quien perdió su dispositivo. No puedes restablecer el tuyo; pide a otro superadmin. Exige tu código MFA y queda en la bitácora.</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-reset-usuario">Id del superadmin</Label>
                <Input id="mfa-reset-usuario" value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} placeholder="uuid del usuario" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-reset-motivo">Motivo (mínimo 20 caracteres)</Label>
                <Textarea id="mfa-reset-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} />
              </div>
              {resetMsg && (
                <p role="status" className="text-sm text-muted-foreground">
                  {resetMsg}
                </p>
              )}
              <div>
                <Button type="submit" variant="outline" className="rounded-full">
                  Restablecer factor
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Bitácora de seguridad</CardTitle>
        </CardHeader>
        <CardContent>
          {eventos.length === 0 ? (
            <EstadoVacio mensaje="Sin eventos de seguridad registrados todavía." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Cuándo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eventos.map((ev) => (
                    <TableRow key={ev.id}>
                      <TableCell className="text-muted-foreground">{ev.seq}</TableCell>
                      <TableCell>{ETIQUETA_EVENTO[ev.evento] ?? ev.evento}</TableCell>
                      <TableCell className="font-mono text-xs">{ev.actorUserId ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fechaHora(ev.ocurrioEnMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

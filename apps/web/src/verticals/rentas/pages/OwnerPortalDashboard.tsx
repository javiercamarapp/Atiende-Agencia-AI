// Dashboard del portal de propietario (Fase 3 backend, UI de esta fase) — superficie
// MÍNIMA de solo lectura: perfil (`GET .../me`), unidades (`GET .../unidades`) y
// statements (`GET .../statements`, `GET .../statements/:id`), consumidos vía
// lib/owner-portal-client.ts. Deliberadamente SIN shell de navegación multi-página
// (a diferencia de RentasShell.tsx, el shell del panel de STAFF): el portal de
// propietario de esta fase es una sola pantalla -- perfil + unidades + statements,
// mismo alcance exacto que expone el backend (owner-portal.ts no tiene más rutas de
// lectura que estas tres). Resuelve la sesión persistida una vez (igual que
// RentasShell) y reacciona a `SESSION_EXPIRED_EVENT` filtrando por la vertical propia
// ("rentas-owner-portal", ver lib/owner-portal-client.ts) para no chocar con la
// sesión de STAFF de rentas abierta en el mismo navegador.
//
// Hallazgo de auditoría (severidad ALTA, "el portal de propietario (owner-portal) no
// tiene logout/revocación real de sesión") -- CERRADO: `handleLogout` ahora llama
// `POST /rentas/owner-portal/auth/logout` (ver owner-portal.ts + owner-portal-client.ts)
// ANTES de borrar la sesión local, revocando de verdad el refresh token del lado del
// servidor (mismo criterio que el logout de staff, `HotelesShell.tsx`/etc.).
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Table/Button/
// StatCard/EstadoCargando/EstadoVacio/EstadoError en vez de los `style={{...}}`
// hechos a mano. CERO cambios de lógica: mismos efectos, mismas llamadas, mismas
// ramas de render (cargando / vacío / con datos / detalle abierto).
import { useEffect, useState } from "react";
import { Building2, FileText, LogOut, Wallet } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  clearOwnerPortalSession,
  fetchOwnerPortalMe,
  fetchOwnerPortalStatementDetalle,
  fetchOwnerPortalStatements,
  fetchOwnerPortalUnidades,
  ownerPortalLogout,
  readPersistedOwnerPortalSession,
} from "../lib/owner-portal-client.ts";
import type { OwnerPortalMe, OwnerPortalSession, OwnerPortalStatementDetalle, OwnerPortalStatementSummary, OwnerPortalUnidad } from "../lib/owner-portal-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../../lib/authed-fetch.ts";

function centavosAPesos(centavos: number): string {
  return (centavos / 100).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface OwnerPortalDashboardPageProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
}

export function OwnerPortalDashboardPage({ apiBaseUrl, onRequireLogin }: OwnerPortalDashboardPageProps) {
  const [session, setSession] = useState<OwnerPortalSession | null | undefined>(undefined);
  const [me, setMe] = useState<OwnerPortalMe | null>(null);
  const [unidades, setUnidades] = useState<readonly OwnerPortalUnidad[] | null>(null);
  const [statements, setStatements] = useState<readonly OwnerPortalStatementSummary[] | null>(null);
  const [detalle, setDetalle] = useState<OwnerPortalStatementDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = readPersistedOwnerPortalSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "rentas-owner-portal") return;
      clearOwnerPortalSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [onRequireLogin]);

  useEffect(() => {
    if (!session) return;
    let cancelado = false;
    (async () => {
      try {
        const [meResult, unidadesResult, statementsResult] = await Promise.all([
          fetchOwnerPortalMe(fetch, apiBaseUrl, session.token),
          fetchOwnerPortalUnidades(fetch, apiBaseUrl, session.token),
          fetchOwnerPortalStatements(fetch, apiBaseUrl, session.token),
        ]);
        if (cancelado) return;
        setMe(meResult);
        setUnidades(unidadesResult);
        setStatements(statementsResult);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar tu información.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, apiBaseUrl]);

  async function verDetalle(statementId: string) {
    if (!session) return;
    setError(null);
    try {
      const d = await fetchOwnerPortalStatementDetalle(fetch, apiBaseUrl, session.token, statementId);
      setDetalle(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle del statement.");
    }
  }

  const [cerrandoSesion, setCerrandoSesion] = useState(false);

  async function handleLogout() {
    if (!session) return;
    setCerrandoSesion(true);
    // Revoca el refresh token del lado del servidor ANTES de borrar localStorage --
    // best-effort (ver comentario de ownerPortalLogout), pero siempre intentado
    // primero para que el logout sea real, no solo local.
    await ownerPortalLogout(fetch, apiBaseUrl, session.refreshToken);
    clearOwnerPortalSession(window.localStorage);
    setSession(null);
    setCerrandoSesion(false);
    onRequireLogin();
  }

  if (session === undefined) return null; // resolviendo sesión persistida
  if (!session) return null; // onRequireLogin ya disparó la redirección

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-[760px] p-6 flex flex-col gap-6">
        <header className="flex justify-between items-start gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Portal de propietario</h1>
            {me && (
              <p className="m-0 text-[13px] text-muted-foreground">
                {me.name} · {me.email ?? "sin correo registrado"}
              </p>
            )}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void handleLogout()} disabled={cerrandoSesion} className="shrink-0 text-destructive">
            <LogOut className="w-4 h-4" strokeWidth={1.75} />
            {cerrandoSesion ? "Cerrando sesión…" : "Cerrar sesión"}
          </Button>
        </header>

        {error && <EstadoError mensaje={error} />}

        {(unidades || statements) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <StatCard icon={Building2} label="Unidades" value={unidades ? String(unidades.length) : "—"} sinDato={unidades ? undefined : "Cargando tus unidades…"} />
            <StatCard icon={FileText} label="Statements" value={statements ? String(statements.length) : "—"} sinDato={statements ? undefined : "Cargando tus statements…"} />
          </div>
        )}

        {me && me.organizaciones.length > 0 && (
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-[15px] font-semibold">Tus empresas gestoras</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <ul className="m-0 pl-5 text-[13px] text-foreground list-disc">
                {me.organizaciones.map((o) => (
                  <li key={o.organizationId}>{o.name}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-[15px] font-semibold">Tus unidades</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {!unidades && <EstadoCargando lineas={2} etiqueta="Cargando tus unidades…" />}
            {unidades && unidades.length === 0 && <EstadoVacio icon={Building2} titulo="Sin unidades" mensaje="Todavía no tienes ninguna unidad registrada." />}
            {unidades && unidades.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9 px-2">Unidad</TableHead>
                    <TableHead className="h-9 px-2">Empresa gestora</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unidades.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="p-2">{u.name}</TableCell>
                      <TableCell className="p-2 text-muted-foreground">{u.organizationName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-[15px] font-semibold">Tus statements</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 flex flex-col gap-3">
            {!statements && <EstadoCargando lineas={2} etiqueta="Cargando tus statements…" />}
            {statements && statements.length === 0 && <EstadoVacio icon={Wallet} titulo="Sin statements" mensaje="Todavía no tienes ningún statement generado." />}
            {statements && statements.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9 px-2">Empresa gestora</TableHead>
                    <TableHead className="h-9 px-2">Periodo</TableHead>
                    <TableHead className="h-9 px-2">Versión</TableHead>
                    <TableHead className="h-9 px-2 text-right">Neto</TableHead>
                    <TableHead className="h-9 px-2" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statements.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="p-2">{s.organizationName}</TableCell>
                      <TableCell className="p-2">
                        {s.periodo.inicio} → {s.periodo.fin}
                      </TableCell>
                      <TableCell className="p-2">v{s.version}</TableCell>
                      <TableCell className="p-2 text-right tabular-nums">
                        {centavosAPesos(s.netoCentavos)} {s.moneda}
                      </TableCell>
                      <TableCell className="p-2">
                        <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => verDetalle(s.id)}>
                          Ver detalle
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {detalle && (
              <Card className="border-dashed">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-[13px] font-semibold">
                    Statement v{detalle.version} — {detalle.periodo.inicio} → {detalle.periodo.fin} ({detalle.organizationName})
                  </CardTitle>
                  {detalle.motivoVersion && <CardDescription className="text-xs">Motivo de esta versión: {detalle.motivoVersion}</CardDescription>}
                </CardHeader>
                <CardContent className="p-4 pt-0 flex flex-col gap-2">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
                        <TableHead className="h-8 px-2 text-xs">Tipo</TableHead>
                        <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detalle.lineas.map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="p-2 text-xs">{l.ocupacionId}</TableCell>
                          <TableCell className="p-2 text-xs">{l.tipo}</TableCell>
                          <TableCell className="p-2 text-xs text-right tabular-nums">
                            {centavosAPesos(l.montoCentavos)} {detalle.moneda}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="flex justify-between text-[13px] font-bold text-foreground">
                    <span>Neto</span>
                    <span className="tabular-nums">
                      {centavosAPesos(detalle.totales.netoCentavos)} {detalle.moneda}
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

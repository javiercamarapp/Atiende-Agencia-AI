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
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
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

const sectionStyle: CSSProperties = { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 };
const secondaryButtonStyle: CSSProperties = { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" };
const logoutButtonStyle: CSSProperties = { padding: "8px 12px", borderRadius: 8, fontSize: 13, color: "#b91c1c", background: "transparent", border: "1px solid #fecaca", cursor: "pointer" };
const errorStyle: CSSProperties = { color: "#b91c1c", margin: 0, fontSize: 13 };

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
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", gap: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Portal de propietario</h1>
          {me && (
            <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>
              {me.name} · {me.email ?? "sin correo registrado"}
            </p>
          )}
        </div>
        <button type="button" onClick={() => void handleLogout()} disabled={cerrandoSesion} style={logoutButtonStyle}>
          {cerrandoSesion ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </header>

      {error && <p role="alert" style={errorStyle}>{error}</p>}

      {me && me.organizaciones.length > 0 && (
        <section style={sectionStyle}>
          <h2 style={{ fontSize: 15, margin: 0 }}>Tus empresas gestoras</h2>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {me.organizaciones.map((o) => (
              <li key={o.organizationId}>{o.name}</li>
            ))}
          </ul>
        </section>
      )}

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tus unidades</h2>
        {!unidades && <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>Cargando…</p>}
        {unidades && unidades.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Todavía no tienes ninguna unidad registrada.</p>}
        {unidades && unidades.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 0" }}>Unidad</th>
                <th style={{ padding: "4px 0" }}>Empresa gestora</th>
              </tr>
            </thead>
            <tbody>
              {unidades.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px 0" }}>{u.name}</td>
                  <td style={{ padding: "4px 0" }}>{u.organizationName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Tus statements</h2>
        {!statements && <p style={{ color: "#6b7280", fontSize: 13, margin: 0 }}>Cargando…</p>}
        {statements && statements.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Todavía no tienes ningún statement generado.</p>}
        {statements && statements.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "4px 0" }}>Empresa gestora</th>
                <th style={{ padding: "4px 0" }}>Periodo</th>
                <th style={{ padding: "4px 0" }}>Versión</th>
                <th style={{ padding: "4px 0", textAlign: "right" }}>Neto</th>
                <th style={{ padding: "4px 0" }}></th>
              </tr>
            </thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px 0" }}>{s.organizationName}</td>
                  <td style={{ padding: "4px 0" }}>
                    {s.periodo.inicio} → {s.periodo.fin}
                  </td>
                  <td style={{ padding: "4px 0" }}>v{s.version}</td>
                  <td style={{ padding: "4px 0", textAlign: "right" }}>
                    {centavosAPesos(s.netoCentavos)} {s.moneda}
                  </td>
                  <td style={{ padding: "4px 0" }}>
                    <button type="button" onClick={() => verDetalle(s.id)} style={secondaryButtonStyle}>
                      Ver detalle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {detalle && (
          <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
              Statement v{detalle.version} — {detalle.periodo.inicio} → {detalle.periodo.fin} ({detalle.organizationName})
            </p>
            {detalle.motivoVersion && <p style={{ margin: 0, fontSize: 12, color: "#6b7280" }}>Motivo de esta versión: {detalle.motivoVersion}</p>}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={{ padding: "4px 0" }}>Reserva</th>
                  <th style={{ padding: "4px 0" }}>Tipo</th>
                  <th style={{ padding: "4px 0", textAlign: "right" }}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {detalle.lineas.map((l, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "4px 0" }}>{l.ocupacionId}</td>
                    <td style={{ padding: "4px 0" }}>{l.tipo}</td>
                    <td style={{ padding: "4px 0", textAlign: "right" }}>
                      {centavosAPesos(l.montoCentavos)} {detalle.moneda}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}>
              <span>Neto</span>
              <span>
                {centavosAPesos(detalle.totales.netoCentavos)} {detalle.moneda}
              </span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

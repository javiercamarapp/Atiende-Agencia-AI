// Activación del portal de propietario (Fase 3 backend, UI de esta fase) —
// consume el token de invitación de un solo uso que staff emite desde Finanzas.tsx
// ("Invitar a este propietario", ver finanzas-client.ts::invitarPropietarioAlPortal)
// vía `POST /rentas/owner-portal/auth/set-password` (owner-portal.ts). Mismo patrón
// visual que shell/AceptarInvitacion.tsx (aceptar invitación de STAFF), pero más
// simple: el propietario ya existe en `rentas.owner` (lo dio de alta staff), así que
// esta pantalla solo fija su contraseña -- no pide nombre. La respuesta del servidor
// es `{ok:true}`, sin sesión (a diferencia de aceptar invitación de staff): el
// propietario hace login por separado justo después, con el correo que staff ya
// registró.
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { OwnerPortalError, ownerPortalActivar } from "../lib/owner-portal-client.ts";

export interface OwnerPortalActivarPageProps {
  readonly apiBaseUrl: string;
}

export function OwnerPortalActivarPage({ apiBaseUrl }: OwnerPortalActivarPageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState(searchParams.get("token") ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await ownerPortalActivar(fetch, apiBaseUrl, token, password, confirmPassword);
      navigate("/rentas/portal-propietario/login", { state: { activada: true } });
    } catch (err) {
      setError(err instanceof OwnerPortalError ? err.message : "Ocurrió un error inesperado. Intenta de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <form onSubmit={handleSubmit} style={{ width: "min(400px, 90vw)", display: "flex", flexDirection: "column", gap: 12 }} noValidate>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Activa tu cuenta de propietario</h1>
        <p style={{ margin: "0 0 4px", fontSize: 13, color: "#6b7280" }}>Pega el token que te compartió tu administrador y fija tu contraseña para entrar al portal.</p>
        <label htmlFor="token">
          Token de invitación
          <input
            id="token"
            type="text"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4, fontFamily: "monospace", fontSize: 13 }}
          />
        </label>
        <label htmlFor="password">
          Contraseña (mínimo 8 caracteres)
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label htmlFor="confirmPassword">
          Confirma tu contraseña
          <input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        {error && (
          <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting} style={{ padding: 10, fontWeight: 600 }}>
          {submitting ? "Activando…" : "Activar y continuar a iniciar sesión"}
        </button>
      </form>
    </main>
  );
}

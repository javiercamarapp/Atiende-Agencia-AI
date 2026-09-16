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
//
// Ronda de portado del sistema de diseño real: misma lámina partida que
// OwnerPortalLogin.tsx/Login.tsx (apps/web/src/pages/login.css) en vez del <form>
// con estilos inline. CERO cambios de lógica: mismo endpoint, mismo navigate con
// `state.activada`, mismo manejo de error.
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AtiendeWordmark, Button, Label } from "@atiende/ui";
import { OwnerPortalError, ownerPortalActivar } from "../lib/owner-portal-client.ts";
import "../../../pages/login.css";

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
    <main className="login min-h-screen w-full flex flex-col md:flex-row">
      {/* Columna izquierda: formulario real */}
      <div className="w-full md:w-[46%] flex flex-col justify-center px-6 sm:px-10 lg:px-16 py-12">
        <div className="mx-auto w-full max-w-sm flex flex-col gap-7">
          <div className="login-entra" style={{ animationDelay: "0s" }}>
            <AtiendeWordmark className="h-7 w-auto" />
          </div>

          <div className="login-entra flex flex-col gap-2" style={{ animationDelay: "0.05s" }}>
            <span className="login-kicker">Invitación de propietario</span>
            <h1 className="login-serif text-foreground text-[32px] sm:text-[38px]">Activa tu cuenta de propietario</h1>
            <p className="text-[14px] text-muted-foreground leading-snug">
              Pega el token que te compartió tu administrador y fija tu contraseña para entrar al portal.
            </p>
          </div>

          <form onSubmit={handleSubmit} noValidate className="login-entra flex flex-col gap-3" style={{ animationDelay: "0.1s" }}>
            <Label htmlFor="token" className="flex flex-col gap-1.5 text-[13px] text-foreground">
              Token de invitación
              <input
                id="token"
                type="text"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                className="login-campo font-mono text-[13px]"
              />
            </Label>
            <Label htmlFor="password" className="flex flex-col gap-1.5 text-[13px] text-foreground">
              Contraseña (mínimo 8 caracteres)
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="login-campo"
              />
            </Label>
            <Label htmlFor="confirmPassword" className="flex flex-col gap-1.5 text-[13px] text-foreground">
              Confirma tu contraseña
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="login-campo"
              />
            </Label>

            {error && (
              <p role="alert" className="text-[13px] text-destructive m-0">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Activando…" : "Activar y continuar a iniciar sesión"}
            </Button>
          </form>
        </div>
      </div>

      {/* Columna derecha: lámina con foto real (Ken Burns) -- oculta en mobile */}
      <aside className="login-lamina hidden md:block md:w-[54%] relative m-3 rounded-[22px] overflow-hidden">
        <img src="/images/login-hero.png" alt="" className="login-foto-marca absolute inset-0 h-full w-full object-cover" />
        <div className="login-velo" />
        <div className="absolute inset-x-0 bottom-0 p-10 lg:p-14 text-white">
          <p className="login-kicker text-white/70 mb-3">Un solo paso</p>
          <p className="login-serif text-2xl lg:text-3xl leading-snug max-w-md">
            Fija tu contraseña una vez y consulta desde ahí cada statement de tus unidades.
          </p>
        </div>
      </aside>
    </main>
  );
}

// Login del portal de propietario (Fase 3 backend, UI de esta fase) — cierra el
// hallazgo "el backend de owner-portal.ts existe pero ninguna superficie de apps/web
// lo consume". Mismo patrón visual que verticals/rentas/pages/Login.tsx (el login de
// STAFF), pero llama al endpoint del portal de propietario
// (`POST /rentas/owner-portal/auth/login`, ver lib/owner-portal-client.ts) y persiste
// su propia sesión bajo su propia llave de storage — nunca comparte sesión ni
// endpoint con el login de staff (identidades y JWT/secreto completamente distintos,
// ver la cabecera de owner-portal.ts).
//
// Ronda de portado del sistema de diseño real: adopta la MISMA lámina partida que
// Login.tsx (apps/web/src/pages/login.css) en vez del <form> con estilos inline.
// Deliberadamente SIN "Continuar con Google": el OAuth de Google es exclusivo del
// login de STAFF (ver lib/google-auth.ts, que arranca el flujo con una vertical de
// staff) — el propietario entra siempre con el correo que staff registró y la
// contraseña que él mismo fijó al activar su cuenta. CERO cambios en la lógica de
// autenticación: mismo endpoint, misma sesión, mismo manejo de error.
import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { AtiendeWordmark, Button, Label } from "@atiende/ui";
import { OwnerPortalError, ownerPortalLogin, persistOwnerPortalSession } from "../lib/owner-portal-client.ts";
import type { OwnerPortalSession } from "../lib/owner-portal-client.ts";
import "../../../pages/login.css";

export interface OwnerPortalLoginPageProps {
  readonly apiBaseUrl: string;
  readonly onLoggedIn: (session: OwnerPortalSession) => void;
}

export function OwnerPortalLoginPage({ apiBaseUrl, onLoggedIn }: OwnerPortalLoginPageProps) {
  // `state.activada` lo pone OwnerPortalActivarPage tras un set-password exitoso (ver
  // su navigate()) -- puramente informativo, nunca afecta el submit.
  const location = useLocation();
  const activada = Boolean((location.state as { activada?: boolean } | null)?.activada);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await ownerPortalLogin(fetch, apiBaseUrl, email, password);
      persistOwnerPortalSession(window.localStorage, session);
      onLoggedIn(session);
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
            <span className="login-kicker">Acceso de propietario</span>
            <h1 className="login-serif text-foreground text-[32px] sm:text-[38px]">Portal de propietario</h1>
            <p className="text-[14px] text-muted-foreground leading-snug">Consulta tus unidades y tus statements de renta.</p>
          </div>

          {activada && (
            <p className="login-entra m-0 rounded-xl border border-border bg-muted px-3 py-2 text-[13px] text-foreground">
              Cuenta activada. Ya puedes iniciar sesión con tu correo y la contraseña que acabas de fijar.
            </p>
          )}

          <form onSubmit={handleSubmit} noValidate className="login-entra flex flex-col gap-3" style={{ animationDelay: "0.1s" }}>
            <Label htmlFor="email" className="flex flex-col gap-1.5 text-[13px] text-foreground">
              Correo
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="login-campo"
              />
            </Label>
            <Label htmlFor="password" className="flex flex-col gap-1.5 text-[13px] text-foreground">
              Contraseña
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="login-campo"
              />
            </Label>

            {error && (
              <p role="alert" className="text-[13px] text-destructive m-0">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? "Entrando…" : "Entrar"}
            </Button>
          </form>

          <p className="login-entra text-[13px] text-muted-foreground m-0" style={{ animationDelay: "0.15s" }}>
            ¿Recibiste una invitación de tu administrador?{" "}
            <Link to="/rentas/portal-propietario/activar" className="text-foreground font-medium underline underline-offset-2">
              Activa tu cuenta aquí
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Columna derecha: lámina con foto real (Ken Burns) -- oculta en mobile */}
      <aside className="login-lamina hidden md:block md:w-[54%] relative m-3 rounded-[22px] overflow-hidden">
        <img src="/images/login-hero.png" alt="" className="login-foto-marca absolute inset-0 h-full w-full object-cover" />
        <div className="login-velo" />
        <div className="absolute inset-x-0 bottom-0 p-10 lg:p-14 text-white">
          <p className="login-kicker text-white/70 mb-3">Transparencia para el dueño</p>
          <p className="login-serif text-2xl lg:text-3xl leading-snug max-w-md">
            Tus unidades, tus periodos y el neto de cada statement — la misma información que ve tu empresa gestora.
          </p>
        </div>
      </aside>
    </main>
  );
}

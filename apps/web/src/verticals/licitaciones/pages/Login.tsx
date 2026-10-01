// Pantalla de login del panel de licitaciones — passwordless (Google o "Continuar con
// correo" / magic link), mismo criterio de UX que Likida. PR-9 del plan de diseño-ux: ya
// no es una copia de la pantalla, usa el <VerticalLogin> unificado y solo aporta el copy
// y la imagen de licitaciones. `POST /auth/login` (email+password) sigue existiendo en el
// backend (lo usan `accept-invite` y los tests), pero esta pantalla nunca lo expone.
import type { LoginSession } from "../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface LicitacionesLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function LicitacionesLoginPage({ apiBaseUrl }: LicitacionesLoginPageProps) {
  useDocumentTitle("Licitaciones");
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="licitaciones"
      nombre="licitaciones"
      descripcion="Da seguimiento a cada convocatoria pública y no pierdas ninguna fecha límite."
      placeholderCorreo="tu@empresa.com"
      hero={{
        imagen: "images/login-hero-licitaciones.jpg",
        alt: "Archivo de expedientes gubernamentales al atardecer.",
        kicker: "Convocatorias rastreadas y respondidas a tiempo",
        texto: (
          <>
            El agente rastrea la convocatoria, evalúa el matching
            <br />
            y no deja pasar ninguna fecha límite.
          </>
        ),
      }}
    />
  );
}

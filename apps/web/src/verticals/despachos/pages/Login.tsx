// Pantalla de login del panel de despachos — passwordless (Google o "Continuar con
// correo" / magic link), mismo criterio de UX que Likida. PR-8 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado y
// solo aporta el copy y la imagen de despachos. `POST /auth/login`
// (email+password) sigue existiendo en el backend (lo usan `accept-invite` y los
// tests), pero esta pantalla nunca lo expone.
import type { LoginSession } from "../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface DespachosLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function DespachosLoginPage({ apiBaseUrl }: DespachosLoginPageProps) {
  useDocumentTitle("Despachos");
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="despachos"
      nombre="despachos"
      descripcion="El panel de operación de tu despacho contable."
      placeholderCorreo="tu@despacho.com"
      hero={{
        imagen: "images/login-hero-despachos.jpg",
        alt: "Oficina contable al atardecer.",
        kicker: "CFDI · Contabilidad electrónica · Cierres mensuales",
        texto: (
          <>
            El agente concilia cada CFDI, timbra la nómina
            <br />
            y cierra el mes — sin captura manual.
          </>
        ),
      }}
    />
  );
}

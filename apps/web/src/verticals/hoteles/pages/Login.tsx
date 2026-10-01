// Pantalla de login del panel de hoteles — passwordless (Google o "Continuar con
// correo" / magic link), mismo criterio de UX que Likida. PR-6 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado y
// solo aporta el copy y la imagen de hoteles. `POST /auth/login` (email+password)
// sigue existiendo en el backend (lo usan `accept-invite` y los tests), pero esta
// pantalla nunca lo expone.
import type { LoginSession } from "../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface HotelesLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva en el
   *  tipo porque `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function HotelesLoginPage({ apiBaseUrl }: HotelesLoginPageProps) {
  useDocumentTitle("Hoteles");
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="hoteles"
      nombre="hoteles"
      descripcion="El panel de operación de tu hotel."
      placeholderCorreo="tu@hotel.com"
      hero={{
        imagen: "images/login-hero-hoteles.jpg",
        alt: "Hotel de playa en Cancún al atardecer.",
        kicker: "Reservas y operación por WhatsApp",
        texto: (
          <>
            El agente toma la reserva, hace el check-in,
            <br />
            factura y cierra el turno — todo por WhatsApp.
          </>
        ),
      }}
    />
  );
}

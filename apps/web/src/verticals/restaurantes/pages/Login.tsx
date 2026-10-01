// Pantalla de login del panel de restaurantes — passwordless (Google o "Continuar
// con correo" / magic link), mismo criterio de UX que Likida. PR-5 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado y
// solo aporta el copy y la imagen de restaurantes. `POST /auth/login`
// (email+password) sigue existiendo en el backend (lo usan `accept-invite` y los
// tests), pero esta pantalla nunca lo expone.
import type { LoginSession } from "../../../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface LoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RestaurantesLoginPage({ apiBaseUrl }: LoginPageProps) {
  useDocumentTitle("Restaurantes");
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="restaurantes"
      nombre="restaurantes"
      descripcion="El panel de operación de tu restaurante."
      placeholderCorreo="tu@restaurante.com"
      hero={{
        imagen: "images/login-hero-restaurantes.jpg",
        alt: "Taquero cortando trompo al pastor de noche.",
        kicker: "Pedidos por WhatsApp, sin fricción",
        texto: (
          <>
            El agente toma el pedido, lo manda a cocina,
            <br />
            cobra y cierra la caja — todo por WhatsApp.
          </>
        ),
      }}
    />
  );
}

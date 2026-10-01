// Pantalla de login del panel de rentas — passwordless (Google o "Continuar con
// correo" / magic link), mismo criterio de UX que Likida. PR-7 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado y
// solo aporta el copy, la imagen y el pie de rentas. Rentas es la única vertical con
// alta autoservicio (`/rentas/registro`), así que conserva ese enlace en el pie.
// `POST /auth/login` (email+password) sigue existiendo en el backend (lo usan
// `accept-invite` y los tests), pero esta pantalla nunca lo expone.
import { Link } from "react-router-dom";
import type { LoginSession } from "../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";

export interface RentasLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva en el
   *  tipo porque `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RentasLoginPage({ apiBaseUrl }: RentasLoginPageProps) {
  useDocumentTitle("Rentas");
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="rentas"
      nombre="rentas"
      descripcion="El panel de operación de tus propiedades."
      placeholderCorreo="tu@propiedad.com"
      pie={
        <>
          ¿No tienes cuenta?{" "}
          <Link to="/rentas/registro" className="font-semibold text-foreground underline underline-offset-2">
            Créala aquí
          </Link>
          .
        </>
      }
      hero={{
        imagen: "images/login-hero-rentas.jpg",
        alt: "Casas victorianas de San Francisco al atardecer.",
        kicker: "Operación multi-propiedad",
        texto: (
          <>
            El agente responde al huésped, sincroniza
            <br />
            Booking, Airbnb y Vrbo, y coordina el check-in.
          </>
        ),
      }}
    />
  );
}

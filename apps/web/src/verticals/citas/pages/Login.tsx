// Pantalla de login del panel de citas — passwordless (Google o "Continuar con
// correo" / magic link), mismo criterio de UX que Likida. PR-4 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado
// y solo aporta el copy y la imagen de citas. `POST /auth/login` (email+password)
// sigue existiendo en el backend, pero esta pantalla nunca lo expone. El botón de
// Google es el de INICIO DE SESIÓN de staff (distinto de la sincronización con
// Google Calendar de citas, que ya es real en
// apps/api/src/routes/verticals/citas/google-calendar-*.ts).
import type { LoginSession } from "../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";

export interface CitasLoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function CitasLoginPage({ apiBaseUrl }: CitasLoginPageProps) {
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="citas"
      nombre="citas"
      descripcion="El panel de operación de tu negocio de citas."
      hero={{
        imagen: "images/login-hero-citas.jpg",
        alt: "Sala de espera de un salón vacía en la hora azul.",
        kicker: "Citas y turnos por WhatsApp",
        texto: (
          <>
            El agente agenda, confirma, reagenda
            <br />
            y sincroniza tu Google Calendar solo.
          </>
        ),
      }}
    />
  );
}

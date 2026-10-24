// Pantalla de login del panel de restaurantes — passwordless (Google o "Continuar
// con correo" / magic link), mismo criterio de UX que Likida. PR-5 del plan de
// diseño-ux: ya no es una copia de la pantalla, usa el <VerticalLogin> unificado y
// solo aporta el copy y la imagen de restaurantes. `POST /auth/login`
// (email+password) sigue existiendo en el backend (lo usan `accept-invite` y los
// tests), pero esta pantalla nunca lo expone.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { VerticalLogin } from "../../../components/VerticalLogin.tsx";
import { useDocumentTitle } from "../../../shell/use-document-title.ts";
import { consultarDisponibilidadLoginCelular } from "../lib/login-telefono-client.ts";

export interface LoginPageProps {
  readonly apiBaseUrl: string;
  /** Nunca se llama desde aquí (login 100% passwordless: Google/magic link
   *  redirigen la página completa vía `GoogleCallbackPage`) — se conserva porque
   *  `App.tsx` sigue pasándolo. */
  readonly onLoggedIn: (session: LoginSession, landingPath: string) => void;
}

export function RestaurantesLoginPage({ apiBaseUrl }: LoginPageProps) {
  useDocumentTitle("Restaurantes");
  // El acceso de repartidores por celular solo se ofrece cuando el servidor lo tiene encendido (bandera + plantilla aprobada); si no, no hay enlace.
  const [conCelular, setConCelular] = useState(false);
  useEffect(() => {
    let vivo = true;
    void consultarDisponibilidadLoginCelular(fetch, apiBaseUrl).then((ok) => {
      if (vivo) setConCelular(ok);
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl]);
  return (
    <VerticalLogin
      apiBaseUrl={apiBaseUrl}
      vertical="restaurantes"
      nombre="restaurantes"
      descripcion="El panel de operación de tu restaurante."
      placeholderCorreo="tu@correo.com"
      pie={
        <>
          ¿Tu correo no tiene acceso? <span className="font-semibold text-foreground">Pídele a tu restaurante que te dé de alta.</span>
          {conCelular ? (
            <>
              {" "}
              <Link to="/restaurantes/acceso-repartidor" className="font-semibold text-foreground underline underline-offset-2">
                Soy repartidor: entrar con mi celular
              </Link>
            </>
          ) : null}
        </>
      }
      hero={{
        lamina: true,
        imagen: "images/login-hero-restaurantes-lamina.jpg",
        laminaAncho: 880,
        laminaAlto: 1168,
        alt: "Taquero cortando trompo de pastor en un puesto de noche, con clientes sonriendo a su alrededor.",
        kicker: "Pedidos por voz y WhatsApp",
        texto: (
          <>
            Restaurantes en México.
            <br />
            El cierre del turno, solo.
          </>
        ),
        laminaEn: {
          kicker: "Orders by voice and WhatsApp",
          alt: "Taquero slicing al pastor meat at a night-time stand, with smiling customers around him.",
          texto: (
            <>
              Restaurants in Mexico.
              <br />
              Closing the shift, on its own.
            </>
          ),
        },
      }}
    />
  );
}

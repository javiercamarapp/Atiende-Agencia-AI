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
      placeholderCorreo="tu@restaurante.com"
      pie={
        conCelular ? (
          <>
            ¿Tu correo no tiene acceso? <span className="font-semibold text-foreground">Pídele a tu negocio que te dé de alta.</span>{" "}
            <Link to="/restaurantes/acceso-repartidor" className="font-semibold text-foreground underline underline-offset-2">
              Soy repartidor: entrar con mi celular
            </Link>
          </>
        ) : undefined
      }
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

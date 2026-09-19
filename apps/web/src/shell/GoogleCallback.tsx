// Página compartida de retorno de "Sign in with Google" — el backend real
// (`apps/api/src/routes/auth-google.ts`) redirige aquí (`/${vertical}/auth/google/
// callback?code=...`) tras un login exitoso. Mismo puente para magic-link
// (`apps/api/src/routes/auth-magic-link.ts::GET /auth/magic-link/verify` redirige
// exactamente aquí también, ver su propio comentario de cabecera). Compartida por
// las 6 verticales (una sola implementación, en vez de duplicar este mismo puente en
// cada Login.tsx) porque la única diferencia real entre verticales es QUÉ función
// persist/decide-landing-path usar — ver el switch de abajo, que importa las 6 sin
// ningún efecto secundario en el import en sí (funciones puras, mismo criterio que
// ya documenta `hoteles/lib/auth-client.ts`).
//
// Hallazgo de auditoría (P2, "tokens de sesión completos en query params de URL --
// riesgo de filtración vía Referer/historial/logs") — ver el comentario de cabecera
// de `packages/db/migrations/0008_auth_exchange_code.sql`. Hasta esta pieza, el
// backend ponía el `token`/`refreshToken` REALES directamente en esta URL; ahora
// pone un `code` opaco de un solo uso (60s de vida) que esta página canjea de
// inmediato, al montar, vía `POST /auth/exchange-code` — el token/refreshToken
// reales solo viajan en el BODY de esa respuesta JSON, nunca en una URL.
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EstadoCargando, EstadoError } from "@atiende/ui";
import type { LoginSession } from "../lib/auth-client.ts";
import { decideLandingPath, persistSession } from "../lib/auth-client.ts";
import { decideHotelesLandingPath, persistHotelesSession } from "../verticals/hoteles/lib/auth-client.ts";
import { decideCitasLandingPath, persistCitasSession } from "../verticals/citas/lib/auth-client.ts";
import { decideLicitacionesLandingPath, persistLicitacionesSession } from "../verticals/licitaciones/lib/auth-client.ts";
import { decideDespachosLandingPath, persistDespachosSession } from "../verticals/despachos/lib/auth-client.ts";
import { decideRentasLandingPath, persistRentasSession } from "../verticals/rentas/lib/auth-client.ts";
import { persistSuperadminSession } from "../superadmin/lib/auth-client.ts";

const POR_VERTICAL: Record<string, { decide: (s: LoginSession) => string; persist: (storage: Storage, s: LoginSession) => void }> = {
  restaurantes: { decide: decideLandingPath, persist: persistSession },
  hoteles: { decide: decideHotelesLandingPath, persist: persistHotelesSession },
  citas: { decide: decideCitasLandingPath, persist: persistCitasSession },
  licitaciones: { decide: decideLicitacionesLandingPath, persist: persistLicitacionesSession },
  despachos: { decide: decideDespachosLandingPath, persist: persistDespachosSession },
  rentas: { decide: decideRentasLandingPath, persist: persistRentasSession },
};

export function GoogleCallbackPage({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { vertical } = useParams<{ vertical: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // Evita un doble canje si React StrictMode monta el efecto dos veces en
  // desarrollo -- el `code` de la URL es de un solo uso REAL (el backend lo
  // invalida en el primer canje, ver `core.consume_auth_exchange_code`); un
  // segundo intento con el mismo código fallaría honestamente, así que esto
  // también evita ese error espurio además de no navegar dos veces.
  const yaProcesado = useRef(false);

  useEffect(() => {
    if (yaProcesado.current) return;
    yaProcesado.current = true;

    const config = vertical ? POR_VERTICAL[vertical] : undefined;
    if (!config) {
      setError("Vertical desconocida.");
      return;
    }

    const code = searchParams.get("code");
    if (!code) {
      setError("Google no devolvió una sesión válida. Vuelve a intentarlo desde el login.");
      return;
    }

    void (async () => {
      try {
        // Canjea el código opaco de un solo uso por la sesión real -- ver el
        // comentario de cabecera del archivo. El token/refreshToken reales
        // NUNCA viajan en la URL, solo en el body de esta respuesta.
        const exchangeRes = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/exchange-code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (!exchangeRes.ok) throw new Error("no se pudo canjear el código de la sesión");
        const { token, refreshToken } = (await exchangeRes.json()) as { token: string; refreshToken: string };

        const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("no se pudo resolver la sesión");
        const body = (await res.json()) as { email: string; fullName?: string; organizations: LoginSession["organizations"]; isPlatformSuperadmin?: boolean };
        const session: LoginSession = { token, refreshToken, email: body.email, fullName: body.fullName ?? "", organizations: body.organizations };
        // Back office de plataforma — sin importar por cuál de las 6
        // verticales entró (Google/magic link no distinguen), un superadmin
        // real SIEMPRE aterriza en /superadmin, nunca en el landing normal de
        // esa vertical.
        if (body.isPlatformSuperadmin) {
          persistSuperadminSession(window.localStorage, session);
          navigate("/superadmin", { replace: true });
          return;
        }
        config.persist(window.localStorage, session);
        navigate(config.decide(session), { replace: true });
      } catch {
        setError("No se pudo completar el inicio de sesión con Google. Vuelve a intentarlo.");
      }
    })();
  }, [apiBaseUrl, navigate, searchParams, vertical]);

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background px-6">
        <EstadoError titulo="No se pudo iniciar sesión" mensaje={error} onReintentar={() => navigate(`/${vertical ?? ""}/login`, { replace: true })} />
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-6">
      <EstadoCargando etiqueta="Completando el inicio de sesión con Google…" />
    </main>
  );
}

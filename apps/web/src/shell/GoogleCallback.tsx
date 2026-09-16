// Página compartida de retorno de "Sign in with Google" — el backend real
// (`apps/api/src/routes/auth-google.ts`) redirige aquí (`/${vertical}/auth/google/
// callback?token=...&refreshToken=...`) tras un login exitoso. Compartida por las 6
// verticales (una sola implementación, en vez de duplicar este mismo puente en cada
// Login.tsx) porque la única diferencia real entre verticales es QUÉ función
// persist/decide-landing-path usar — ver el switch de abajo, que importa las 6 sin
// ningún efecto secundario en el import en sí (funciones puras, mismo criterio que
// ya documenta `hoteles/lib/auth-client.ts`).
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
  // Evita un doble intercambio si React StrictMode monta el efecto dos veces en
  // desarrollo -- el token/refreshToken de la URL son de un solo uso conceptual
  // (ya emitidos), pero /auth/me sí puede llamarse dos veces sin efecto adverso;
  // esto es solo para no navegar dos veces.
  const yaProcesado = useRef(false);

  useEffect(() => {
    if (yaProcesado.current) return;
    yaProcesado.current = true;

    const config = vertical ? POR_VERTICAL[vertical] : undefined;
    if (!config) {
      setError("Vertical desconocida.");
      return;
    }

    const token = searchParams.get("token");
    const refreshToken = searchParams.get("refreshToken");
    if (!token || !refreshToken) {
      setError("Google no devolvió una sesión válida. Vuelve a intentarlo desde el login.");
      return;
    }

    void (async () => {
      try {
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

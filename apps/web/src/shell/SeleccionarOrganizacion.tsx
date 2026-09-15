// Página real de "2+ organizaciones" — ver comentario de cabecera de
// SinOrganizacion.tsx: mismo hueco (ruta nunca registrada, pantalla en blanco),
// mismo criterio de solución. Un staff con 2+ organizaciones (p. ej. una empresa
// gestora de rentas que administra propiedades de más de un anfitrión/tenant, ver
// decideRentasLandingPath) necesita elegir a cuál entrar antes de que el panel
// pueda navegar a `/<vertical>/<slug>`.
//
// La sesión completa (con la lista real de `organizations`) ya quedó persistida en
// localStorage por la página de login ANTES de navegar aquí (persistRentasSession/
// persistHotelesSession/etc. siempre corren primero) — lo único que este componente
// genérico no puede adivinar por sí solo es DE QUÉ vertical es esta sesión (cada
// vertical usa su propia llave de storage). Por eso `App.tsx::RentasLoginRoute`
// pasa `{ session, vertical }` por `location.state` al navegar — mismo patrón que
// SinOrganizacion.tsx. Si esa información no está presente (p. ej. recarga directa
// de esta URL), se degrada a un mensaje real en vez de una pantalla en blanco o un
// crash — nunca un stub silencioso.
import { useLocation, useNavigate } from "react-router-dom";
import { decideOrganizacionSeleccionadaPath } from "../lib/auth-client.ts";
import type { LoginSession } from "../lib/auth-client.ts";

interface SeleccionarOrganizacionState {
  readonly session?: LoginSession;
  readonly vertical?: string;
}

export function SeleccionarOrganizacionPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state ?? null) as SeleccionarOrganizacionState | null;

  if (!state?.session || !state.vertical) {
    return (
      <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <p style={{ maxWidth: 420, textAlign: "center", color: "#6b7280" }}>
          No pudimos recuperar tu sesión para mostrarte tus organizaciones. Vuelve a iniciar sesión e inténtalo de nuevo.
        </p>
      </main>
    );
  }

  const { session, vertical } = state;
  const organizaciones = session.organizations.filter((o) => o.vertical === vertical);

  if (organizaciones.length === 0) {
    return (
      <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <p style={{ maxWidth: 420, textAlign: "center", color: "#6b7280" }}>No encontramos ninguna organización de {vertical} en tu cuenta.</p>
      </main>
    );
  }

  return (
    <main style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <div style={{ width: "min(420px, 90vw)", display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Elige una organización</h1>
        <p style={{ color: "#6b7280", margin: 0 }}>Tu cuenta pertenece a más de una organización de {vertical}.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {organizaciones.map((org) => (
            <button
              key={org.id}
              type="button"
              onClick={() => navigate(decideOrganizacionSeleccionadaPath(vertical, org))}
              style={{ textAlign: "left", padding: "12px 16px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#fff", cursor: "pointer", fontSize: 15 }}
            >
              <div style={{ fontWeight: 600 }}>{org.nombre}</div>
              <div style={{ fontSize: 13, color: "#6b7280" }}>rol: {org.rol}</div>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

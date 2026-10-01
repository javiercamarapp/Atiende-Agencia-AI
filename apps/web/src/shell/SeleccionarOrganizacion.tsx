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
import { Button } from "@atiende/ui";
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
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
        <p className="max-w-md text-center text-muted-foreground">
          No pudimos recuperar tu sesión para mostrarte tus organizaciones. Vuelve a iniciar sesión e inténtalo de nuevo.
        </p>
      </main>
    );
  }

  const { session, vertical } = state;
  const organizaciones = session.organizations.filter((o) => o.vertical === vertical);

  if (organizaciones.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
        <p className="max-w-md text-center text-muted-foreground">No encontramos ninguna organización de {vertical} en tu cuenta.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="flex w-full max-w-md flex-col gap-3">
        <h1 className="text-xl font-semibold">Elige una organización</h1>
        <p className="text-muted-foreground">Tu cuenta pertenece a más de una organización de {vertical}.</p>
        <div className="flex flex-col gap-2">
          {organizaciones.map((org) => (
            <Button
              key={org.id}
              type="button"
              variant="outline"
              onClick={() => navigate(decideOrganizacionSeleccionadaPath(vertical, org))}
              className="h-auto flex-col items-start gap-0 px-4 py-3 text-left"
            >
              <span className="font-semibold">{org.nombre}</span>
              <span className="text-sm font-normal text-muted-foreground">rol: {org.rol}</span>
            </Button>
          ))}
        </div>
      </div>
    </main>
  );
}

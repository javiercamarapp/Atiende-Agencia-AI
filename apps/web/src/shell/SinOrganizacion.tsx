// Página real de "0 organizaciones" — ver comentario de cabecera de
// decideRentasLandingPath (apps/web/src/verticals/rentas/lib/auth-client.ts) y su
// equivalente en cada vertical (hoteles/citas/despachos/licitaciones/restaurantes):
// un staff que inició sesión pero al que todavía nadie asignó a ninguna
// organización siempre navegaba aquí, pero "/sin-organizacion" nunca estuvo
// registrada en <Routes> — pantalla en blanco para ese caso en TODAS las
// verticales, no solo rentas. Cierra ese hueco con una página real (no un stub):
// mensaje explicativo + qué hacer, usando el `vertical`/`email` que el login que
// disparó la navegación haya pasado por `location.state` (ver App.tsx::*LoginRoute)
// cuando estén disponibles, y un mensaje genérico si no (p. ej. si alguien navega
// aquí directo o recarga la página).
import { useLocation } from "react-router-dom";
import { MarcoPublico } from "../components/MarcoPublico.tsx";

interface SinOrganizacionState {
  readonly email?: string;
  readonly vertical?: string;
}

export function SinOrganizacionPage() {
  const location = useLocation();
  const state = (location.state ?? null) as SinOrganizacionState | null;

  return (
    <MarcoPublico titulo="Todavía no perteneces a ninguna organización">
      <p className="text-sm text-muted-foreground">
        {state?.email ? <>Tu cuenta ({state.email}) inició sesión correctamente,</> : <>Tu cuenta inició sesión correctamente,</>} pero ningún administrador te asignó a
        una organización{state?.vertical ? ` de ${state.vertical}` : ""} todavía.
      </p>
      <p className="text-sm text-muted-foreground">Pídele a quien administra tu cuenta que te invite, y vuelve a intentar iniciar sesión.</p>
    </MarcoPublico>
  );
}

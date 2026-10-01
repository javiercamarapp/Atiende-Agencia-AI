// Pantalla 404 -- antes <Routes> no tenia ruta `*` y cualquier URL desconocida
// (un enlace viejo, un typo, el `/configuracion` que el Sidebar solia dibujar)
// dejaba la pantalla en blanco (hallazgo F-02 del informe de diseno-ux).
// Usa solo tokens del design system (modo claro/oscuro) y ofrece un camino
// real de vuelta: la pantalla de seleccion de panel.
import { Link, useLocation } from "react-router-dom";
import { AtiendeWordmark, Button } from "@atiende/ui";

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center px-6 py-10">
      <div className="max-w-md w-full text-center flex flex-col items-center gap-4">
        <AtiendeWordmark />
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Error 404</p>
        <h1 className="text-2xl font-semibold">No encontramos esta página</h1>
        <p className="text-sm text-muted-foreground break-all">
          La dirección <span className="font-mono">{pathname}</span> no existe o ya no está disponible.
        </p>
        <Button asChild>
          <Link to="/">Ir al inicio</Link>
        </Button>
      </div>
    </main>
  );
}

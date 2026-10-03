// Pantalla 404 -- antes <Routes> no tenia ruta `*` y cualquier URL desconocida
// (un enlace viejo, un typo, el `/configuracion` que el Sidebar solia dibujar)
// dejaba la pantalla en blanco (hallazgo F-02 del informe de diseno-ux).
// Composicion del 404 de Likida (~/likida/src/app/not-found.tsx:132-210): barra superior con el logo, kicker
// "Error 404", titular serif, bajada y pildoras de accion; un camino real de vuelta al inicio.
// Solo tokens del design system (modo claro/oscuro). No lleva la figura decorativa del 404 de Likida.
import { Link, useLocation } from "react-router-dom";
import { AtiendeWordmark } from "@atiende/ui";
import "./login.css";

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <main className="login flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center px-6 py-5 md:px-12">
        <AtiendeWordmark markClassName="h-6 w-auto" className="[&>span]:text-xl [&>span]:leading-6" />
      </header>

      <div className="flex flex-1 items-center px-6 py-14 md:px-12 md:py-20">
        <div className="max-w-2xl">
          <p className="login-kicker">Error 404</p>
          <h1 className="login-serif login-titulo-404 mt-7 text-foreground">No encontramos esta página</h1>
          <p className="login-cuerpo mt-6 max-w-xl break-all text-muted-foreground">
            La dirección <span className="font-mono">{pathname}</span> no existe o ya no está disponible.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link to="/" className="login-btn login-btn-auto login-btn-tinta">
              Ir al inicio
            </Link>
          </div>
        </div>
      </div>

      <footer className="px-6 py-5 text-xs text-faint md:px-12">
        <p className="login-kicker">atiende.ai</p>
      </footer>
    </main>
  );
}

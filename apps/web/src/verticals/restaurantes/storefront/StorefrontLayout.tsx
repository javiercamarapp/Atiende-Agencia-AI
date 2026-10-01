// Marco comun de las paginas publicas del storefront: encabezado con el restaurante, contenido principal y
// pie con el aviso de privacidad. Sin sesion ni menu de panel: es una pagina para clientes.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function StorefrontLayout({ orgSlug, nombre, children }: { orgSlug: string; nombre?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to={`/pedir/${orgSlug}`} className="text-base font-semibold tracking-tight">
            {nombre ?? "Pedir en línea"}
          </Link>
          <span className="text-xs text-muted-foreground">Pago en sucursal · sin cuenta</span>
        </div>
      </header>
      <main id="contenido" className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-10 pt-4 text-xs text-muted-foreground sm:px-6">
        <Link to={`/pedir/${orgSlug}/privacidad`} className="underline underline-offset-2">
          Aviso de privacidad
        </Link>
      </footer>
    </div>
  );
}

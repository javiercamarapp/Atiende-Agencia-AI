// Marco comun de las paginas publicas de reserva del hotel: barra superior con icono + nombre de la pagina (misma composicion que el resto del panel),
// contenido y pie con el aviso de privacidad. Sin sesion ni menu de panel: es una pagina limpia para huespedes.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BedDouble } from "lucide-react";

export function ReservarLayout({ orgSlug, titulo, hotel, children }: { orgSlug: string; titulo: string; hotel?: string | null; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:px-6">
          <BedDouble className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <h1 className="text-xl font-display font-semibold text-foreground">{titulo}</h1>
          {hotel && <span className="text-sm text-muted-foreground">· {hotel}</span>}
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6" aria-live="polite">
        {children}
      </main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 pt-2 text-xs text-muted-foreground sm:px-6">
        <Link to={`/hoteles/${orgSlug}/aviso`} className="underline underline-offset-4">
          Aviso de privacidad
        </Link>
      </footer>
    </div>
  );
}

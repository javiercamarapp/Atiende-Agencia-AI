// Marco de las paginas legales: port de ~/likida/src/app/legal/marco.tsx:60-108. Columna `max-w-2xl px-5 py-10`
// de 15 px, cabecera con etiqueta `text-xs font-medium uppercase tracking-wider` + titulo `text-2xl font-semibold`
// + bajada `text-sm`, secciones con `h2 text-base font-semibold`, pie con hairline y los dos enlaces legales.
// No se inventa una fecha de vigencia: Atiende no la tiene registrada.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface SeccionLegal {
  readonly titulo: string;
  readonly parrafos: readonly string[];
}

export interface PaginaLegalProps {
  readonly etiqueta: string;
  readonly titulo: string;
  readonly bajada: string;
  readonly secciones: readonly SeccionLegal[];
  readonly aviso?: ReactNode;
}

export function PaginaLegal({ etiqueta, titulo, bajada, secciones, aviso }: PaginaLegalProps) {
  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-background px-5 py-10 text-base leading-relaxed text-muted-foreground">
      <header className="border-b border-border pb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{etiqueta}</p>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{titulo}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{bajada}</p>
      </header>

      {secciones.map((s) => (
        <section key={s.titulo} className="mt-8">
          <h2 className="text-base font-semibold text-foreground">{s.titulo}</h2>
          {s.parrafos.map((p) => (
            <p key={p} className="mt-3">
              {p}
            </p>
          ))}
        </section>
      ))}

      {aviso && <p className="mt-8 text-sm text-muted-foreground">{aviso}</p>}

      <footer className="mt-12 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="flex gap-4">
          <Link to="/terminos" className="underline underline-offset-2 transition-opacity hover:opacity-70">
            Términos de servicio
          </Link>
          <Link to="/privacidad" className="underline underline-offset-2 transition-opacity hover:opacity-70">
            Aviso de privacidad
          </Link>
        </p>
      </footer>
    </main>
  );
}

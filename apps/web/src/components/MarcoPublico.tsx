// Marco de las pantallas PUBLICAS funcionales (invitacion, seleccion de organizacion, retorno de Google,
// enlaces de correo de la cuenta): lienzo gris tenue (`--canvas`, el fondo de la consola de Likida), logo de
// Likida-tamano (h-6) arriba y UNA tarjeta `rounded-lg border bg-card` con el titulo de pagina de Likida
// (20 px `font-display font-semibold`, ~/likida/src/app/dashboard/resumen-visual.tsx:73) y la bajada en
// `text-ui` muted. Sin titulos enormes ni columna angosta suelta (regla de diseno de Javier, 1-oct).
// Un solo <main> y un solo <h1> por pantalla.
import type { ReactNode } from "react";
import { AtiendeWordmark } from "@atiende/ui";

export interface MarcoPublicoProps {
  readonly titulo: string;
  readonly descripcion?: string;
  readonly children?: ReactNode;
  /** Tarjeta de formulario (420 px) o de seleccion (520 px). @default "form" */
  readonly ancho?: "form" | "lista";
}

export function MarcoPublico({ titulo, descripcion, children, ancho = "form" }: MarcoPublicoProps) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10 text-foreground">
      <div className={`mx-auto flex w-full flex-col gap-6 ${ancho === "lista" ? "max-w-[520px]" : "max-w-[420px]"}`}>
        <header className="flex items-center">
          <AtiendeWordmark markClassName="h-6 w-auto" className="[&>span]:text-xl [&>span]:leading-6" />
        </header>
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card">
          <div>
            <h1 className="font-display text-xl font-semibold text-foreground">{titulo}</h1>
            {descripcion && <p className="mt-1 text-ui text-muted-foreground">{descripcion}</p>}
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}

import { AtiendeWordmark } from "../AtiendeLogo";
import type { CopilotoTextos } from "./tipos";

/** Portada literal de atiende-restaurantes: wordmark h-9 animado, titulo y subtitulo. */
export function CopilotoPortada({ textos, compacta = false }: { textos: Pick<CopilotoTextos, "titulo" | "subtitulo" | "contexto">; compacta?: boolean }) {
  return (
    <>
      <AtiendeWordmark className={compacta ? "mb-4" : "mb-6"} markClassName={compacta ? "h-7 w-auto" : "h-9 w-auto"} animado />
      <h1 className={`${compacta ? "text-lg" : "text-2xl"} font-semibold text-foreground mb-2`}>{textos.titulo}</h1>
      <p className={`text-sm text-muted-foreground text-center max-w-md ${textos.contexto ? "mb-1" : "mb-8"}`}>{textos.subtitulo}</p>
      {textos.contexto ? <p className="text-xs text-muted-foreground text-center mb-8">{textos.contexto}</p> : null}
    </>
  );
}

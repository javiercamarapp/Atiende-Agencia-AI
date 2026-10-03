// Panel lateral del Copiloto (Cmd+J), gemelo del de Likida: un `aside` de 400 px que anima `width` y `margin` en 480 ms (var(--ease-out); la clase
// `.copiloto-panel-lateral` de packages/ui/src/index.css, sin estilos en linea), con cabecera
// "Copiloto" + <kbd>Cmd J</kbd> + "Abrir en pagina completa" + cerrar. NO se desmonta al navegar (vive en el shell, que es un layout) ni al cerrarse: cerrado =
// ancho 0 + `inert` (sin foco ni lectura de pantalla), asi la conversacion y un turno en curso sobreviven. El cuerpo se monta la primera vez que se abre
// (sin pedir el estado del Copiloto en cada pagina que nadie usa) y desde entonces queda montado. Esc lo cierra. En movil (< md) abierto es una lamina a
// pantalla completa y cerrado queda oculto sin desmontarse.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Sparkles, X } from "lucide-react";
import { Button } from "@atiende/ui";
import { CopilotoPlataforma } from "./CopilotoPlataforma.tsx";
import { RUTA_COPILOTO } from "../lib/copiloto-cliente.ts";

export const ANCHO_PANEL_COPILOTO = 400;
export const ID_PANEL_COPILOTO = "copiloto-panel";

export interface CopilotoPanelProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
}

export function CopilotoPanel({ abierto, onCerrar, apiBaseUrl, token }: CopilotoPanelProps) {
  const raiz = useRef<HTMLElement>(null);
  const [montado, setMontado] = useState(abierto);
  const [conversacion, setConversacion] = useState<string | undefined>(undefined);
  const botonCerrar = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (abierto) setMontado(true);
  }, [abierto]);

  // Cerrado = inert (sin foco, sin tecla, fuera del arbol de accesibilidad); React 18 no conoce el atributo, por eso va por ref.
  useEffect(() => {
    raiz.current?.toggleAttribute("inert", !abierto);
  }, [abierto]);

  // Foco al abrir (cabecera del panel); al cerrar, el foco vuelve a donde estaba lo gestiona el shell.
  useEffect(() => {
    if (abierto) botonCerrar.current?.focus();
  }, [abierto]);

  // Esc cierra el panel, salvo que lo atienda otra capa (un dialogo abierto como el de MFA, o una tecla ya consumida).
  useEffect(() => {
    if (!abierto) return undefined;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;
      onCerrar();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [abierto, onCerrar]);

  const hrefPagina = conversacion ? `${RUTA_COPILOTO}?c=${encodeURIComponent(conversacion)}` : RUTA_COPILOTO;

  return (
    <aside
      ref={raiz}
      id={ID_PANEL_COPILOTO}
      aria-label="Copiloto"
      data-abierto={abierto ? "true" : "false"}
      className="copiloto-panel-lateral shrink-0 overflow-hidden md:sticky md:top-4 md:my-4 md:h-[calc(100dvh-2rem)]"
    >
      <div className="flex h-full w-full flex-col overflow-hidden border border-border bg-card md:w-[400px] md:rounded-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Sparkles className="size-[15px] text-muted-foreground" strokeWidth={1.75} aria-hidden />
          <h2 className="text-sm font-medium text-foreground">Copiloto</h2>
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground" aria-label="Atajo: Comando o Control más J">
            ⌘J
          </kbd>
          <div className="ml-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="xs">
              <Link to={hrefPagina} onClick={onCerrar}>
                <ExternalLink className="size-3.5" aria-hidden />
                Abrir en página completa
              </Link>
            </Button>
            <Button ref={botonCerrar} type="button" variant="ghost" size="icon-sm" aria-label="Cerrar el Copiloto" onClick={onCerrar}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {montado ? (
            <CopilotoPlataforma apiBaseUrl={apiBaseUrl} token={token} variante="panel" onConversacionCambia={setConversacion} />
          ) : null}
        </div>
      </div>
    </aside>
  );
}

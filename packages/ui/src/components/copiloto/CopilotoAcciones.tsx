import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileDown, Pin, RotateCcw } from "lucide-react";
import { bloqueATsv } from "./formato";
import type { CopilotoMensaje, CopilotoTransporte } from "./tipos";

const BOTON = "flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50";

/** Texto que "Copiar" deja en el portapapeles: respuesta, tablas como TSV (se pegan en Excel) y fuentes. */
export function textoParaCopiar(m: CopilotoMensaje): string {
  const partes = [m.text.trim()];
  for (const b of m.blocks ?? []) partes.push(bloqueATsv(b));
  if (m.sources?.length) {
    partes.push(`Fuentes: ${m.sources.map((s) => [s.source, s.periodLabel, s.scopeLabel].filter(Boolean).join(" · ")).join("; ")}`);
  }
  return partes.filter(Boolean).join("\n\n");
}

/**
 * Acciones de una respuesta, con el estilo del "Descargar PDF" de atiende-restaurantes. Cada una llama a algo real:
 * el portapapeles, la URL de PDF del servidor, `transporte.fijar` o el reenvio de la pregunta. Si el transporte no
 * ofrece PDF o fijar, esa accion simplemente no se muestra.
 */
export function CopilotoAcciones({
  mensaje,
  conversacionId,
  transporte,
  esUltima,
  ocupado,
  onRegenerar,
}: {
  mensaje: CopilotoMensaje;
  conversacionId: string | undefined;
  transporte: CopilotoTransporte;
  esUltima: boolean;
  ocupado: boolean;
  onRegenerar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);
  const [fijado, setFijado] = useState<"no" | "ok" | "error">("no");
  const [fijando, setFijando] = useState(false);
  const temporizador = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(temporizador.current), []);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(textoParaCopiar(mensaje));
      setCopiado(true);
      clearTimeout(temporizador.current);
      temporizador.current = setTimeout(() => setCopiado(false), 1500);
    } catch {
      setCopiado(false);
    }
  };

  const puedeFijar = Boolean(transporte.fijar && conversacionId && mensaje.seq !== undefined && mensaje.blocks?.length);
  const fijar = async () => {
    if (!transporte.fijar || !conversacionId || mensaje.seq === undefined || fijando) return;
    setFijando(true);
    try {
      await transporte.fijar(conversacionId, mensaje.seq, 0);
      setFijado("ok");
    } catch {
      setFijado("error");
    } finally {
      setFijando(false);
    }
  };

  const urlPdf = transporte.urlPdf && conversacionId && mensaje.seq !== undefined ? transporte.urlPdf(conversacionId, mensaje.seq) : undefined;

  return (
    <div className="flex items-center gap-3 ml-6 flex-wrap">
      <button type="button" className={BOTON} onClick={() => void copiar()} aria-label="Copiar respuesta">
        {copiado ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        {copiado ? "Copiado" : "Copiar"}
      </button>
      {urlPdf ? (
        <a className={BOTON} href={urlPdf} download aria-label="Descargar PDF">
          <FileDown className="w-3.5 h-3.5" aria-hidden />
          Descargar PDF
        </a>
      ) : null}
      {puedeFijar ? (
        <button type="button" className={BOTON} onClick={() => void fijar()} disabled={fijando || fijado === "ok"} aria-label="Fijar en el tablero">
          <Pin className="w-3.5 h-3.5" aria-hidden />
          {fijado === "ok" ? "Fijado" : "Fijar"}
        </button>
      ) : null}
      {esUltima ? (
        <button type="button" className={BOTON} onClick={onRegenerar} disabled={ocupado} aria-label="Regenerar respuesta">
          <RotateCcw className="w-3.5 h-3.5" aria-hidden />
          Regenerar
        </button>
      ) : null}
      {fijado === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          No se pudo fijar; intenta de nuevo.
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copiado ? "Copiado" : ""}
      </span>
    </div>
  );
}

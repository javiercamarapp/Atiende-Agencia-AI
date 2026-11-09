import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileDown, Pin, RotateCcw, Sheet, ThumbsDown, ThumbsUp } from "lucide-react";
import { bloqueACsv, bloqueATsv, nombreArchivoCsv } from "./formato";
import { useIdiomaCopiloto } from "./idioma";
import { MOTIVOS_VALORACION_COPILOTO, type CopilotoBloque, type CopilotoMensaje, type CopilotoTransporte, type MotivoValoracionCopiloto } from "./tipos";

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

/** Descarga el CSV (UTF-8 con BOM) de un bloque en el navegador. Devuelve false si el navegador no puede crear el archivo. */
export function descargarCsv(bloque: CopilotoBloque, vertical: string | undefined, ahora: Date = new Date()): boolean {
  try {
    const url = URL.createObjectURL(new Blob([bloqueACsv(bloque)], { type: "text/csv;charset=utf-8" }));
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = nombreArchivoCsv(vertical, bloque.tool, ahora);
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
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
  vertical,
}: {
  mensaje: CopilotoMensaje;
  conversacionId: string | undefined;
  transporte: CopilotoTransporte;
  esUltima: boolean;
  ocupado: boolean;
  onRegenerar: () => void;
  /** Vertical para el nombre del archivo CSV (opcional). */
  vertical?: string;
}) {
  const [errorCsv, setErrorCsv] = useState(false);
  const [copiado, setCopiado] = useState(false);
  // Estado de "Fijar" por indice de bloque (una respuesta puede traer varias tablas y cada una se fija por separado).
  const [fijados, setFijados] = useState<Readonly<Record<number, "ok" | "error">>>({});
  const [fijando, setFijando] = useState(false);
  const [pdf, setPdf] = useState<{ estado: "libre" | "generando" | "error"; mensaje?: string }>({ estado: "libre" });
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

  const bloquesFijables = transporte.fijar && conversacionId && mensaje.seq !== undefined ? (mensaje.blocks ?? []).map((b, i) => ({ b, i })).filter(({ b }) => b.columns.length > 0 && b.rows.length > 0) : [];
  const fijar = async (indice: number) => {
    if (!transporte.fijar || !conversacionId || mensaje.seq === undefined || fijando) return;
    setFijando(true);
    try {
      await transporte.fijar(conversacionId, mensaje.seq, indice);
      setFijados((prev) => ({ ...prev, [indice]: "ok" }));
    } catch {
      setFijados((prev) => ({ ...prev, [indice]: "error" }));
    } finally {
      setFijando(false);
    }
  };

  const puedePdf = Boolean(transporte.descargarPdf && conversacionId && mensaje.seq !== undefined && mensaje.blocks?.length);
  const descargarPdf = async () => {
    if (!transporte.descargarPdf || !conversacionId || mensaje.seq === undefined || pdf.estado === "generando") return;
    setPdf({ estado: "generando" });
    try {
      await transporte.descargarPdf(conversacionId, mensaje.seq);
      setPdf({ estado: "libre" });
    } catch (e) {
      setPdf({ estado: "error", mensaje: e instanceof Error && e.message ? e.message : "No se pudo generar el PDF; intenta de nuevo." });
    }
  };

  const bloquesCsv = (mensaje.blocks ?? []).filter((b) => b.columns.length > 0 && b.rows.length > 0);
  const csv = (b: CopilotoBloque) => setErrorCsv(!descargarCsv(b, vertical));

  // «Útil / No fue útil» (migracion 0079): solo con un mensaje GUARDADO (conversacion + seq) y un transporte que sepa valorar.
  const { t } = useIdiomaCopiloto();
  const puedeValorar = Boolean(transporte.valorar && conversacionId && mensaje.seq !== undefined);
  const [valoracion, setValoracion] = useState<{ util: boolean; motivo: MotivoValoracionCopiloto | null } | null>(null);
  const [valorando, setValorando] = useState(false);
  const [errorValoracion, setErrorValoracion] = useState(false);
  const valorar = async (util: boolean, motivo: MotivoValoracionCopiloto | null = null) => {
    if (!transporte.valorar || !conversacionId || mensaje.seq === undefined || valorando) return;
    setValorando(true);
    setErrorValoracion(false);
    try {
      await transporte.valorar(conversacionId, mensaje.seq, { util, motivo });
      setValoracion({ util, motivo });
    } catch {
      setErrorValoracion(true);
    } finally {
      setValorando(false);
    }
  };

  const urlPdf = transporte.urlPdf && conversacionId && mensaje.seq !== undefined ? transporte.urlPdf(conversacionId, mensaje.seq) : undefined;

  return (
    <div className="flex items-center gap-3 ml-6 flex-wrap">
      <button type="button" className={BOTON} onClick={() => void copiar()} aria-label="Copiar respuesta">
        {copiado ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        {copiado ? "Copiado" : "Copiar"}
      </button>
      {bloquesCsv.map((b, i) => (
        <button key={`${b.tool}-${i}`} type="button" className={BOTON} onClick={() => csv(b)} aria-label={bloquesCsv.length > 1 ? `Descargar CSV de ${b.title}` : "Descargar CSV"}>
          <Sheet className="w-3.5 h-3.5" aria-hidden />
          {bloquesCsv.length > 1 ? `CSV: ${b.title}` : "CSV"}
        </button>
      ))}
      {urlPdf ? (
        <a className={BOTON} href={urlPdf} download aria-label="Descargar PDF">
          <FileDown className="w-3.5 h-3.5" aria-hidden />
          Descargar PDF
        </a>
      ) : null}
      {!urlPdf && puedePdf ? (
        <button type="button" className={BOTON} onClick={() => void descargarPdf()} disabled={pdf.estado === "generando"} aria-label="Descargar PDF">
          <FileDown className="w-3.5 h-3.5" aria-hidden />
          {pdf.estado === "generando" ? "Generando PDF…" : "Descargar PDF"}
        </button>
      ) : null}
      {bloquesFijables.map(({ b, i }) => (
        <button
          key={`fijar-${b.tool}-${i}`}
          type="button"
          className={BOTON}
          onClick={() => void fijar(i)}
          disabled={fijando || fijados[i] === "ok"}
          aria-label={bloquesFijables.length > 1 ? `Fijar ${b.title} en el tablero` : "Fijar en el tablero"}
        >
          <Pin className="w-3.5 h-3.5" aria-hidden />
          {fijados[i] === "ok" ? "Fijado" : bloquesFijables.length > 1 ? `Fijar: ${b.title}` : "Fijar"}
        </button>
      ))}
      {esUltima ? (
        <button type="button" className={BOTON} onClick={onRegenerar} disabled={ocupado} aria-label="Regenerar respuesta">
          <RotateCcw className="w-3.5 h-3.5" aria-hidden />
          Regenerar
        </button>
      ) : null}
      {puedeValorar ? (
        <span className="flex items-center gap-3" data-testid="copiloto-valoracion" data-valoracion={valoracion ? (valoracion.util ? "util" : "no_util") : ""}>
          <button type="button" className={BOTON} onClick={() => void valorar(true)} disabled={valorando} aria-pressed={valoracion?.util === true} aria-label={t("utilAria")}>
            <ThumbsUp className="w-3.5 h-3.5" aria-hidden />
            {t("util")}
          </button>
          <button type="button" className={BOTON} onClick={() => void valorar(false)} disabled={valorando} aria-pressed={valoracion?.util === false} aria-label={t("noUtilAria")}>
            <ThumbsDown className="w-3.5 h-3.5" aria-hidden />
            {t("noUtil")}
          </button>
        </span>
      ) : null}
      {valoracion?.util === false ? (
        <span role="group" aria-label={t("motivoPregunta")} className="flex basis-full flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="copiloto-valoracion-motivos">
          <span>{t("motivoPregunta")}</span>
          {MOTIVOS_VALORACION_COPILOTO.map((m) => (
            <button key={m} type="button" className={`${BOTON} rounded-full border border-border px-2 py-0.5`} aria-pressed={valoracion.motivo === m} disabled={valorando} onClick={() => void valorar(false, m)}>
              {t(`motivo_${m}`)}
            </button>
          ))}
        </span>
      ) : null}
      {errorCsv ? (
        <span role="alert" className="text-xs text-destructive">
          No se pudo crear el archivo CSV.
        </span>
      ) : null}
      {pdf.estado === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          {pdf.mensaje}
        </span>
      ) : null}
      {Object.values(fijados).includes("error") ? (
        <span role="alert" className="text-xs text-destructive">
          No se pudo fijar; intenta de nuevo.
        </span>
      ) : null}
      {errorValoracion ? (
        <span role="alert" className="text-xs text-destructive">
          {t("errorValoracion")}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copiado ? "Copiado" : valoracion ? t("graciasValoracion") : ""}
      </span>
    </div>
  );
}

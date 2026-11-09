import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileDown, Pin, RotateCcw, Sheet } from "lucide-react";
import { bloqueACsv, bloqueATsv, nombreArchivoCsv } from "./formato";
import { useIdiomaCopiloto } from "./idioma";
import type { CopilotoBloque, CopilotoMensaje, CopilotoTransporte } from "./tipos";

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
  const { t } = useIdiomaCopiloto();
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
      setPdf({ estado: "error", mensaje: e instanceof Error && e.message ? e.message : t("errorPdf") });
    }
  };

  const bloquesCsv = (mensaje.blocks ?? []).filter((b) => b.columns.length > 0 && b.rows.length > 0);
  const csv = (b: CopilotoBloque) => setErrorCsv(!descargarCsv(b, vertical));

  const urlPdf = transporte.urlPdf && conversacionId && mensaje.seq !== undefined ? transporte.urlPdf(conversacionId, mensaje.seq) : undefined;

  return (
    <div className="flex items-center gap-3 ml-6 flex-wrap">
      <button type="button" className={BOTON} onClick={() => void copiar()} aria-label={t("copiarRespuesta")}>
        {copiado ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        {copiado ? t("copiado") : t("copiar")}
      </button>
      {bloquesCsv.map((b, i) => (
        <button key={`${b.tool}-${i}`} type="button" className={BOTON} onClick={() => csv(b)} aria-label={bloquesCsv.length > 1 ? t("descargarCsvDe", { t: b.title }) : t("descargarCsv")}>
          <Sheet className="w-3.5 h-3.5" aria-hidden />
          {bloquesCsv.length > 1 ? t("csvDe", { t: b.title }) : t("csv")}
        </button>
      ))}
      {urlPdf ? (
        <a className={BOTON} href={urlPdf} download aria-label={t("descargarPdf")}>
          <FileDown className="w-3.5 h-3.5" aria-hidden />
          {t("descargarPdf")}
        </a>
      ) : null}
      {!urlPdf && puedePdf ? (
        <button type="button" className={BOTON} onClick={() => void descargarPdf()} disabled={pdf.estado === "generando"} aria-label={t("descargarPdf")}>
          <FileDown className="w-3.5 h-3.5" aria-hidden />
          {pdf.estado === "generando" ? t("generandoPdf") : t("descargarPdf")}
        </button>
      ) : null}
      {bloquesFijables.map(({ b, i }) => (
        <button
          key={`fijar-${b.tool}-${i}`}
          type="button"
          className={BOTON}
          onClick={() => void fijar(i)}
          disabled={fijando || fijados[i] === "ok"}
          aria-label={bloquesFijables.length > 1 ? t("fijarDeEnTablero", { t: b.title }) : t("fijarEnTablero")}
        >
          <Pin className="w-3.5 h-3.5" aria-hidden />
          {fijados[i] === "ok" ? t("fijado") : bloquesFijables.length > 1 ? t("fijarDe", { t: b.title }) : t("fijar")}
        </button>
      ))}
      {esUltima ? (
        <button type="button" className={BOTON} onClick={onRegenerar} disabled={ocupado} aria-label={t("regenerarRespuesta")}>
          <RotateCcw className="w-3.5 h-3.5" aria-hidden />
          {t("regenerar")}
        </button>
      ) : null}
      {errorCsv ? (
        <span role="alert" className="text-xs text-destructive">
          {t("errorCsv")}
        </span>
      ) : null}
      {pdf.estado === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          {pdf.mensaje}
        </span>
      ) : null}
      {Object.values(fijados).includes("error") ? (
        <span role="alert" className="text-xs text-destructive">
          {t("errorFijar")}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copiado ? t("copiado") : ""}
      </span>
    </div>
  );
}

// Clonacion de la voz telefonica con varias muestras (portado de ModalClonarVoz del repo suelto, sobre los primitivos de @atiende/ui).
// Graba en el navegador (MediaRecorder, hasta 30 s por clip) o sube archivos de audio; lista los clips para escucharlos o quitarlos,
// pide nombre y consentimiento explicito y sube todo a NUESTRA API, que llama al proveedor con su llave (la llave nunca llega aqui).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Mic, Square, Trash2, Upload } from "lucide-react";
import { Button, Callout, Checkbox, FormDialog, Input, Label, notify, useT } from "@atiende/ui";
import { vozClon } from "@atiende/ui/i18n/vozClon";
import { CLONAR_BYTES_MAX, CLONAR_MUESTRAS_MAX, CLONAR_MUESTRAS_MIN, clonarVoz } from "../lib/voz-client.ts";

const GRABACION_MAX_SEG = 30;
const TIPO_AUDIO_RE = /^(audio\/|video\/webm)/i;

interface Clip {
  readonly id: number;
  readonly blob: Blob;
  readonly url: string;
}

export interface ClonarVozDialogoProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onClonada: (vozTelefono: string) => void;
  /** Solo pruebas: reemplaza `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function grabacionDisponible(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function ClonarVozDialogo({ open, onOpenChange, apiBaseUrl, token, propertyId, onClonada, fetchImpl }: ClonarVozDialogoProps) {
  const t = useT(vozClon);
  const [clips, setClips] = useState<readonly Clip[]>([]);
  const [nombre, setNombre] = useState("");
  const [quitarRuido, setQuitarRuido] = useState(true);
  const [consentimiento, setConsentimiento] = useState(false);
  const [grabando, setGrabando] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const siguienteId = useRef(1);
  const grabador = useRef<MediaRecorder | null>(null);
  const flujo = useRef<MediaStream | null>(null);
  const reloj = useRef<ReturnType<typeof setInterval> | null>(null);
  const clipsRef = useRef<readonly Clip[]>([]);
  clipsRef.current = clips;

  // Al cerrar: libera el microfono y las URLs de los clips.
  useEffect(
    () => () => {
      if (reloj.current) clearInterval(reloj.current);
      if (grabador.current?.state === "recording") grabador.current.stop();
      flujo.current?.getTracks().forEach((p) => p.stop());
      clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    },
    [],
  );

  function agregar(blobs: readonly Blob[]) {
    setError(null);
    setClips((prev) => [...prev, ...blobs.map((blob) => ({ id: siguienteId.current++, blob, url: URL.createObjectURL(blob) }))].slice(0, CLONAR_MUESTRAS_MAX));
  }

  function quitar(id: number) {
    setClips((prev) => {
      const c = prev.find((x) => x.id === id);
      if (c) URL.revokeObjectURL(c.url);
      return prev.filter((x) => x.id !== id);
    });
  }

  function alSubir(e: ChangeEvent<HTMLInputElement>) {
    const archivos = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (archivos.some((a) => !TIPO_AUDIO_RE.test(a.type))) {
      setError(t("vozClon.noEsAudio"));
      return;
    }
    agregar(archivos);
  }

  const detenerGrabacion = useCallback(() => {
    if (reloj.current) clearInterval(reloj.current);
    reloj.current = null;
    if (grabador.current?.state === "recording") grabador.current.stop();
  }, []);

  async function grabar() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      flujo.current = stream;
      const rec = new MediaRecorder(stream);
      const trozos: Blob[] = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) trozos.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((p) => p.stop());
        flujo.current = null;
        setGrabando(false);
        if (trozos.length > 0) agregar([new Blob(trozos, { type: rec.mimeType || "audio/webm" })]);
      };
      grabador.current = rec;
      rec.start();
      setSegundos(0);
      setGrabando(true);
      reloj.current = setInterval(() => setSegundos((s) => s + 1), 1000);
    } catch {
      setError(t("vozClon.sinMicrofono"));
    }
  }

  // Tope por clip: a los 30 s se detiene sola.
  useEffect(() => {
    if (grabando && segundos >= GRABACION_MAX_SEG) detenerGrabacion();
  }, [grabando, segundos, detenerGrabacion]);

  const bytes = clips.reduce((s, c) => s + c.blob.size, 0);
  const problema =
    clips.length < CLONAR_MUESTRAS_MIN
      ? t("vozClon.faltanMuestras", { minimo: CLONAR_MUESTRAS_MIN })
      : clips.length > CLONAR_MUESTRAS_MAX
        ? t("vozClon.sobranMuestras", { maximo: CLONAR_MUESTRAS_MAX })
        : bytes > CLONAR_BYTES_MAX
          ? t("vozClon.muyPesado")
          : null;
  const listo = problema === null && nombre.trim().length >= 2 && consentimiento && !grabando;

  async function enviar() {
    if (!listo || enviando) return;
    setEnviando(true);
    setError(null);
    try {
      const r = await clonarVoz(fetchImpl ?? fetch, apiBaseUrl, token, propertyId, { nombre: nombre.trim(), muestras: clips.map((c) => c.blob), quitarRuido, consentimiento });
      notify.success(t("vozClon.exito"));
      onClonada(r.vozTelefono);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("vozClon.error"));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={t("vozClon.titulo")}
      subtitulo={t("vozClon.subtitulo")}
      anchoClase="max-w-2xl"
      onGuardar={() => void enviar()}
      guardando={enviando}
      textoBotonGuardar={t("vozClon.enviar")}
      guardarDeshabilitado={!listo}
      bloquearCierre={enviando || grabando}
    >
      <div className="space-y-4">
        <Callout tone="info">{t("vozClon.consejo")}</Callout>

        <div className="flex flex-wrap items-center gap-2">
          {grabacionDisponible() ? (
            grabando ? (
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={detenerGrabacion}>
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                {t("vozClon.detener", { segundos: String(segundos) })}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={clips.length >= CLONAR_MUESTRAS_MAX} onClick={() => void grabar()}>
                <Mic className="h-3.5 w-3.5" aria-hidden="true" />
                {t("vozClon.grabar")}
              </Button>
            )
          ) : null}
          <Label htmlFor="clonar-voz-archivos" className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {t("vozClon.subir")}
          </Label>
          <input id="clonar-voz-archivos" data-testid="clonar-voz-archivos" type="file" accept="audio/*" multiple className="sr-only" disabled={grabando || clips.length >= CLONAR_MUESTRAS_MAX} onChange={alSubir} />
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {t("vozClon.muestras", { count: clips.length })}
          </span>
        </div>

        {clips.length > 0 ? (
          <ul className="space-y-2" data-testid="clonar-voz-clips">
            {clips.map((c, i) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                <span className="text-sm font-medium text-foreground">{t("vozClon.muestra", { numero: String(i + 1) })}</span>
                <audio controls preload="none" src={c.url} aria-label={t("vozClon.escuchar", { numero: String(i + 1) })} className="h-8 min-w-0 flex-1" />
                <Button type="button" variant="ghost" size="sm" aria-label={t("vozClon.quitar", { numero: String(i + 1) })} onClick={() => quitar(c.id)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <Label htmlFor="clonar-voz-nombre" className="mb-1.5 block text-sm font-medium text-foreground">
            {t("vozClon.nombre")}
          </Label>
          <Input id="clonar-voz-nombre" value={nombre} maxLength={60} placeholder={t("vozClon.nombrePlaceholder")} onChange={(e) => setNombre(e.target.value)} />
        </div>

        <Checkbox id="clonar-voz-ruido" checked={quitarRuido} onChange={(e) => setQuitarRuido(e.target.checked)} label={t("vozClon.quitarRuido")} />
        <Checkbox id="clonar-voz-consentimiento" checked={consentimiento} onChange={(e) => setConsentimiento(e.target.checked)} label={t("vozClon.consentimiento")} />

        {problema && clips.length > 0 ? <p className="text-xs text-muted-foreground">{problema}</p> : null}
        {error ? <Callout tone="danger">{error}</Callout> : null}
      </div>
    </FormDialog>
  );
}

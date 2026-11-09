// C-16 -- Centro de avisos de citas: lo que hoy pide a una persona, con datos reales del servidor. Tres bloques:
// citas por confirmar (72 h), estado de entrega de los recordatorios de 24 h y escalaciones de crisis con seguimiento.
// La barra superior del shell lleva el icono + nombre de la pagina (`useTituloBarra`); el cuerpo usa tarjetas `p-4` como las
// de la pagina de notificaciones (Likida). Nada de contadores de adorno: cada numero sale de GET .../admin/avisos y, cuando la
// base todavia no tiene la migracion, se declara "no disponible aun" en vez de mostrar un cero que parezca real.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BellRing, CheckCheck, CircleAlert, HandHelping } from "lucide-react";
import { Button, Card, EstadoCargando, EstadoError, StatusBadge, Textarea, etiquetasTraducidas, useT, useTituloBarra } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import { citasAvisos } from "@atiende/ui/i18n/citas/avisos";
import { formatoRelativo } from "../../../lib/notificaciones-presentacion.ts";
import { darSeguimientoEscalacion, fetchAvisosCitas } from "../lib/avisos-client.ts";
import type { AvisosCitas, AvisosEscalacion, EscalacionSeguimiento } from "../lib/avisos-client.ts";
import { formatDateTime } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const SEGUIMIENTO_TONO: Readonly<Record<EscalacionSeguimiento, StatusTone>> = { pending: "danger", in_progress: "warning", resolved: "success" };
// Rotulos en el idioma activo: cada lectura traduce (en espanol, los textos de siempre).
const SEGUIMIENTO_ROTULO: Readonly<Record<EscalacionSeguimiento, string>> = etiquetasTraducidas<EscalacionSeguimiento>(
  ["pending", "in_progress", "resolved"],
  (s) => `citas.avisos.seguimiento.${s}` as const,
  citasAvisos,
);
const CANALES_TRADUCIDOS = etiquetasTraducidas<"voice" | "email">(["voice", "email"], (c) => `citas.avisos.canal.${c}` as const, citasAvisos);
const CANAL_ROTULO: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  get voice() {
    return CANALES_TRADUCIDOS.voice;
  },
  get email() {
    return CANALES_TRADUCIDOS.email;
  },
};
const ESTADO_ENTREGA_ROTULO: Readonly<Record<string, string>> = etiquetasTraducidas<"sent" | "pending" | "processing" | "failed" | "dead">(
  ["sent", "pending", "processing", "failed", "dead"],
  (e) => `citas.avisos.entrega.${e}` as const,
  citasAvisos,
);
const ESTADO_ENTREGA_TONO: Readonly<Record<string, StatusTone>> = { sent: "success", pending: "neutral", processing: "info", failed: "warning", dead: "danger" };
const ORDEN_ENTREGA = ["dead", "failed", "pending", "processing", "sent"] as const;

type Fase = "cargando" | "error" | "listo";

export function AvisosPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const t = useT(citasAvisos);
  useTituloBarra(t("citas.avisos.titulo"), BellRing);
  const [fase, setFase] = useState<Fase>("cargando");
  const [error, setError] = useState<string | null>(null);
  const [datos, setDatos] = useState<AvisosCitas | null>(null);
  const cargaRef = useRef(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const cargar = useCallback(
    async (silenciosa: boolean) => {
      const mia = ++cargaRef.current;
      if (!silenciosa) {
        setFase("cargando");
        setError(null);
      }
      try {
        const r = await fetchAvisosCitas(fetch, apiBaseUrl, tokenRef.current, propertyId);
        if (mia !== cargaRef.current) return;
        setDatos(r);
        setFase("listo");
      } catch (err) {
        if (mia !== cargaRef.current || silenciosa) return;
        setError(err instanceof Error ? err.message : t("citas.avisos.errorCargar"));
        setFase("error");
      }
    },
    [apiBaseUrl, propertyId],
  );

  useEffect(() => {
    void cargar(false);
  }, [cargar]);

  return (
    <div className="space-y-2.5">
      <p className="text-eyebrow text-faint">
        {t("citas.avisos.intro")}
      </p>
      {fase === "cargando" && <EstadoCargando variante="tarjeta" etiqueta={t("citas.avisos.cargando")} />}
      {fase === "error" && <EstadoError titulo={t("citas.avisos.errorTitulo")} mensaje={error ?? undefined} onReintentar={() => void cargar(false)} compacto />}
      {fase === "listo" && datos && (
        <>
          <BloquePorConfirmar datos={datos} orgSlug={orgSlug} />
          <BloqueRecordatorios datos={datos} orgSlug={orgSlug} />
          <BloqueEscalaciones datos={datos} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onCambio={() => cargar(true)} />
        </>
      )}
    </div>
  );
}

function Seccion({ titulo, resumen, children }: { titulo: string; resumen?: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-ui font-medium text-foreground">{titulo}</p>
        {resumen && <span className="text-eyebrow text-faint">{resumen}</span>}
      </div>
      <div className="mt-2.5 space-y-2">{children}</div>
    </Card>
  );
}

function NoDisponible({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function BloquePorConfirmar({ datos, orgSlug }: { datos: AvisosCitas; orgSlug: string }) {
  const t = useT(citasAvisos);
  const { porConfirmar } = datos;
  return (
    <Seccion titulo={t("citas.avisos.porConfirmar")} resumen={t("citas.avisos.porConfirmarResumen", { horas: porConfirmar.horas, total: porConfirmar.total })}>
      {porConfirmar.items.length === 0 ? (
        <NoDisponible>{t("citas.avisos.nadaPorConfirmar", { horas: porConfirmar.horas })}</NoDisponible>
      ) : (
        <>
          {porConfirmar.items.map((c) => (
            <div key={c.id} data-testid="aviso-por-confirmar" className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
              <div className="min-w-0">
                <p className="text-ui text-foreground">{formatDateTime(c.iniciaEn)}</p>
                <p className="text-xs text-muted-foreground">{[c.servicio, c.proveedor].filter(Boolean).join(" · ") || t("citas.avisos.sinDetalle")}</p>
              </div>
              <StatusBadge tone="warning" dot={false} className="text-eyebrow">
                {t("citas.avisos.pendiente")}
              </StatusBadge>
            </div>
          ))}
          {porConfirmar.total > porConfirmar.items.length && <NoDisponible>{t("citas.avisos.masEnAgenda", { n: porConfirmar.total - porConfirmar.items.length })}</NoDisponible>}
          <Button asChild variant="outline" size="xs">
            <Link to={`/citas/${orgSlug}/agenda`}>
              {t("citas.avisos.confirmarEnAgenda")}
              <ArrowRight className="size-[13px]" strokeWidth={1.75} />
            </Link>
          </Button>
        </>
      )}
    </Seccion>
  );
}

function BloqueRecordatorios({ datos, orgSlug }: { datos: AvisosCitas; orgSlug: string }) {
  const t = useT(citasAvisos);
  const { recordatorios } = datos;
  return (
    <Seccion titulo={t("citas.avisos.recordatorios")} resumen={t("citas.avisos.recordatoriosResumen", { dias: recordatorios.ventanaDias })}>
      {!recordatorios.visible ? (
        <NoDisponible>{t("citas.avisos.soloOwnerEntrega")}</NoDisponible>
      ) : !recordatorios.disponible ? (
        <NoDisponible>{t("citas.avisos.entregaSinMigrar")}</NoDisponible>
      ) : recordatorios.filas.length === 0 ? (
        <NoDisponible>{t("citas.avisos.sinRecordatorios")}</NoDisponible>
      ) : (
        <>
          {[...recordatorios.filas]
            .sort((a, b) => ORDEN_ENTREGA.indexOf(a.estado as (typeof ORDEN_ENTREGA)[number]) - ORDEN_ENTREGA.indexOf(b.estado as (typeof ORDEN_ENTREGA)[number]))
            .map((f) => (
              <div key={`${f.canal}-${f.estado}`} data-testid="aviso-recordatorio" className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <StatusBadge tone={ESTADO_ENTREGA_TONO[f.estado] ?? "neutral"} dot={false} className="text-eyebrow">
                    {ESTADO_ENTREGA_ROTULO[f.estado] ?? f.estado}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">{CANAL_ROTULO[f.canal] ?? f.canal}</span>
                </div>
                <span className="text-ui font-medium text-foreground">{f.total}</span>
              </div>
            ))}
          <Button asChild variant="outline" size="xs">
            <Link to={`/citas/${orgSlug}/mensajes-whatsapp`}>
              {t("citas.avisos.ajustarMensajes")}
              <ArrowRight className="size-[13px]" strokeWidth={1.75} />
            </Link>
          </Button>
        </>
      )}
    </Seccion>
  );
}

function BloqueEscalaciones({ datos, apiBaseUrl, token, propertyId, onCambio }: { datos: AvisosCitas; apiBaseUrl: string; token: string; propertyId: string; onCambio: () => Promise<void> }) {
  const { escalaciones } = datos;
  const t = useT(citasAvisos);
  const pendientes = escalaciones.items.filter((e) => e.seguimiento === "pending").length;
  return (
    <Seccion
      titulo={t("citas.avisos.escalaciones")}
      resumen={
        escalaciones.visible && escalaciones.disponible
          ? `${t("citas.avisos.escalacionesResumen", { n: escalaciones.items.length })}${escalaciones.seguimientoDisponible ? t("citas.avisos.sinSeguimientoResumen", { n: pendientes }) : ""}`
          : undefined
      }
    >
      {!escalaciones.visible ? (
        <NoDisponible>{t("citas.avisos.soloOwnerEscalaciones")}</NoDisponible>
      ) : !escalaciones.disponible ? (
        <NoDisponible>{t("citas.avisos.escalacionesError")}</NoDisponible>
      ) : (
        <>
          {!escalaciones.seguimientoDisponible && <NoDisponible>{t("citas.avisos.seguimientoSinMigrar")}</NoDisponible>}
          {escalaciones.items.length === 0 ? (
            <NoDisponible>{t("citas.avisos.sinEscalaciones")}</NoDisponible>
          ) : (
            escalaciones.items.map((e) => <FilaEscalacion key={e.id} e={e} puedeSeguir={escalaciones.seguimientoDisponible} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onCambio={onCambio} />)
          )}
        </>
      )}
    </Seccion>
  );
}

function FilaEscalacion({ e, puedeSeguir, apiBaseUrl, token, propertyId, onCambio }: { e: AvisosEscalacion; puedeSeguir: boolean; apiBaseUrl: string; token: string; propertyId: string; onCambio: () => Promise<void> }) {
  const [nota, setNota] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);
  const t = useT(citasAvisos);

  async function dar(estado: "in_progress" | "resolved") {
    if (ocupado) return;
    setOcupado(true);
    setErrorAccion(null);
    try {
      await darSeguimientoEscalacion(fetch, apiBaseUrl, token, propertyId, e.id, estado, nota.trim() === "" ? null : nota.trim());
      setNota("");
      await onCambio();
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : t("citas.avisos.errorSeguimiento"));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div data-testid="aviso-escalacion" data-seguimiento={e.seguimiento ?? "sin-estado"} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {e.seguimiento && (
          <StatusBadge tone={SEGUIMIENTO_TONO[e.seguimiento]} dot={false} className="text-eyebrow">
            {SEGUIMIENTO_ROTULO[e.seguimiento]}
          </StatusBadge>
        )}
        <span className="text-eyebrow text-faint">{CANAL_ROTULO[e.canal] ?? e.canal}</span>
        <span className="text-eyebrow text-faint">· {formatoRelativo(e.creadaEn)}</span>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-ui text-foreground">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" strokeWidth={1.75} />
        {t("citas.avisos.senal", { palabra: e.palabraClave, telefono: e.telefono })}
      </p>
      {e.nota && <p className="mt-1 text-xs text-muted-foreground">{t("citas.avisos.nota", { nota: e.nota })}</p>}
      {puedeSeguir && e.seguimiento !== "resolved" && (
        <div className="mt-2 space-y-1.5">
          <Textarea rows={2} maxLength={500} value={nota} onChange={(ev) => setNota(ev.target.value)} placeholder={t("citas.avisos.notaPlaceholder")} aria-label={t("citas.avisos.notaEtiqueta")} />
          <div className="flex flex-wrap items-center gap-2">
            {e.seguimiento === "pending" && (
              <Button type="button" variant="outline" size="xs" disabled={ocupado} onClick={() => void dar("in_progress")}>
                <HandHelping className="size-[13px]" strokeWidth={1.75} />
                {t("citas.avisos.tomar")}
              </Button>
            )}
            <Button type="button" variant="outline" size="xs" disabled={ocupado} onClick={() => void dar("resolved")}>
              <CheckCheck className="size-[13px]" strokeWidth={1.75} />
              {t("citas.avisos.resolver")}
            </Button>
          </div>
          {errorAccion && (
            <p role="alert" className="text-eyebrow text-destructive">
              {errorAccion}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

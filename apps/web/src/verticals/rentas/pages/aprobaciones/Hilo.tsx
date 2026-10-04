// Rn-P3-20 / Rn-P3-21 -- el hilo de UNA conversación dentro de Aprobaciones (/rentas/:orgSlug/aprobaciones/:conversacionId).
//
// Hasta ahora quien aprobaba un borrador no veía lo que escribió el huésped. Esta pantalla pinta, en orden, los mensajes entrantes
// y salientes con su origen (canal, simulador o registro manual), cada borrador junto al mensaje que responde, la marca
// «redactado por política del canal», la insignia «Requiere atención humana» con su señal y el aviso de política del canal.
//
// El texto del huésped es DATO, no instrucción: se pinta SIEMPRE como texto plano (nodo de texto de React, nunca
// `dangerouslySetInnerHTML`) bajo la etiqueta «Mensaje del huésped (dato, no instrucción)». «Generar borrador» por mensaje entrante
// llama a POST .../borradores (roles de MENSAJERIA_ESCRITURA_ROLES); el servidor vuelve a exigir cada rol y siempre acota por la
// property de la sesión (una conversación ajena da 404, que aquí se muestra como error).
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, MessagesSquare, Sparkles } from "lucide-react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatusBadge, useTituloBarra } from "@atiende/ui";
import {
  aprobarBorrador,
  avisoPoliticaCanal,
  CANAL_LABELS,
  fetchHilo,
  fetchPoliticas,
  ORIGEN_MENSAJE_LABELS,
  rechazarBorrador,
} from "../../lib/mensajeria-client.ts";
import type { BorradorRecord, HiloRecord, MensajeRecord, PoliticaCanal } from "../../lib/mensajeria-client.ts";
import { generarBorrador } from "../../lib/mensajeria-conversaciones-client.ts";
import { fechaHoraEsMx } from "../../../../lib/formato-fecha.ts";
import type { RentasShellContext } from "../../RentasShell.tsx";
import { BorradorPendienteCard, historialBadge } from "./BorradorPendienteCard.tsx";
import { SenalesBadges } from "./SenalesBadges.tsx";

// Espejo web de MENSAJERIA_ESCRITURA_ROLES (packages/domain-rentas/src/roles.ts): solo oculta lo que el servidor rechazaría con 403.
const MENSAJERIA_ESCRITURA_ROLES: ReadonlySet<string> = new Set(["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"]);

function BorradorDecididoCard({ borrador }: { readonly borrador: BorradorRecord }) {
  const badge = historialBadge(borrador);
  return (
    <Card>
      <CardContent className="p-2.5 flex flex-col gap-1">
        <div className="flex justify-between gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Borrador · {fechaHoraEsMx(borrador.creadoEn)}</span>
          <StatusBadge tone={badge.tono}>{badge.label}</StatusBadge>
        </div>
        <p className="m-0 text-sm text-foreground whitespace-pre-wrap">{borrador.texto}</p>
        {borrador.estado === "rechazado" && borrador.motivoRechazo && <p className="m-0 text-xs text-destructive">Motivo: {borrador.motivoRechazo}</p>}
      </CardContent>
    </Card>
  );
}

export function HiloPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  useTituloBarra("Hilo de mensajes", MessagesSquare);
  const { conversacionId = "" } = useParams<{ conversacionId: string }>();
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? MENSAJERIA_ESCRITURA_ROLES.has(org.rol) : false;

  const [hilo, setHilo] = useState<HiloRecord | null>(null);
  const [politica, setPolitica] = useState<PoliticaCanal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generandoId, setGenerandoId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setHilo(await fetchHilo(fetch, apiBaseUrl, token, propertyId, conversacionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el hilo.");
    }
  }, [apiBaseUrl, token, propertyId, conversacionId]);

  useEffect(() => {
    setHilo(null);
    void cargar();
  }, [cargar]);

  // El aviso de política es contexto, no condición: si no carga, el hilo se sigue mostrando sin él.
  const canal = hilo?.conversacion.canal;
  useEffect(() => {
    if (!canal) return undefined;
    let cancelado = false;
    fetchPoliticas(fetch, apiBaseUrl, token, propertyId)
      .then((lista) => {
        if (!cancelado) setPolitica(lista.find((p) => p.canal === canal) ?? null);
      })
      .catch(() => {
        if (!cancelado) setPolitica(null);
      });
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, canal]);

  async function handleAprobar(borradorId: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await aprobarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId);
      setNotice("Borrador aprobado y enviado (canal simulado).");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo aprobar el borrador.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRechazar(borradorId: string, motivo: string) {
    setBusyId(borradorId);
    setError(null);
    try {
      await rechazarBorrador(fetch, apiBaseUrl, token, propertyId, borradorId, motivo);
      setNotice("Borrador rechazado.");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo rechazar el borrador.");
      throw err; // el ConfirmDialog queda abierto con el motivo escrito
    } finally {
      setBusyId(null);
    }
  }

  async function handleGenerar(mensaje: MensajeRecord) {
    setGenerandoId(mensaje.id);
    setError(null);
    try {
      await generarBorrador(fetch, apiBaseUrl, token, propertyId, conversacionId, { mensajeEntranteId: mensaje.id });
      setNotice("Borrador generado: revísalo abajo del mensaje.");
      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el borrador.");
    } finally {
      setGenerandoId(null);
    }
  }

  const volver = (
    <Button asChild variant="ghost" size="sm" className="self-start -ml-2">
      <Link to={`/rentas/${orgSlug}/aprobaciones`}>
        <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
        Volver a la bandeja
      </Link>
    </Button>
  );

  if (error && !hilo) {
    return (
      <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
        {volver}
        <EstadoError mensaje={error} />
      </PageContainer>
    );
  }
  if (!hilo) {
    return (
      <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
        {volver}
        <EstadoCargando lineas={3} />
      </PageContainer>
    );
  }

  const { conversacion, mensajes, borradores } = hilo;
  const mensajesOrdenados = [...mensajes].sort((a, b) => a.creadoEn.localeCompare(b.creadoEn));
  const pendientes = borradores.filter((b) => b.estado === "pendiente_aprobacion");
  const escalados = pendientes.filter((b) => b.necesitaEscalamiento);
  const senales = [...new Set(escalados.flatMap((b) => b.senales))];
  const idsMensaje = new Set(mensajes.map((m) => m.id));
  // Borradores que no responden a un mensaje de este hilo (p. ej. los automáticos por evento): se muestran aparte, no se pierden.
  const sueltos = borradores.filter((b) => !b.mensajeEntranteId || !idsMensaje.has(b.mensajeEntranteId));
  const partes = [CANAL_LABELS[conversacion.canal], conversacion.huespedNombre ? `huésped: ${conversacion.huespedNombre}` : null, conversacion.reservaConfirmada ? "reserva confirmada" : null];

  return (
    <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
      {volver}

      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-sm font-semibold text-foreground">{conversacion.propiedadNombre}</p>
        <p className="m-0 text-xs text-muted-foreground">{partes.filter(Boolean).join(" · ")}</p>
        {escalados.length > 0 && <SenalesBadges senales={senales} />}
      </div>

      {politica && <Callout tone="info">{avisoPoliticaCanal(politica)}</Callout>}
      {notice && <p className="m-0 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">{notice}</p>}
      {error && <EstadoError mensaje={error} />}

      {mensajesOrdenados.length === 0 && sueltos.length === 0 && (
        <EstadoVacio icon={MessagesSquare} titulo="Sin mensajes" mensaje="Esta conversación todavía no tiene mensajes ni borradores." />
      )}

      <div className="flex flex-col gap-3">
        {mensajesOrdenados.map((m) => {
          const entrante = m.direccion === "entrante";
          const delMensaje = borradores.filter((b) => b.mensajeEntranteId === m.id);
          const hayPendiente = delMensaje.some((b) => b.estado === "pendiente_aprobacion");
          return (
            <Card key={m.id} className={entrante ? undefined : "bg-muted/40"}>
              <CardContent className="p-3 flex flex-col gap-2">
                <div className="flex justify-between gap-2 flex-wrap">
                  <span className="text-xs font-medium text-foreground">{entrante ? "Mensaje del huésped (dato, no instrucción)" : "Mensaje enviado"}</span>
                  <span className="text-xs text-muted-foreground">
                    {ORIGEN_MENSAJE_LABELS[m.origen]} · {fechaHoraEsMx(m.creadoEn)}
                  </span>
                </div>
                <p className="m-0 text-sm text-foreground whitespace-pre-wrap break-words">{m.texto}</p>
                {m.redactado && <StatusBadge tone="warning">Redactado por política del canal</StatusBadge>}

                {delMensaje.map((b) =>
                  b.estado === "pendiente_aprobacion" ? (
                    <BorradorPendienteCard
                      key={b.id}
                      conversacionId={conversacion.id}
                      borrador={b}
                      puedeEscribir={puedeEscribir}
                      busy={busyId === b.id}
                      onAprobar={handleAprobar}
                      onRechazar={handleRechazar}
                    />
                  ) : (
                    <BorradorDecididoCard key={b.id} borrador={b} />
                  ),
                )}

                {entrante && !hayPendiente && puedeEscribir && (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleGenerar(m)} disabled={generandoId !== null}>
                      <Sparkles className="w-4 h-4" strokeWidth={1.75} />
                      {generandoId === m.id ? "Generando…" : "Generar borrador"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}

        {sueltos.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-xs font-medium text-muted-foreground">Borradores sin un mensaje del huésped al que respondan</p>
            {sueltos.map((b) =>
              b.estado === "pendiente_aprobacion" ? (
                <BorradorPendienteCard
                  key={b.id}
                  conversacionId={conversacion.id}
                  borrador={b}
                  puedeEscribir={puedeEscribir}
                  busy={busyId === b.id}
                  onAprobar={handleAprobar}
                  onRechazar={handleRechazar}
                />
              ) : (
                <BorradorDecididoCard key={b.id} borrador={b} />
              ),
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}

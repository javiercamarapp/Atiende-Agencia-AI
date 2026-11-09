// Pestana "Por aprobar" de Pedidos (autopiloto, migracion 050). Una lista de decisiones que el sistema deja PREPARADAS para una persona:
//   * Pedido grande: Aprobar (pasa a Recibido, va a cocina y se avisa al cliente) o Rechazar (con motivo; se avisa y queda un callback).
//   * Cancelacion pedida por el cliente: Cancelar el pedido (con motivo) o Mantenerlo.
//   * Queja: Sin compensacion, Reponer producto (pedido de $0 a cocina) o Descuento en el proximo pedido (codigo de un solo uso con tope).
// Cada boton llama al endpoint real (idempotente: un doble clic no repite ningun efecto) y maneja carga, error y vacio. Nunca se autoaprueba: sin
// respuesta el sistema solo escala el aviso. El dinero (devolucion) solo se registra, nunca se ejecuta.
import { useState } from "react";
import { Button, Callout, Card, CardContent, Checkbox, EstadoCargando, EstadoVacio, FormDialog, FormField, Selector, StatusBadge, formatMoney, notify, useI18n } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesAutopiloto } from "@atiende/ui/i18n/restaurantes/autopiloto";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import { Clock } from "lucide-react";
import { SOLICITUD_TIPO_ETIQUETAS, mensajeResultadoSolicitud, minutosEsperando, resolverSolicitud } from "../lib/autopiloto-client.ts";
import type { MotivoCancelacion, ResolverEntrada, Solicitud, SolicitudesRespuesta } from "../lib/autopiloto-client.ts";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";

const QUEJA_ETIQUETAS: Readonly<Record<string, Clave>> = {
  faltante: "restaurantes.autopiloto.queja.faltante",
  equivocado: "restaurantes.autopiloto.queja.equivocado",
  frio: "restaurantes.autopiloto.queja.frio",
  tarde: "restaurantes.autopiloto.queja.tarde",
  trato: "restaurantes.autopiloto.queja.trato",
  otro: "restaurantes.autopiloto.queja.otro",
};

type Dialogo =
  | { readonly tipo: "motivo"; readonly solicitud: Solicitud; readonly decision: "rechazar" | "cancelar" }
  | { readonly tipo: "reponer"; readonly solicitud: Solicitud }
  | { readonly tipo: "descuento"; readonly solicitud: Solicitud };

export function AprobacionesPanel({
  datos,
  ahoraMs,
  apiBaseUrl,
  token,
  propertyId,
  topeDescuentoPct,
  onResuelta,
}: {
  /** `null` = cargando. */
  readonly datos: SolicitudesRespuesta | null;
  readonly ahoraMs: number;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly topeDescuentoPct: number;
  /** Recarga lista y pedidos tras resolver. */
  readonly onResuelta: () => Promise<void>;
}) {
  const { t, idioma } = useI18n(restaurantesComun, restaurantesAutopiloto);
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [indices, setIndices] = useState<ReadonlySet<number>>(new Set());
  const [pct, setPct] = useState<number>(10);

  if (datos === null) return <EstadoCargando etiqueta={t("restaurantes.autopiloto.aprob.cargando")} />;
  if (!datos.disponible) {
    return <EstadoVacio mensaje={t("restaurantes.autopiloto.aprob.noDisponible")} />;
  }
  if (datos.solicitudes.length === 0) return <EstadoVacio mensaje={t("restaurantes.autopiloto.aprob.vacio")} />;

  async function enviar(s: Solicitud, entrada: ResolverEntrada): Promise<boolean> {
    setProcesandoId(s.id);
    setError(null);
    setErrorDialogo(null);
    try {
      const r = await resolverSolicitud(fetch, apiBaseUrl, token, propertyId, s.id, entrada);
      const m = mensajeResultadoSolicitud(entrada, r);
      notify[m.tono](m.texto);
      await onResuelta();
      return true;
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : t("restaurantes.autopiloto.aprob.errorDecision");
      setError(mensaje);
      setErrorDialogo(mensaje);
      return false;
    } finally {
      setProcesandoId(null);
    }
  }

  const abrir = (d: Dialogo) => {
    setErrorDialogo(null);
    setIndices(new Set());
    setPct(Math.min(10, topeDescuentoPct));
    setDialogo(d);
  };

  const opcionesPct = [5, 10, 15, 20, 25, 30, 50].filter((n) => n <= topeDescuentoPct);
  if (!opcionesPct.includes(topeDescuentoPct)) opcionesPct.push(topeDescuentoPct);

  return (
    <div className="flex flex-col gap-2.5" data-testid="aprobaciones-lista">
      {error && !dialogo && <Callout tone="danger">{error}</Callout>}
      {datos.solicitudes.map((s) => {
        const ocupada = procesandoId === s.id;
        const espera = minutosEsperando(s.solicitadaAt, ahoraMs);
        return (
          <Card key={s.id} data-testid={`solicitud-${s.id}`}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {s.pedido ? `${s.pedido.clienteNombre} · $${formatMoney(s.pedido.total)}` : SOLICITUD_TIPO_ETIQUETAS[s.tipo]}
                    {s.pedido?.numero != null ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("restaurantes.autopiloto.aprob.pedidoNum", { numero: s.pedido.numero })}</span> : null}
                  </p>
                  {s.pedido && <p className="mt-0.5 text-sm text-foreground">{s.pedido.renglones.map((r) => `${r.cantidad}× ${r.nombre}`).join(", ")}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-1.5 self-start">
                  <StatusBadge tone="warning">{SOLICITUD_TIPO_ETIQUETAS[s.tipo]}</StatusBadge>
                  {s.pedido?.canal && (
                    <StatusBadge tone="neutral" dot={false}>
                      {t(s.pedido.canal === "recoger" ? "restaurantes.canal.recoger" : "restaurantes.canal.domicilio")}
                    </StatusBadge>
                  )}
                </div>
              </div>
              <p className="mt-1.5 inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                {t("restaurantes.autopiloto.aprob.espera", { tiempo: espera < 1 ? t("restaurantes.autopiloto.aprob.menosDeUnMinuto") : t("restaurantes.autopiloto.aprob.minutos", { min: espera }) })}
                {s.escaladaAt ? t("restaurantes.autopiloto.aprob.yaSeAviso") : ""}
                {s.tipo === "compensacion" && typeof s.detalle.subtipo === "string" ? ` · ${QUEJA_ETIQUETAS[s.detalle.subtipo] ? t(QUEJA_ETIQUETAS[s.detalle.subtipo] as Clave) : s.detalle.subtipo}` : ""}
                {/* En espanol, el estado crudo de siempre («listo para recoger»); en ingles, su etiqueta traducida. */}
                {s.pedido && s.tipo !== "pedido_grande" ? t("restaurantes.autopiloto.aprob.pedidoEstado", { estado: idioma === "es" ? s.pedido.status.replace(/_/g, " ") : ORDER_STATUS_LABELS[s.pedido.status].toLowerCase() }) : ""}
              </p>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {s.tipo === "pedido_grande" && (
                  <>
                    <Button type="button" size="sm" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "aprobar" })}>
                      {t("restaurantes.autopiloto.aprob.aprobar")}
                    </Button>
                    <Button type="button" size="sm" variant="danger" disabled={ocupada} onClick={() => abrir({ tipo: "motivo", solicitud: s, decision: "rechazar" })}>
                      {t("restaurantes.autopiloto.aprob.rechazar")}
                    </Button>
                  </>
                )}
                {s.tipo === "cancelacion" && (
                  <>
                    <Button type="button" size="sm" variant="danger" disabled={ocupada} onClick={() => abrir({ tipo: "motivo", solicitud: s, decision: "cancelar" })}>
                      {t("restaurantes.autopiloto.aprob.cancelarPedido")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "mantener" })}>
                      {t("restaurantes.autopiloto.aprob.mantener")}
                    </Button>
                  </>
                )}
                {s.tipo === "compensacion" && (
                  <>
                    <Button type="button" size="sm" variant="outline" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "sin_compensacion" })}>
                      {t("restaurantes.autopiloto.aprob.sinCompensacion")}
                    </Button>
                    {s.decisionesPosibles.includes("reponer_producto") && (
                      <Button type="button" size="sm" variant="outline" disabled={ocupada || !s.pedido || s.pedido.renglones.length === 0} onClick={() => abrir({ tipo: "reponer", solicitud: s })}>
                        {t("restaurantes.autopiloto.aprob.reponer")}
                      </Button>
                    )}
                    {s.decisionesPosibles.includes("descuento_proximo") && (
                      <Button type="button" size="sm" variant="outline" disabled={ocupada} onClick={() => abrir({ tipo: "descuento", solicitud: s })}>
                        {t("restaurantes.autopiloto.aprob.descuento")}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {s.tipo === "compensacion" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("restaurantes.autopiloto.aprob.devolucion")}
                  {!s.decisionesPosibles.includes("reponer_producto") ? t("restaurantes.autopiloto.aprob.soloDueno") : ""}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <MotivoDialogo
        open={dialogo?.tipo === "motivo"}
        onOpenChange={(o) => !o && setDialogo(null)}
        titulo={t(dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "restaurantes.autopiloto.aprob.rechazarTitulo" : "restaurantes.autopiloto.aprob.cancelarPedido")}
        subtitulo={t(dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "restaurantes.autopiloto.aprob.rechazarSub" : "restaurantes.autopiloto.aprob.cancelarSub")}
        textoConfirmar={t(dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "restaurantes.autopiloto.aprob.rechazarConfirmar" : "restaurantes.autopiloto.aprob.cancelarConfirmar")}
        tonoPeligro
        error={errorDialogo}
        enCurso={procesandoId !== null}
        onConfirmar={(motivo: MotivoCancelacion) => {
          if (dialogo?.tipo !== "motivo") return;
          const d = dialogo;
          void enviar(d.solicitud, { decision: d.decision, motivo }).then((ok) => ok && setDialogo(null));
        }}
      />

      <FormDialog
        open={dialogo?.tipo === "reponer"}
        onOpenChange={(o) => !o && setDialogo(null)}
        titulo={t("restaurantes.autopiloto.aprob.reponer")}
        subtitulo={t("restaurantes.autopiloto.aprob.reponerSub")}
        anchoClase="max-w-2xl"
        bloquearCierre={procesandoId !== null}
        onGuardar={() => {
          if (dialogo?.tipo !== "reponer" || indices.size === 0) return;
          void enviar(dialogo.solicitud, { decision: "reponer_producto", indices: [...indices].sort((a, b) => a - b) }).then((ok) => ok && setDialogo(null));
        }}
        guardando={procesandoId !== null}
        textoBotonGuardar={t("restaurantes.autopiloto.aprob.reponerConfirmar")}
        guardarDeshabilitado={indices.size === 0}
      >
        <div className="grid gap-2">
          {errorDialogo && <Callout tone="danger">{errorDialogo}</Callout>}
          {dialogo?.tipo === "reponer" &&
            dialogo.solicitud.pedido?.renglones.map((r) => (
              <Checkbox
                key={r.indice}
                label={`${r.cantidad}× ${r.nombre}`}
                checked={indices.has(r.indice)}
                onChange={(e) =>
                  setIndices((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(r.indice);
                    else next.delete(r.indice);
                    return next;
                  })
                }
              />
            ))}
        </div>
      </FormDialog>

      <FormDialog
        open={dialogo?.tipo === "descuento"}
        onOpenChange={(o) => !o && setDialogo(null)}
        titulo={t("restaurantes.autopiloto.aprob.descuento")}
        subtitulo={t("restaurantes.autopiloto.aprob.descuentoSub", { tope: topeDescuentoPct })}
        anchoClase="max-w-2xl"
        bloquearCierre={procesandoId !== null}
        onGuardar={() => {
          if (dialogo?.tipo !== "descuento") return;
          void enviar(dialogo.solicitud, { decision: "descuento_proximo", valor: pct }).then((ok) => ok && setDialogo(null));
        }}
        guardando={procesandoId !== null}
        textoBotonGuardar={t("restaurantes.autopiloto.aprob.enviarCodigo")}
      >
        <div className="grid gap-3">
          {errorDialogo && <Callout tone="danger">{errorDialogo}</Callout>}
          <FormField label={t("restaurantes.autopiloto.aprob.descuentoCampo")}>
            <Selector value={String(pct)} onValueChange={(v) => setPct(Number(v))}>
              {opcionesPct.map((n) => (
                <option key={n} value={n}>
                  {t("restaurantes.autopiloto.aprob.pct", { n })}

                </option>
              ))}
            </Selector>
          </FormField>
        </div>
      </FormDialog>
    </div>
  );
}

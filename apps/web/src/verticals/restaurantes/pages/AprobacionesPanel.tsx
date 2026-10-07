// Pestana "Por aprobar" de Pedidos (autopiloto, migracion 050). Una lista de decisiones que el sistema deja PREPARADAS para una persona:
//   * Pedido grande: Aprobar (pasa a Recibido, va a cocina y se avisa al cliente) o Rechazar (con motivo; se avisa y queda un callback).
//   * Cancelacion pedida por el cliente: Cancelar el pedido (con motivo) o Mantenerlo.
//   * Queja: Sin compensacion, Reponer producto (pedido de $0 a cocina) o Descuento en el proximo pedido (codigo de un solo uso con tope).
// Cada boton llama al endpoint real (idempotente: un doble clic no repite ningun efecto) y maneja carga, error y vacio. Nunca se autoaprueba: sin
// respuesta el sistema solo escala el aviso. El dinero (devolucion) solo se registra, nunca se ejecuta.
import { useState } from "react";
import { Button, Callout, Card, CardContent, Checkbox, EstadoCargando, EstadoVacio, FormDialog, FormField, NativeSelect, StatusBadge, formatMoney, notify } from "@atiende/ui";
import { Clock } from "lucide-react";
import { SOLICITUD_TIPO_ETIQUETAS, mensajeResultadoSolicitud, minutosEsperando, resolverSolicitud } from "../lib/autopiloto-client.ts";
import type { MotivoCancelacion, ResolverEntrada, Solicitud, SolicitudesRespuesta } from "../lib/autopiloto-client.ts";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";

const QUEJA_ETIQUETAS: Readonly<Record<string, string>> = { faltante: "Faltante", equivocado: "Producto equivocado", frio: "Llegó frío", tarde: "Llegó tarde", trato: "Trato", otro: "Otro" };

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
  const [procesandoId, setProcesandoId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [errorDialogo, setErrorDialogo] = useState<string | null>(null);
  const [indices, setIndices] = useState<ReadonlySet<number>>(new Set());
  const [pct, setPct] = useState<number>(10);

  if (datos === null) return <EstadoCargando etiqueta="Cargando aprobaciones…" />;
  if (!datos.disponible) {
    return <EstadoVacio mensaje="Las aprobaciones todavía no están disponibles en esta cuenta (falta aplicar la actualización de base de datos)." />;
  }
  if (datos.solicitudes.length === 0) return <EstadoVacio mensaje="No hay nada por aprobar." />;

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
      const mensaje = err instanceof Error ? err.message : "No se pudo aplicar la decisión.";
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
                    {s.pedido?.numero != null ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">Pedido #{s.pedido.numero}</span> : null}
                  </p>
                  {s.pedido && <p className="mt-0.5 text-sm text-foreground">{s.pedido.renglones.map((r) => `${r.cantidad}× ${r.nombre}`).join(", ")}</p>}
                </div>
                <div className="flex flex-wrap items-start gap-1.5 self-start">
                  <StatusBadge tone="warning">{SOLICITUD_TIPO_ETIQUETAS[s.tipo]}</StatusBadge>
                  {s.pedido?.canal && (
                    <StatusBadge tone="neutral" dot={false}>
                      {s.pedido.canal === "recoger" ? "Recoger" : "Domicilio"}
                    </StatusBadge>
                  )}
                </div>
              </div>
              <p className="mt-1.5 inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                Espera hace {espera < 1 ? "menos de 1 minuto" : `${espera} min`}
                {s.escaladaAt ? " · ya se avisó al dueño" : ""}
                {s.tipo === "compensacion" && typeof s.detalle.subtipo === "string" ? ` · ${QUEJA_ETIQUETAS[s.detalle.subtipo] ?? s.detalle.subtipo}` : ""}
                {s.pedido && s.tipo !== "pedido_grande" ? ` · pedido ${s.pedido.status.replace(/_/g, " ")}` : ""}
              </p>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {s.tipo === "pedido_grande" && (
                  <>
                    <Button type="button" size="sm" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "aprobar" })}>
                      Aprobar
                    </Button>
                    <Button type="button" size="sm" variant="danger" disabled={ocupada} onClick={() => abrir({ tipo: "motivo", solicitud: s, decision: "rechazar" })}>
                      Rechazar
                    </Button>
                  </>
                )}
                {s.tipo === "cancelacion" && (
                  <>
                    <Button type="button" size="sm" variant="danger" disabled={ocupada} onClick={() => abrir({ tipo: "motivo", solicitud: s, decision: "cancelar" })}>
                      Cancelar el pedido
                    </Button>
                    <Button type="button" size="sm" variant="outline" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "mantener" })}>
                      Mantener el pedido
                    </Button>
                  </>
                )}
                {s.tipo === "compensacion" && (
                  <>
                    <Button type="button" size="sm" variant="outline" loading={ocupada} disabled={ocupada} onClick={() => void enviar(s, { decision: "sin_compensacion" })}>
                      Sin compensación
                    </Button>
                    {s.decisionesPosibles.includes("reponer_producto") && (
                      <Button type="button" size="sm" variant="outline" disabled={ocupada || !s.pedido || s.pedido.renglones.length === 0} onClick={() => abrir({ tipo: "reponer", solicitud: s })}>
                        Reponer producto
                      </Button>
                    )}
                    {s.decisionesPosibles.includes("descuento_proximo") && (
                      <Button type="button" size="sm" variant="outline" disabled={ocupada} onClick={() => abrir({ tipo: "descuento", solicitud: s })}>
                        Descuento en el próximo pedido
                      </Button>
                    )}
                  </>
                )}
              </div>
              {s.tipo === "compensacion" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  La devolución de dinero (efectivo o tarjeta) no se ejecuta desde aquí: se acuerda con el cliente y se registra aparte.
                  {!s.decisionesPosibles.includes("reponer_producto") ? " Reponer producto o dar un descuento lo decide un dueño o administrador." : ""}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}

      <MotivoDialogo
        open={dialogo?.tipo === "motivo"}
        onOpenChange={(o) => !o && setDialogo(null)}
        titulo={dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "Rechazar el pedido grande" : "Cancelar el pedido"}
        subtitulo={dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "Se avisa al cliente con un texto honesto y queda un aviso para que una persona le llame." : "Se avisa al cliente por WhatsApp. Esta acción no se puede deshacer."}
        textoConfirmar={dialogo?.tipo === "motivo" && dialogo.decision === "rechazar" ? "Rechazar pedido" : "Cancelar pedido"}
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
        titulo="Reponer producto"
        subtitulo="Se crea un pedido de $0 que va a cocina con los renglones que elijas, y se avisa al cliente."
        anchoClase="max-w-2xl"
        bloquearCierre={procesandoId !== null}
        onGuardar={() => {
          if (dialogo?.tipo !== "reponer" || indices.size === 0) return;
          void enviar(dialogo.solicitud, { decision: "reponer_producto", indices: [...indices].sort((a, b) => a - b) }).then((ok) => ok && setDialogo(null));
        }}
        guardando={procesandoId !== null}
        textoBotonGuardar="Reponer sin costo"
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
        titulo="Descuento en el próximo pedido"
        subtitulo={`Se crea un código de un solo uso (vigente 30 días) y se manda al cliente. Tope de esta sucursal: ${topeDescuentoPct} %.`}
        anchoClase="max-w-2xl"
        bloquearCierre={procesandoId !== null}
        onGuardar={() => {
          if (dialogo?.tipo !== "descuento") return;
          void enviar(dialogo.solicitud, { decision: "descuento_proximo", valor: pct }).then((ok) => ok && setDialogo(null));
        }}
        guardando={procesandoId !== null}
        textoBotonGuardar="Enviar código"
      >
        <div className="grid gap-3">
          {errorDialogo && <Callout tone="danger">{errorDialogo}</Callout>}
          <FormField label="Descuento">
            <NativeSelect value={String(pct)} onChange={(e) => setPct(Number(e.target.value))}>
              {opcionesPct.map((n) => (
                <option key={n} value={n}>
                  {n} %
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </div>
      </FormDialog>
    </div>
  );
}

// Estado y cancelacion de una reserva directa por token opaco (H-42), sin login. Un token invalido, adulterado o de otro hotel muestra el MISMO
// mensaje (sin enumeracion). Solo muestra lo que el servidor devuelve; la penalidad y el reembolso los calcula la base, no el navegador.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, StatusBadge } from "@atiende/ui";
import { useMetaPublica } from "../../restaurantes/storefront/meta-publica.ts";
import { ReservarLayout } from "./Layout.tsx";
import { ETIQUETA_ESTADO, ReservarError, crearClienteReservar, nuevaClave, pesos, type VistaReserva } from "./cliente.ts";

export function EstadoReservaPage({ apiBaseUrl, orgSlug, token }: { apiBaseUrl: string; orgSlug: string; token: string }) {
  useMetaPublica({ titulo: "Tu reserva", descripcion: "Estado de tu reserva.", indexable: false });
  const cliente = useMemo(() => crearClienteReservar(fetch, apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [vista, setVista] = useState<VistaReserva | "cargando" | "no_encontrada" | { error: string }>("cargando");
  const [confirmando, setConfirmando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorCancelar, setErrorCancelar] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const cargar = useCallback(() => {
    cliente
      .estado(token)
      .then(setVista)
      .catch((e: unknown) => {
        if (e instanceof ReservarError && e.status === 404) setVista("no_encontrada");
        else setVista({ error: e instanceof Error ? e.message : "No pudimos consultar tu reserva." });
      });
  }, [cliente, token]);
  useEffect(() => {
    cargar();
  }, [cargar]);

  async function cancelar() {
    setBusy(true);
    setErrorCancelar(null);
    try {
      setVista(await cliente.cancelar(token, clave.current));
      setConfirmando(false);
    } catch (e) {
      clave.current = nuevaClave();
      setErrorCancelar(e instanceof Error ? e.message : "No pudimos cancelar tu reserva.");
    } finally {
      setBusy(false);
    }
  }

  const v = typeof vista === "object" && "estado" in vista ? vista : null;
  return (
    <ReservarLayout orgSlug={orgSlug} titulo="Tu reserva" hotel={v?.hotel}>
      {vista === "cargando" && <EstadoCargando etiqueta="Cargando tu reserva…" />}
      {vista === "no_encontrada" && (
        <Callout tone="warning" titulo="No encontramos esa reserva">
          El enlace puede estar incompleto o haber vencido. Revisa que lo copiaste completo; si tienes dudas, contacta al hotel.
        </Callout>
      )}
      {typeof vista === "object" && "error" in vista && <EstadoError titulo="Ocurrió un problema" mensaje={vista.error} onReintentar={cargar} />}
      {v && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">
                {v.tipoHabitacion} · {v.noches} {v.noches === 1 ? "noche" : "noches"}
              </h2>
              <StatusBadge tone={(ETIQUETA_ESTADO[v.estado] ?? { tono: "info" as const }).tono}>{(ETIQUETA_ESTADO[v.estado] ?? { texto: v.estado }).texto}</StatusBadge>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Llegada</dt>
              <dd>{v.llegada}</dd>
              <dt className="text-muted-foreground">Salida</dt>
              <dd>{v.salida}</dd>
              <dt className="text-muted-foreground">Huéspedes</dt>
              <dd>{v.huespedes}</dd>
              <dt className="text-muted-foreground">Total</dt>
              <dd>{pesos(v.totalCentavos)}</dd>
              {v.anticipoCentavos > 0 && (
                <>
                  <dt className="text-muted-foreground">Anticipo</dt>
                  <dd>
                    {pesos(v.anticipoCentavos)} · {v.pago.estado === "capturado" || v.pago.estado === "manual" ? "pagado" : "pendiente"}
                  </dd>
                </>
              )}
            </dl>
            {v.vigenteHasta && <p className="text-xs text-muted-foreground">Apartada hasta {v.vigenteHasta.slice(0, 16).replace("T", " ")} (UTC).</p>}
            {v.pago.requiereAccion && <Callout tone="info" titulo="Siguiente paso">{v.pago.requiereAccion}</Callout>}
            {v.cancelacion.resultado && (
              <Callout tone="info" titulo="Cancelación registrada">
                Penalidad {pesos(v.cancelacion.resultado.penalidadCentavos)} · reembolso {pesos(v.cancelacion.resultado.reembolsoCentavos)}
                {v.pago.reembolso === "solicitado" ? ". El hotel procesará tu reembolso." : v.pago.reembolso === "procesado" ? ". El reembolso ya fue procesado." : "."}
              </Callout>
            )}
            {v.cancelable && !confirmando && (
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirmando(true)}>
                Cancelar reserva
              </Button>
            )}
            {v.cancelable && confirmando && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <p className="text-sm text-foreground">
                  {v.cancelacion.siCancelasAhora
                    ? `Si cancelas ahora: penalidad ${pesos(v.cancelacion.siCancelasAhora.penalidadCents)}${v.cancelacion.siCancelasAhora.reembolsoCents !== undefined ? ` y reembolso ${pesos(v.cancelacion.siCancelasAhora.reembolsoCents)}` : ""}.`
                    : "Cancelar libera tu habitación sin costo."}
                </p>
                {errorCancelar && <Callout tone="danger" titulo="No pudimos cancelar">{errorCancelar}</Callout>}
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={busy} onClick={() => void cancelar()}>
                    {busy ? "Cancelando…" : "Sí, cancelar"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmando(false)}>
                    Conservar reserva
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </ReservarLayout>
  );
}

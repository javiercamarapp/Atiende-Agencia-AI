// Pestaña NUEVA (el panel original no la tenía): lista de conversaciones de voz con
// fecha, duración, costo y resultado, y la transcripción de la seleccionada. Estado
// vacío honesto hasta que exista backend: nunca se muestran llamadas inventadas.
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, TranscripcionEnVivo, useT } from "@atiende/ui";
import { restaurantesIndicadoresVoz } from "@atiende/ui/i18n/restaurantes/indicadoresVoz";
import type { LineaTranscripcion } from "@atiende/ui";
import type { ConversacionVoz } from "../lib/voz-client.ts";
import { etiquetaResultado, formatoCostoUsd, formatoDuracion, formatoInstante } from "./formato-voz.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";

function aLineas(c: ConversacionVoz): readonly LineaTranscripcion[] {
  return (c.transcripcion ?? []).map((l, i) => ({ id: `${c.id}-${i}`, rol: l.rol, texto: l.texto, parcial: false, ts: l.ts }));
}

export function PestanaConversaciones({ conversaciones, onReintentar, cargarDetalle }: { readonly conversaciones: Carga<readonly ConversacionVoz[]>; readonly onReintentar: () => void; readonly cargarDetalle?: (id: string) => Promise<ConversacionVoz> }) {
  const t = useT(restaurantesIndicadoresVoz);
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  // La transcripción NO viene en el listado: se pide al abrir una conversación.
  const [detalle, setDetalle] = useState<Carga<ConversacionVoz>>({ estado: "cargando" });

  useEffect(() => {
    if (abiertaId === null || !cargarDetalle) return;
    let cancelado = false;
    setDetalle({ estado: "cargando" });
    cargarDetalle(abiertaId).then(
      (d) => {
        if (!cancelado) setDetalle({ estado: "listo", datos: d });
      },
      (err: unknown) => {
        if (!cancelado) setDetalle(desdeError(err, t("restaurantes.indicadoresVoz.conv.errorTranscripcion")));
      },
    );
    return () => {
      cancelado = true;
    };
  }, [abiertaId]);

  if (conversaciones.estado === "cargando") return <EstadoCargando etiqueta={t("restaurantes.indicadoresVoz.conv.cargando")} />;
  if (conversaciones.estado === "no_disponible") {
    return <EstadoVacio icon={MessageSquareText} titulo={t("restaurantes.indicadoresVoz.conv.noDisponible")} mensaje={t("restaurantes.indicadoresVoz.conv.noDisponible.mensaje")} />;
  }
  if (conversaciones.estado === "error") return <EstadoError mensaje={conversaciones.mensaje} onReintentar={onReintentar} />;

  const lista = conversaciones.datos;
  if (lista.length === 0) return <EstadoVacio icon={MessageSquareText} titulo={t("restaurantes.indicadoresVoz.conv.vacio")} mensaje={t("restaurantes.indicadoresVoz.conv.vacio.mensaje")} />;

  const abierta = lista.find((c) => c.id === abiertaId) ?? null;
  if (abierta) {
    const lineas = aLineas(detalle.estado === "listo" && detalle.datos.id === abierta.id ? detalle.datos : abierta);
    return (
      <div className="space-y-3">
        <Button type="button" variant="ghost" size="sm" onClick={() => setAbiertaId(null)}>
          {t("restaurantes.indicadoresVoz.conv.volver")}
        </Button>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Dato titulo={t("restaurantes.indicadoresVoz.conv.fecha")} valor={formatoInstante(abierta.iniciadaEn)} />
          <Dato titulo={t("restaurantes.indicadoresVoz.conv.duracion")} valor={formatoDuracion(abierta.duracionSegundos)} />
          <Dato titulo={t("restaurantes.indicadoresVoz.col.costo")} valor={formatoCostoUsd(abierta.costoUsd)} />
          <Dato titulo={t("restaurantes.indicadoresVoz.conv.resultado")} valor={etiquetaResultado(abierta.resultado)} />
        </dl>
        <div className="rounded-xl border border-border p-4">
          {cargarDetalle && detalle.estado === "cargando" ? <EstadoCargando etiqueta={t("restaurantes.indicadoresVoz.conv.cargandoTranscripcion")} /> : null}
          {cargarDetalle && detalle.estado === "error" ? <EstadoError mensaje={detalle.mensaje} onReintentar={() => setAbiertaId(abierta.id)} /> : null}
          {cargarDetalle && detalle.estado === "no_disponible" ? <p className="text-xs text-muted-foreground">{t("restaurantes.indicadoresVoz.conv.transcripcionNoDisponible")}</p> : null}
          {!cargarDetalle || detalle.estado === "listo" ? lineas.length === 0 ? <p className="text-xs text-muted-foreground">{t("restaurantes.indicadoresVoz.conv.sinTranscripcion")}</p> : <TranscripcionEnVivo lineas={lineas} /> : null}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle>{t("restaurantes.indicadoresVoz.conv.titulo")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable<ConversacionVoz>
          etiqueta={t("restaurantes.indicadoresVoz.conv.tabla")}
          filas={lista}
          obtenerId={(c) => c.id}
          atributosFila={(c) => ({ "data-conversacion": c.id })}
          columnas={[
            { id: "fecha", encabezado: t("restaurantes.indicadoresVoz.conv.fecha"), principal: true, celda: (c) => formatoInstante(c.iniciadaEn) },
            { id: "duracion", encabezado: t("restaurantes.indicadoresVoz.conv.duracion"), className: "tabular-nums", celda: (c) => formatoDuracion(c.duracionSegundos) },
            { id: "costo", encabezado: t("restaurantes.indicadoresVoz.col.costo"), className: "tabular-nums", celda: (c) => formatoCostoUsd(c.costoUsd) },
            { id: "resultado", encabezado: t("restaurantes.indicadoresVoz.conv.resultado"), celda: (c) => etiquetaResultado(c.resultado) },
            {
              id: "acciones",
              encabezado: <span className="sr-only">{t("restaurantes.indicadoresVoz.conv.acciones")}</span>,
              etiqueta: t("restaurantes.indicadoresVoz.conv.acciones"),
              alinear: "right",
              celda: (c) => (
                <Button type="button" variant="outline" size="sm" onClick={() => setAbiertaId(c.id)}>
                  {t("restaurantes.indicadoresVoz.conv.verTranscripcion")}
                </Button>
              ),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

function Dato({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{titulo}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{valor}</dd>
    </div>
  );
}

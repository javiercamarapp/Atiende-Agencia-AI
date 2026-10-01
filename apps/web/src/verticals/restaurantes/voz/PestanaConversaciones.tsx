// Pestaña NUEVA (el panel original no la tenía): lista de conversaciones de voz con
// fecha, duración, costo y resultado, y la transcripción de la seleccionada. Estado
// vacío honesto hasta que exista backend: nunca se muestran llamadas inventadas.
import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, TranscripcionEnVivo } from "@atiende/ui";
import type { LineaTranscripcion } from "@atiende/ui";
import type { ConversacionVoz } from "../lib/voz-client.ts";
import { etiquetaResultado, formatoCostoUsd, formatoDuracion, formatoInstante } from "./formato-voz.ts";
import { desdeError } from "./carga.ts";
import type { Carga } from "./carga.ts";

function aLineas(c: ConversacionVoz): readonly LineaTranscripcion[] {
  return (c.transcripcion ?? []).map((l, i) => ({ id: `${c.id}-${i}`, rol: l.rol, texto: l.texto, parcial: false, ts: l.ts }));
}

export function PestanaConversaciones({ conversaciones, onReintentar, cargarDetalle }: { readonly conversaciones: Carga<readonly ConversacionVoz[]>; readonly onReintentar: () => void; readonly cargarDetalle?: (id: string) => Promise<ConversacionVoz> }) {
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
        if (!cancelado) setDetalle(desdeError(err, "No se pudo cargar la transcripción."));
      },
    );
    return () => {
      cancelado = true;
    };
  }, [abiertaId]);

  if (conversaciones.estado === "cargando") return <EstadoCargando etiqueta="Cargando conversaciones…" />;
  if (conversaciones.estado === "no_disponible") {
    return <EstadoVacio icon={MessageSquareText} titulo="Historial no disponible todavía" mensaje="El servicio de voz aún no está activo para este negocio, así que todavía no se guardan conversaciones. Cuando lo esté, aquí verás cada llamada con su transcripción, duración, costo y resultado." />;
  }
  if (conversaciones.estado === "error") return <EstadoError mensaje={conversaciones.mensaje} onReintentar={onReintentar} />;

  const lista = conversaciones.datos;
  if (lista.length === 0) return <EstadoVacio icon={MessageSquareText} titulo="Sin conversaciones" mensaje="Todavía no hay conversaciones de voz registradas para esta sucursal." />;

  const abierta = lista.find((c) => c.id === abiertaId) ?? null;
  if (abierta) {
    const lineas = aLineas(detalle.estado === "listo" && detalle.datos.id === abierta.id ? detalle.datos : abierta);
    return (
      <div className="space-y-3">
        <Button type="button" variant="ghost" size="sm" onClick={() => setAbiertaId(null)}>
          ‹ Volver a la lista
        </Button>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
          <Dato titulo="Fecha" valor={formatoInstante(abierta.iniciadaEn)} />
          <Dato titulo="Duración" valor={formatoDuracion(abierta.duracionSegundos)} />
          <Dato titulo="Costo" valor={formatoCostoUsd(abierta.costoUsd)} />
          <Dato titulo="Resultado" valor={etiquetaResultado(abierta.resultado)} />
        </dl>
        <div className="rounded-xl border border-border p-4">
          {cargarDetalle && detalle.estado === "cargando" ? <EstadoCargando etiqueta="Cargando transcripción…" /> : null}
          {cargarDetalle && detalle.estado === "error" ? <EstadoError mensaje={detalle.mensaje} onReintentar={() => setAbiertaId(abierta.id)} /> : null}
          {cargarDetalle && detalle.estado === "no_disponible" ? <p className="text-[12.5px] text-muted-foreground">La transcripción todavía no está disponible.</p> : null}
          {!cargarDetalle || detalle.estado === "listo" ? lineas.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Esta conversación no incluye transcripción.</p> : <TranscripcionEnVivo lineas={lineas} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <table className="w-full text-[12.5px]">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">Fecha</th>
            <th className="px-3 py-2 font-medium">Duración</th>
            <th className="px-3 py-2 font-medium">Costo</th>
            <th className="px-3 py-2 font-medium">Resultado</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {lista.map((c) => (
            <tr key={c.id} data-conversacion={c.id}>
              <td className="px-3 py-2">{formatoInstante(c.iniciadaEn)}</td>
              <td className="px-3 py-2 tabular-nums">{formatoDuracion(c.duracionSegundos)}</td>
              <td className="px-3 py-2 tabular-nums">{formatoCostoUsd(c.costoUsd)}</td>
              <td className="px-3 py-2">{etiquetaResultado(c.resultado)}</td>
              <td className="px-3 py-2 text-right">
                <Button type="button" variant="outline" size="sm" onClick={() => setAbiertaId(c.id)}>
                  Ver transcripción
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dato({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{titulo}</dt>
      <dd className="mt-0.5 text-[13px] text-foreground">{valor}</dd>
    </div>
  );
}

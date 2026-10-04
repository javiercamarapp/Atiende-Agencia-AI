// La tarjeta de un prospecto del Cerebro (la `TarjetaProspecto` de cerebro.tsx de Likida, con los tokens del DS de Atiende y los
// iconos de lucide en lugar de emojis). El punto es del color de su VERTICAL; la etapa del embudo, el subtipo, el tamano de la taxonomia
// y los cuatro % van en el texto. WhatsApp y correo abren la app de quien opera con el mensaje base cargado; si el prospecto esta en la
// lista de supresion, no tiene base de licitud o la supresion no se pudo verificar, el boton NO existe y se dice por que.
import { Link } from "react-router-dom";
import { Mail, MapPin, MessageCircle, Phone, User } from "lucide-react";
import { cn } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { BarraScore } from "./BarraScore.tsx";
import type { ProspectoMapa, TaxonomiaApi } from "./datos.ts";
import { tieneCoordenadas } from "./datos.ts";
import { nombreEtapa } from "./embudo.ts";
import { estadoMensaje } from "./mensajes.ts";
import type { Canal } from "./mensajes.ts";
import { etiquetaTamano, nombreSubtipo } from "./cartera.ts";
import { claseVertical, nombreVertical } from "./verticales.ts";

const BOTON = "inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1 text-eyebrow font-medium text-foreground hover:bg-canvas";

function BotonCanal({ p, canal, tax }: { readonly p: ProspectoMapa; readonly canal: Canal; readonly tax: ReadonlyMap<string, TaxonomiaApi> }) {
  const e = estadoMensaje(p, canal, tax.get(p.vertical));
  if (e.tipo === "sin_destino") return null;
  const Icono = canal === "whatsapp" ? MessageCircle : Mail;
  const nombre = canal === "whatsapp" ? "WhatsApp" : "Correo";
  if (e.tipo === "listo") {
    return (
      <a href={e.href} target={canal === "whatsapp" ? "_blank" : undefined} rel="noreferrer" className={BOTON} data-testid={`cerebro-${canal}`}>
        <Icono className="size-3" strokeWidth={1.75} aria-hidden="true" />
        {nombre}
      </a>
    );
  }
  return (
    <span aria-disabled="true" title={e.motivo} data-testid={`cerebro-${canal}-bloqueado`} className={cn(BOTON, "cursor-not-allowed opacity-50 hover:bg-card")}>
      <Icono className="size-3" strokeWidth={1.75} aria-hidden="true" />
      {nombre}: {e.tipo === "bloqueado" ? "no contactar" : "incompleto"}
    </span>
  );
}

export function TarjetaProspecto({ p, tax, nuevo, plana }: {
  readonly p: ProspectoMapa;
  readonly tax: ReadonlyMap<string, TaxonomiaApi>;
  readonly nuevo: boolean;
  /** true = tarjeta de seccion (plana, sin blur ni sombra: abajo del mapa no hay pais sobre el que flotar). */
  readonly plana?: boolean;
}) {
  const subtipo = nombreSubtipo(p, tax);
  const tamano = etiquetaTamano(p, tax);
  const ubicacion = p.municipio ?? p.ciudad;
  return (
    <article
      data-testid="cerebro-tarjeta"
      className={cn("space-y-2 rounded-2xl border border-border p-3.5", plana ? "bg-canvas" : "bg-card/90 shadow-elevated backdrop-blur-md", nuevo && "cerebro-recien")}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cn("cerebro-punto mt-1 size-2.5 shrink-0 rounded-full", claseVertical(p.vertical))} />
        <div className="min-w-0">
          <Link to={`/superadmin/mapa-prospectos/${p.id}`} className="block truncate text-sm font-medium leading-snug text-foreground hover:underline">
            {p.empresa}
          </Link>
          <p className="text-eyebrow text-muted-foreground">
            {nombreVertical(p.vertical)}
            {subtipo ? ` · ${subtipo}` : ""} · {nombreEtapa(p.estado)}
            {tamano ? ` · ${tamano}` : ""}
            {ubicacion ? ` · ${ubicacion}` : ""}
            {p.completitud !== null ? ` · datos ${p.completitud}%` : ""}
          </p>
        </div>
      </div>
      {(p.contacto || p.telefono || p.correo) && (
        <div className="space-y-0.5 text-xs text-foreground">
          {p.contacto && (
            <p className="flex items-center gap-1.5 truncate">
              <User className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" /> {p.contacto}
            </p>
          )}
          {p.telefono && (
            <p className="flex items-center gap-1.5">
              <Phone className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              <a className="hover:underline" href={`tel:${p.telefono}`}>{p.telefono}</a>
            </p>
          )}
          {p.correo && (
            <p className="flex items-center gap-1.5 truncate">
              <Mail className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              <a className="hover:underline" href={`mailto:${p.correo}`}>{p.correo}</a>
            </p>
          )}
        </div>
      )}
      {p.notas && <p className="line-clamp-2 text-eyebrow text-muted-foreground" title={p.notas}>{p.notas}</p>}
      <BarraScore etiqueta="Urgencia" pct={p.urgencia} tono="warning" />
      <BarraScore etiqueta="Cierre" pct={p.cierre} tono="success" />
      <BarraScore etiqueta="ICP" pct={p.ajuste} tono="primary" />
      {p.ultimoToque && <p className="text-2xs text-muted-foreground">Último toque: {fechaHoraEsMx(p.ultimoToque)}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <BotonCanal p={p} canal="whatsapp" tax={tax} />
        <BotonCanal p={p} canal="correo" tax={tax} />
        {tieneCoordenadas(p) && (
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className={BOTON}>
            <MapPin className="size-3" strokeWidth={1.75} aria-hidden="true" />
            Cómo llegar
          </a>
        )}
      </div>
    </article>
  );
}

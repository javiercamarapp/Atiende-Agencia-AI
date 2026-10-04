// El nivel CALLES del Cerebro (calles.tsx de Likida): Leaflet + teselas de OpenStreetMap (sin llave ni costo) con racimos de
// leaflet.markercluster. Decision declarada (igual que Likida): el mapa del pais se hornea sin teselas y carga sin red; ESTE nivel es la
// excepcion consciente, porque el nivel calle no existe sin un proveedor de teselas. Solo pinta prospectos CON coordenadas reales; a los
// demas no se les inventa lugar. Cada pin y cada racimo llevan el color de su VERTICAL (clases de cerebro.css que leen los tokens).
//
// Se carga con React.lazy (el equivalente de next/dynamic de Likida): Leaflet y su CSS no entran al bundle de las demas pantallas.
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "./cerebro.css";
import type * as Leaflet from "leaflet";
import type { ProspectoMapa, TaxonomiaApi } from "./datos.ts";
import { tieneCoordenadas } from "./datos.ts";
import { nombreEtapa } from "./embudo.ts";
import { claseAnilloEtapa } from "./embudo.ts";
import { estadoMensaje } from "./mensajes.ts";
import type { Canal } from "./mensajes.ts";
import { claseVertical, esVerticalCerebro, nombreVertical } from "./verticales.ts";
import { nombreSubtipo } from "./cartera.ts";

/** Todo lo del prospecto que entra crudo al HTML del popup pasa por aqui (nombres, ciudades, correos, notas, hrefs). */
export function escapar(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** El HTML del popup de un prospecto. Exportada para probarla sin Leaflet. */
export function htmlPopup(p: ProspectoMapa, tax: ReadonlyMap<string, TaxonomiaApi>): string {
  const boton = (canal: Canal, etiqueta: string): string => {
    const e = estadoMensaje(p, canal, tax.get(p.vertical));
    if (e.tipo === "sin_destino") return "";
    if (e.tipo === "listo") {
      return `<a class="cerebro-popup-boton" href="${escapar(e.href)}" target="${canal === "whatsapp" ? "_blank" : "_self"}" rel="noreferrer">${etiqueta}</a>`;
    }
    return `<span class="cerebro-popup-boton cerebro-popup-boton-apagado" title="${escapar(e.motivo)}">${etiqueta}: ${e.tipo === "bloqueado" ? "no contactar" : "incompleto"}</span>`;
  };
  const subtipo = nombreSubtipo(p, tax);
  const como = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  const puntos = [
    p.urgencia !== null ? `Urgencia <strong>${p.urgencia}%</strong>` : "Urgencia: sin calificar",
    p.cierre !== null ? `Cierre <strong>${p.cierre}%</strong>` : "Cierre: sin calificar",
  ].join(" · ");
  return `
    <div class="${claseVertical(p.vertical)}">
      <strong>${escapar(p.empresa)}</strong><br/>
      <span class="cerebro-popup-etapa"><span class="cerebro-popup-punto"></span>${escapar(nombreVertical(p.vertical))}${subtipo ? ` · ${escapar(subtipo)}` : ""} · ${escapar(nombreEtapa(p.estado))}</span><br/>
      ${p.contacto ? `${escapar(p.contacto)}<br/>` : ""}
      ${p.telefono ? `<a href="tel:${escapar(p.telefono)}">${escapar(p.telefono)}</a><br/>` : ""}
      ${p.correo ? `${escapar(p.correo)}<br/>` : ""}
      ${puntos}
      <div class="cerebro-popup-tenue">${escapar(p.municipio ?? p.ciudad ?? "")}</div>
      ${p.notas ? `<div class="cerebro-popup-tenue">${escapar(p.notas.slice(0, 240))}</div>` : ""}
      <div class="cerebro-popup-acciones">
        ${boton("whatsapp", "WhatsApp")}
        ${boton("correo", "Correo")}
        <a class="cerebro-popup-boton" href="${escapar(como)}" target="_blank" rel="noreferrer">Cómo llegar</a>
        <a class="cerebro-popup-boton" data-ficha="${escapar(p.id)}" href="/superadmin/mapa-prospectos/${escapar(p.id)}">Ficha</a>
      </div>
    </div>`;
}

/** La vertical que domina un racimo, y el desglose para su titulo ("3 Hoteles · 2 Citas"). */
export function resumenRacimo(verticales: readonly string[]): { readonly dominante: string; readonly titulo: string } {
  const m = new Map<string, number>();
  for (const v of verticales) m.set(v, (m.get(v) ?? 0) + 1);
  const orden = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { dominante: orden[0]?.[0] ?? "", titulo: orden.map(([v, n]) => `${n} ${nombreVertical(v)}`).join(" · ") };
}

export default function Calles({ prospectos, tax, titulo, onCerrar, onFicha }: {
  readonly prospectos: readonly ProspectoMapa[];
  readonly tax: ReadonlyMap<string, TaxonomiaApi>;
  readonly titulo: string;
  readonly onCerrar: () => void;
  /** Abre la ficha dentro de la SPA (el popup es HTML crudo: sin esto el enlace recargaria la pagina). */
  readonly onFicha: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const taxRef = useRef(tax);
  const onFichaRef = useRef(onFicha);
  useEffect(() => {
    taxRef.current = tax;
    onFichaRef.current = onFicha;
  }, [tax, onFicha]);

  useEffect(() => {
    let vivo = true;
    let mapa: Leaflet.Map | null = null;
    void (async () => {
      const L = (await import("leaflet")).default;
      // El plugin se cuelga de L al importarse: el orden importa.
      await import("leaflet.markercluster");
      if (!vivo || !ref.current) return;
      const conCoords = prospectos.filter(tieneCoordenadas);
      mapa = L.map(ref.current, { zoomControl: true, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
      mapa.on("popupopen", (ev) => {
        const enlace = ev.popup.getElement()?.querySelector<HTMLAnchorElement>("a[data-ficha]");
        enlace?.addEventListener("click", (clic) => {
          clic.preventDefault();
          onFichaRef.current(enlace.dataset["ficha"] ?? "");
        });
      });
      if (conCoords.length) {
        const verticalDe = new WeakMap<Leaflet.Layer, string>();
        // CLUSTERING: a nivel ciudad cien pines encimados mienten; el racimo dice cuantos hay, lleva el color de la vertical que domina
        // (el titulo desglosa el resto) y se abre al acercarse. spiderfy separa los que comparten direccion exacta.
        const racimos = L.markerClusterGroup({
          maxClusterRadius: 44,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          iconCreateFunction: (cluster) => {
            const { dominante, titulo: desglose } = resumenRacimo(cluster.getAllChildMarkers().map((m) => verticalDe.get(m) ?? ""));
            return L.divIcon({
              html: `<div class="cerebro-racimo ${claseVertical(dominante)}" title="${escapar(desglose)}">${cluster.getChildCount()}</div>`,
              className: "",
              iconSize: [36, 36],
            });
          },
        });
        const grupo = L.featureGroup(
          conCoords.map((p) => {
            const marcador = L.circleMarker([p.lat, p.lng], {
              radius: 9,
              className: `cerebro-calle-pin ${claseVertical(p.vertical)} ${claseAnilloEtapa(p.estado)}`.trim(),
            });
            verticalDe.set(marcador, esVerticalCerebro(p.vertical) ? p.vertical : "");
            // El contenido se arma AL ABRIR: un estado grande son miles de marcadores y ninguno se esta mirando.
            marcador.bindPopup(() => htmlPopup(p, taxRef.current));
            return marcador;
          }),
        );
        racimos.addLayer(grupo);
        mapa.addLayer(racimos);
        mapa.fitBounds(grupo.getBounds().pad(0.25), { maxZoom: 14 });
      } else {
        mapa.setView([23.6, -102.5], 5);
      }
    })();
    return () => {
      vivo = false;
      mapa?.remove();
    };
  }, [prospectos]);

  const conCoords = prospectos.filter(tieneCoordenadas).length;

  return (
    <div data-testid="cerebro-calles" className="cerebro-calles absolute inset-0 z-30 flex flex-col overflow-hidden rounded-3xl bg-card">
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2.5 text-foreground">
        <span className="text-sm font-medium">{titulo} — nivel calle</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {conCoords} de {prospectos.length} con dirección real; al resto no se le inventa lugar
        </span>
        <button type="button" onClick={onCerrar} className="ml-auto rounded-lg border border-border bg-canvas px-3 py-1 text-xs font-medium text-foreground hover:bg-card">
          ← Volver al país
        </button>
      </div>
      <div ref={ref} className="flex-1" />
    </div>
  );
}

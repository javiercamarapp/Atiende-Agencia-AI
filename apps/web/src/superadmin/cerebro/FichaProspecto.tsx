// ═══════════════════════════════════════════════════════════════════════════
// LA FICHA DE UN PROSPECTO (SA-L-43) — [id]/detalle.tsx de Likida portado a Atiende: todo lo que el mapa resume en una tarjeta, aqui
// desglosado. Decisores con su evidencia y confianza, ficha de campos, scores con el "por que" punto por punto, linea de tiempo y los
// mensajes con sus botones. Alimentada por GET /superadmin/cerebro/prospectos (la fila) y GET .../:id/detalle (personas y eventos).
//
// Lo que Likida tiene y Atiende NO (flota, viajes/mes, vacante, historia, "necesidad", redaccion con IA, registro automatico del toque) NO
// se maqueta: no aparece, y queda declarado en el cuerpo del PR con el ticket que lo cierra. Lo que falta de un prospecto dice "no disponible".
// Nada se manda solo: los botones abren WhatsApp o el correo de quien opera, con el mensaje base de la taxonomia cargado.
// ═══════════════════════════════════════════════════════════════════════════
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Brain, Mail, MessageCircle } from "lucide-react";
import { Callout, EstadoCargando, EstadoError, EstadoVacio, PageContainer, cn, useTituloBarra } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { useCarga } from "../lib/use-carga.ts";
import { BarraScore } from "./BarraScore.tsx";
import { cargarCartera, cargarDetalle } from "./cerebro-client.ts";
import { etiquetaTamano, nombreSubtipo, taxonomiaPorVertical } from "./cartera.ts";
import { aProspectoMapa } from "./datos.ts";
import type { EventoApi, PersonaApi, ProspectoApi, ProspectoMapa, TaxonomiaApi } from "./datos.ts";
import { esEtapaTerminal, nombreEtapa } from "./embudo.ts";
import { NOMBRE_BASE_LICITUD, NOMBRE_CANAL_PERSONA, NOMBRE_DIMENSION, NOMBRE_EVENTO, NOMBRE_ORIGEN_PERSONA, esUrlHttp } from "./etiquetas.ts";
import { EnlaceDato } from "./TarjetaProspecto.tsx";
import { estadoMensaje, hrefCorreoSiPermitido, hrefTelefonoSiPermitido } from "./mensajes.ts";
import type { Canal } from "./mensajes.ts";
import { claseVertical, nombreVertical } from "./verticales.ts";
import "./cerebro.css";

const CARD = "rounded-2xl border border-border bg-card p-4";
const SUBTITULO = "mb-3 text-eyebrow uppercase tracking-wider text-muted-foreground";
const CONFIANZA: Readonly<Record<string, { readonly texto: string; readonly clase: string }>> = {
  alta: { texto: "Confianza alta", clase: "bg-success-tint text-success" },
  media: { texto: "Confianza media", clase: "bg-warning-tint text-warning" },
  baja: { texto: "Confianza baja", clase: "bg-muted text-muted-foreground" },
};

function Campo({ etiqueta, children, mono }: { readonly etiqueta: string; readonly children: React.ReactNode; readonly mono?: boolean }) {
  const vacio = children === null || children === undefined || children === "" || children === false;
  return (
    <div className="rounded-xl border border-border bg-canvas p-3.5">
      <dt className="mb-1 text-2xs uppercase tracking-wider text-muted-foreground">{etiqueta}</dt>
      <dd className={cn(mono ? "text-ui tabular-nums" : "text-ui font-medium", vacio ? "italic text-muted-foreground" : "text-foreground")}>{vacio ? "no disponible" : children}</dd>
    </div>
  );
}

interface ItemExplicacion {
  readonly regla: string;
  readonly puntos: number;
  readonly fuente: string | null;
  readonly fecha: string | null;
}
interface DimensionExplicada {
  readonly clave: string;
  readonly puntaje: number | null;
  readonly items: readonly ItemExplicacion[];
}

/** Lee la explicacion guardada del score con cuidado: lo que no tiene la forma esperada se ignora (nunca se inventa). */
export function leerExplicacion(raw: unknown): { readonly dimensiones: readonly DimensionExplicada[]; readonly insuficiente: string | null } {
  if (typeof raw !== "object" || raw === null) return { dimensiones: [], insuficiente: null };
  const e = raw as { dimensiones?: unknown; insuficiente?: unknown };
  const insuficiente = typeof e.insuficiente === "object" && e.insuficiente !== null && typeof (e.insuficiente as { mensaje?: unknown }).mensaje === "string" ? (e.insuficiente as { mensaje: string }).mensaje : null;
  const dims: DimensionExplicada[] = [];
  if (typeof e.dimensiones === "object" && e.dimensiones !== null) {
    for (const [clave, d] of Object.entries(e.dimensiones as Record<string, unknown>)) {
      if (typeof d !== "object" || d === null) continue;
      const { puntaje, items } = d as { puntaje?: unknown; items?: unknown };
      const lista: ItemExplicacion[] = Array.isArray(items)
        ? items.flatMap((i: unknown) => {
            if (typeof i !== "object" || i === null) return [];
            const { regla, puntos, evidencia } = i as { regla?: unknown; puntos?: unknown; evidencia?: { fuente?: unknown; fecha?: unknown } };
            if (typeof regla !== "string" || typeof puntos !== "number") return [];
            return [{ regla, puntos, fuente: typeof evidencia?.fuente === "string" ? evidencia.fuente : null, fecha: typeof evidencia?.fecha === "string" ? evidencia.fecha : null }];
          })
        : [];
      dims.push({ clave, puntaje: typeof puntaje === "number" ? puntaje : null, items: lista });
    }
  }
  return { dimensiones: dims, insuficiente };
}

function textoEvento(e: EventoApi): string {
  const d = e.detalle;
  if (e.tipo === "cambio_etapa" && typeof d["de"] === "string" && typeof d["a"] === "string") return `${nombreEtapa(d["de"])} → ${nombreEtapa(d["a"])}`;
  return Object.entries(d)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
    .join(" · ");
}

function TarjetaMensaje({ p, canal, tax }: { readonly p: ProspectoMapa; readonly canal: Canal; readonly tax: TaxonomiaApi | undefined }) {
  const e = estadoMensaje(p, canal, tax);
  const Icono = canal === "whatsapp" ? MessageCircle : Mail;
  const titulo = canal === "whatsapp" ? "WhatsApp" : "Correo";
  const destino = canal === "whatsapp" ? p.telefono : p.correo;
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card" data-testid={`ficha-mensaje-${canal}`}>
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-eyebrow font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</span>
        {destino && <span className="text-eyebrow tabular-nums text-muted-foreground">{destino}</span>}
      </div>
      {e.tipo === "listo" ? (
        <>
          <p className="flex-1 whitespace-pre-wrap p-4 text-ui leading-relaxed text-foreground">{e.texto}</p>
          <div className="p-3 pt-0">
            <a href={e.href} target={canal === "whatsapp" ? "_blank" : undefined} rel="noreferrer" className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-ui font-medium text-primary-foreground hover:opacity-90">
              <Icono className="size-4" strokeWidth={1.75} aria-hidden="true" />
              Enviar {titulo === "WhatsApp" ? "WhatsApp" : "correo"}
            </a>
          </div>
        </>
      ) : (
        <p className="p-4 text-xs italic text-muted-foreground">
          {e.tipo === "sin_destino" ? `Sin ${canal === "whatsapp" ? "teléfono" : "correo"}: no se puede mandar.` : e.motivo}
        </p>
      )}
    </div>
  );
}

export function SuperAdminFichaProspectoPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  useTituloBarra("Ficha del prospecto", Brain);
  const { id = "" } = useParams<{ id: string }>();
  const { carga, recargar } = useCarga(
    async () => {
      const [cartera, detalle] = await Promise.all([cargarCartera(apiBaseUrl, token), cargarDetalle(apiBaseUrl, token, id)]);
      return { cartera, detalle };
    },
    [apiBaseUrl, token, id],
    "No se pudo cargar la ficha del prospecto.",
  );

  if (carga.estado === "cargando") return <EstadoCargando variante="tarjeta" etiqueta="Cargando la ficha…" />;
  if (carga.estado === "error") return <EstadoError titulo="No se pudo cargar la ficha" mensaje={carga.mensaje} onReintentar={recargar} />;
  const { cartera, detalle } = carga.data;
  const volver = (
    <Link to="/superadmin/mapa-prospectos" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:underline">
      <ArrowLeft className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Volver al mapa de prospectos
    </Link>
  );
  if (!cartera.disponible) {
    return (
      <PageContainer>
        {volver}
        <Callout tone="warning" titulo="La ficha no está disponible aún: requiere la migración 0051_cerebro_ventas_base">
          {cartera.mensaje ?? "Sin la migración no hay scores, personas de contacto ni línea de tiempo."}
        </Callout>
      </PageContainer>
    );
  }
  const fila: ProspectoApi | undefined = cartera.prospectos.find((x) => x.id === id);
  if (!fila) {
    return (
      <PageContainer>
        {volver}
        <EstadoVacio titulo="El prospecto no existe" mensaje="Puede que se haya eliminado o que el enlace sea incorrecto." />
      </PageContainer>
    );
  }
  return <Ficha fila={fila} personas={detalle.disponible ? detalle.personas : null} eventos={detalle.disponible ? detalle.eventos : null} taxonomias={cartera.taxonomias} volver={volver} />;
}

function Ficha({ fila, personas, eventos, taxonomias, volver }: {
  readonly fila: ProspectoApi;
  readonly personas: readonly PersonaApi[] | null;
  readonly eventos: readonly EventoApi[] | null;
  readonly taxonomias: readonly TaxonomiaApi[];
  readonly volver: React.ReactNode;
}) {
  const p = aProspectoMapa(fila);
  const tax = taxonomiaPorVertical(taxonomias);
  const taxVertical = tax.get(p.vertical);
  const explicacion = leerExplicacion(fila.scoreExplicacion);
  const subtipo = nombreSubtipo(p, tax);
  const tamano = etiquetaTamano(p, tax);
  const sitio = p.sitioWeb ? (p.sitioWeb.startsWith("http") ? p.sitioWeb : `https://${p.sitioWeb}`) : null;

  return (
    <PageContainer className="gap-8 pb-16" data-testid="ficha-prospecto">
      {volver}

      {/* ── Encabezado ─────────────────────────────────────────────────── */}
      <header className="space-y-2 border-b border-border pb-5">
        <div className="flex flex-wrap items-center gap-2 text-eyebrow text-muted-foreground">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas px-2 py-0.5 font-medium text-foreground", claseVertical(p.vertical))}>
            <span aria-hidden="true" className="cerebro-punto size-1.5 rounded-full" /> {nombreVertical(p.vertical)}
          </span>
          <span>· {nombreEtapa(p.estado)}</span>
          {subtipo && <span>· {subtipo}</span>}
          {(p.ciudad || p.entidad) && <span>· {[p.municipio ?? p.ciudad, p.entidad].filter(Boolean).join(", ")}</span>}
          {tamano && <span>· {tamano}</span>}
        </div>
        <h1 className="text-xl font-semibold text-foreground">{p.empresa}</h1>
        {p.contactoLegado && (
          <Callout tone="warning" titulo="Sin base de licitud registrada">
            Este prospecto se capturó antes de exigirla: no se puede contactar hasta registrarla (Editar, en la lista del Cerebro de ventas).
          </Callout>
        )}
      </header>

      {/* ── Los porcentajes ────────────────────────────────────────────── */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className={CARD}>
          <h3 className={SUBTITULO}>Del mapa (Cerebro)</h3>
          <div className="space-y-3">
            <BarraScore etiqueta="Urgencia" pct={p.urgencia} tono="warning" />
            <BarraScore etiqueta="Cierre" pct={p.cierre} tono="success" />
            <BarraScore etiqueta="Datos" pct={p.completitud} tono="info" />
          </div>
        </div>
        <div className={CARD}>
          <h3 className={SUBTITULO}>Ajuste con el cliente ideal (ICP), calculado — nadie lo escribe a mano</h3>
          <div className="space-y-3">
            <BarraScore etiqueta="Ajuste" pct={p.ajuste} tono="primary" />
            {fila.scoreVersion && <p className="text-2xs text-muted-foreground">Reglas: {fila.scoreVersion}</p>}
            {explicacion.insuficiente && <p className="text-eyebrow text-warning">{explicacion.insuficiente}</p>}
          </div>
        </div>
      </section>

      {explicacion.dimensiones.some((d) => d.items.length > 0) && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">Por qué estos números</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {explicacion.dimensiones.filter((d) => d.items.length > 0).map((d) => (
              <div key={d.clave} className={CARD}>
                <h3 className={SUBTITULO}>{NOMBRE_DIMENSION[d.clave] ?? d.clave}{d.puntaje !== null ? ` · ${d.puntaje}` : ""}</h3>
                <ul className="space-y-1.5 text-xs text-foreground">
                  {d.items.map((i, k) => (
                    <li key={`${i.regla}-${k}`}>
                      <span className="font-medium tabular-nums">+{i.puntos}</span> {i.regla}
                      {(i.fuente || i.fecha) && <span className="block text-eyebrow text-muted-foreground">{[i.fuente, i.fecha].filter(Boolean).join(" · ")}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Decisores ──────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">{personas && personas.length > 0 ? `Persona${personas.length > 1 ? "s" : ""} de contacto` : "Decisor"}</h2>
        {personas === null && <p className="text-sm italic text-muted-foreground">Las personas de contacto no están disponibles aún: requieren la migración 0051.</p>}
        {personas !== null && personas.length === 0 && !p.contacto && <p className="text-sm italic text-muted-foreground">Sin decisor público confirmado todavía.</p>}
        {personas !== null && personas.length === 0 && p.contacto && (
          <div className="rounded-xl border border-border bg-canvas p-3.5">
            <p className="text-sm font-medium text-foreground">{p.contacto}</p>
          </div>
        )}
        {personas !== null && personas.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {personas.map((per) => (
              <div key={per.id} className="space-y-1.5 rounded-xl border border-border bg-canvas p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{per.nombre}</p>
                  <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium", CONFIANZA[per.confianza]?.clase ?? CONFIANZA["baja"]!.clase)}>{CONFIANZA[per.confianza]?.texto ?? per.confianza}</span>
                </div>
                {per.cargo && <p className="text-xs text-muted-foreground">{per.cargo}</p>}
                {per.dato && (
                  <p className="text-xs text-foreground">
                    {NOMBRE_CANAL_PERSONA[per.canal] ?? per.canal}: {per.dato}
                  </p>
                )}
                <p className="text-2xs text-muted-foreground">
                  {NOMBRE_ORIGEN_PERSONA[per.origen] ?? per.origen}
                  {esUrlHttp(per.evidenciaUrl) && (
                    <>
                      {" — "}
                      <a href={per.evidenciaUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">evidencia</a>
                    </>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── La ficha ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">Ficha</h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Campo etiqueta="Teléfono" mono>{p.telefono ? <EnlaceDato href={hrefTelefonoSiPermitido(p)} dato={p.telefono} /> : null}</Campo>
          <Campo etiqueta="Correo" mono>{p.correo ? <EnlaceDato href={hrefCorreoSiPermitido(p)} dato={p.correo} /> : null}</Campo>
          <Campo etiqueta="Sitio web">
            {sitio ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <a className="hover:underline" href={sitio} target="_blank" rel="noreferrer">{p.sitioWeb}</a>
                <span className={cn("rounded-full px-1.5 py-0.5 text-2xs", p.sitioVerificado ? "bg-success-tint text-success" : "bg-muted text-muted-foreground")}>{p.sitioVerificado ? "verificado" : "sin verificar"}</span>
              </span>
            ) : null}
          </Campo>
          <Campo etiqueta="Subtipo">{subtipo}</Campo>
          <Campo etiqueta="Tamaño" mono>{tamano}</Campo>
          <Campo etiqueta="Fuente">{p.fuente}</Campo>
          <Campo etiqueta="Base de licitud">{p.baseLicitud ? (NOMBRE_BASE_LICITUD[p.baseLicitud] ?? p.baseLicitud) : null}</Campo>
          <Campo etiqueta="Registrado">{fechaHoraEsMx(p.creadoEn)}</Campo>
          <Campo etiqueta="Último toque">{p.ultimoToque ? fechaHoraEsMx(p.ultimoToque) : null}</Campo>
          <Campo etiqueta="Siguiente paso">{p.siguientePaso ? `${p.siguientePaso}${p.siguientePasoEn ? ` · ${fechaHoraEsMx(p.siguientePasoEn)}` : ""}` : null}</Campo>
        </dl>
      </section>

      {p.notas && (
        <section>
          <h2 className="mb-2 text-base font-semibold text-foreground">Notas de investigación</h2>
          <pre className="whitespace-pre-wrap rounded-xl border border-border bg-canvas p-3.5 font-[inherit] text-xs leading-relaxed text-muted-foreground">{p.notas}</pre>
        </section>
      )}

      {/* ── Linea de tiempo ────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">Línea de tiempo</h2>
        {eventos === null ? (
          <p className="text-sm italic text-muted-foreground">La línea de tiempo no está disponible aún: requiere la migración 0051.</p>
        ) : eventos.length === 0 ? (
          <p className="text-sm italic text-muted-foreground">Sin eventos registrados todavía.</p>
        ) : (
          <ol className="grid gap-2">
            {eventos.map((e) => (
              <li key={e.id} className="rounded-xl border border-border bg-canvas px-3.5 py-2.5 text-xs">
                <span className="font-medium text-foreground">{NOMBRE_EVENTO[e.tipo] ?? e.tipo}</span>
                <span className="text-muted-foreground"> · {fechaHoraEsMx(e.creadoEn)}</span>
                {textoEvento(e) && <span className="block text-muted-foreground">{textoEvento(e)}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ── Mensajes ───────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">Mensajes</h2>
        {esEtapaTerminal(p.estado) ? (
          <p className="text-sm italic text-muted-foreground">El prospecto ya está en un desenlace final ({nombreEtapa(p.estado)}): no se prepara un primer toque.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <TarjetaMensaje p={p} canal="whatsapp" tax={taxVertical} />
            <TarjetaMensaje p={p} canal="correo" tax={taxVertical} />
          </div>
        )}
        <p className="mt-3 text-eyebrow text-muted-foreground">
          Nada se manda solo: los botones abren tu WhatsApp o correo con el mensaje base de la taxonomía de {nombreVertical(p.vertical)} (v{taxVertical?.version ?? "?"}) cargado; tú decides. Un destino en la lista de supresión o sin base de licitud no se puede contactar.
        </p>
      </section>
    </PageContainer>
  );
}

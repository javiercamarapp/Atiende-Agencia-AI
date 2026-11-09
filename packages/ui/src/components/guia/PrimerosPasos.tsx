// «Primeros pasos» con el patron /setup de Rovaq: «Estás viendo la configuración como {rol}», barra «3 de 6 que puedes hacer ahora»,
// «n en espera», tarjetas por tarea con pildora de estado, «Qué se pide», quien lo cierra, «Recomendado ahora» en la primera pendiente
// y «Ir a hacerlo» solo si el rol puede. Los estados vienen SIEMPRE del servidor (calculados con datos reales): este componente no
// decide nada, solo pinta. Celebracion sutil (anillo que se dibuja, sin confeti) una sola vez por hito y por navegador.
import * as React from "react";
import { Link } from "react-router-dom";
import { EstadoCargando } from "../EstadoCargando";
import { EstadoError } from "../EstadoError";
import { almacenDelNavegador } from "./estado";
import { traductorGuia, useIdiomaGuia, type ClaveGuia } from "./textos";
import "./guia.css";

export type EstadoPrimerPaso = "hecho" | "parcial" | "pendiente" | "externo" | "bloqueado" | "informativo";

export interface PrimerPaso {
  readonly id: string;
  readonly titulo: string;
  /** «Qué se pide»: una o dos frases honestas. */
  readonly detalle: string;
  readonly estado: EstadoPrimerPaso;
  readonly obligatorio?: boolean;
  /** Quién lo cierra («Tú», «Atiende», «Meta», «Tu distribuidor del POS»). */
  readonly responsable?: string;
  /** Sucursales u objetos a los que aún les falta. */
  readonly faltantes?: readonly string[];
  readonly href?: string;
  /** false = lo hace otra persona: no cuenta para el avance y no lleva enlace. */
  readonly puedeHacerlo?: boolean;
}

export interface PrimerosPasosProps {
  readonly pasos: readonly PrimerPaso[] | null;
  readonly rolEtiqueta: string;
  readonly cargando?: boolean;
  readonly error?: string | null;
  readonly onReintentar?: () => void;
  /** Abre el recorrido guiado (boton secundario). */
  readonly onRecorrido?: () => void;
  /** Clave (sin datos personales) para recordar en el navegador qué hitos ya se celebraron, p. ej. «restaurantes:mi-org». */
  readonly claveCelebracion?: string;
  /** Tarjetas visibles antes de «Ver n tareas más». */
  readonly visibles?: number;
  /** Contenido extra bajo el encabezado (p. ej. un aviso del gate de la vertical). */
  readonly children?: React.ReactNode;
}

const CUENTAN = (p: PrimerPaso) => p.puedeHacerlo !== false && p.estado !== "externo" && p.estado !== "informativo";

/** Avance honesto: solo cuentan las tareas que este rol puede hacer ahora; las de terceros van aparte como «en espera». */
export function resumirPrimerosPasos(pasos: readonly PrimerPaso[]) {
  const propios = pasos.filter(CUENTAN);
  const hechos = propios.filter((p) => p.estado === "hecho").length;
  const enEspera = pasos.filter((p) => p.estado === "externo").length;
  const siguiente = propios.find((p) => p.estado === "pendiente" || p.estado === "parcial")?.id ?? null;
  const obligatorios = pasos.filter((p) => p.obligatorio);
  const listo = obligatorios.length > 0 && obligatorios.every((p) => p.estado === "hecho");
  return { hechos, total: propios.length, enEspera, siguiente, listo };
}

/** Hitos nuevos desde la ultima visita: ids «hecho» que no estaban en lo guardado. Primer render (sin nada guardado) no celebra. */
export function hitosNuevos(guardado: string | null, hechos: readonly string[]): string[] {
  if (guardado === null) return [];
  let previos: unknown;
  try {
    previos = JSON.parse(guardado);
  } catch {
    return [];
  }
  const set = new Set(Array.isArray(previos) ? previos.filter((x): x is string => typeof x === "string") : []);
  return hechos.filter((id) => !set.has(id));
}

const CLAVE_ESTADO: Record<EstadoPrimerPaso, ClaveGuia> = {
  hecho: "guia.estado.hecho",
  parcial: "guia.estado.parcial",
  pendiente: "guia.estado.pendiente",
  externo: "guia.estado.externo",
  bloqueado: "guia.estado.bloqueado",
  informativo: "guia.estado.informativo",
};

export function PrimerosPasos({ pasos, rolEtiqueta, cargando, error, onReintentar, onRecorrido, claveCelebracion, visibles = 6, children }: PrimerosPasosProps) {
  const idioma = useIdiomaGuia();
  const t = React.useMemo(() => traductorGuia(idioma), [idioma]);
  const resumen = React.useMemo(() => resumirPrimerosPasos(pasos ?? []), [pasos]);
  const [celebra, setCelebra] = React.useState<{ tipo: "listo" } | { tipo: "paso"; titulo: string } | null>(null);
  const barra = React.useRef<HTMLSpanElement>(null);
  const pct = resumen.total > 0 ? Math.round((resumen.hechos / resumen.total) * 100) : 0;
  React.useEffect(() => {
    barra.current?.style.setProperty("--guia-pct", `${pct}%`);
  }, [pct]);

  // Celebracion: compara los «hecho» de hoy con los de la ultima visita (guardados en el navegador). Nunca inventa un hito.
  React.useEffect(() => {
    if (!pasos || !claveCelebracion) return;
    const almacen = almacenDelNavegador();
    const clave = `atiende-guia.pp.${claveCelebracion}`;
    const hechos = pasos.filter((p) => p.estado === "hecho").map((p) => p.id);
    let guardado: string | null = null;
    try {
      guardado = almacen?.getItem(clave) ?? null;
    } catch {
      guardado = null;
    }
    const nuevos = hitosNuevos(guardado, hechos);
    const obligatorios = pasos.filter((p) => p.obligatorio).map((p) => p.id);
    if (nuevos.length > 0 && resumen.listo && nuevos.some((id) => obligatorios.includes(id))) setCelebra({ tipo: "listo" });
    else if (nuevos.length > 0) setCelebra({ tipo: "paso", titulo: pasos.find((p) => p.id === nuevos[0])?.titulo ?? "" });
    try {
      almacen?.setItem(clave, JSON.stringify(hechos));
    } catch {
      // sin almacenamiento: no hay celebracion la proxima vez, nada mas
    }
  }, [pasos, claveCelebracion, resumen.listo]);

  if (cargando && !pasos) return <EstadoCargando etiqueta={t("guia.pp.titulo")} />;
  if (error && !pasos) return <EstadoError mensaje={t("guia.pp.error")} onReintentar={onReintentar} />;
  const lista = pasos ?? [];
  const primeros = lista.slice(0, visibles);
  const resto = lista.slice(visibles);

  const tarjeta = (p: PrimerPaso) => {
    const siguiente = p.id === resumen.siguiente;
    const otro = p.puedeHacerlo === false;
    return (
      <li key={p.id} className="guia-pp-paso" data-estado={p.estado} data-siguiente={siguiente || undefined} data-guia-paso={p.id}>
        <div className="guia-pp-paso-cab">
          <h3>{p.titulo}</h3>
          <span className="guia-pp-pildora" data-estado={p.estado}>
            {t(CLAVE_ESTADO[p.estado])}
            {p.obligatorio ? ` · ${t("guia.pp.obligatorio")}` : ""}
          </span>
        </div>
        {siguiente ? <span className="guia-pp-recomendado">{t("guia.pp.recomendado")}</span> : null}
        <p>
          <span className="guia-pp-rotulo">{t("guia.pp.quePide")}: </span>
          {p.detalle}
        </p>
        {p.responsable ? (
          <p className="guia-pp-meta">
            <span className="guia-pp-rotulo">{t("guia.pp.quien")}: </span>
            {p.responsable}
          </p>
        ) : null}
        {p.faltantes && p.faltantes.length > 0 ? <p className="guia-pp-meta">{t("guia.pp.faltan", { lista: p.faltantes.join(", ") })}</p> : null}
        {p.href && !otro && p.estado !== "hecho" && p.estado !== "bloqueado" ? (
          <Link className="guia-pp-accion" to={p.href}>
            {t("guia.pp.abrir")}
          </Link>
        ) : null}
      </li>
    );
  };

  return (
    <div className="guia-pp" data-tour="clave">
      <div className="guia-pp-cab">
        <p className="guia-pp-como">{t("guia.pp.viendoComo", { rol: rolEtiqueta })}</p>
        <div className="guia-pp-progreso">
          <div className="guia-pp-barra" role="progressbar" aria-label={t("guia.pp.progresoAria")} aria-valuemin={0} aria-valuemax={resumen.total} aria-valuenow={resumen.hechos}>
            <span ref={barra} />
          </div>
          <strong>{t("guia.pp.progreso", { hechos: resumen.hechos, total: resumen.total })}</strong>
          {resumen.enEspera > 0 ? <span className="guia-pp-espera">{t("guia.pp.enEspera", { n: resumen.enEspera })}</span> : null}
          {onRecorrido ? (
            <button type="button" className="guia-pp-accion" onClick={onRecorrido}>
              {t("guia.pp.recorrido")}
            </button>
          ) : null}
        </div>
      </div>
      {celebra ? (
        <div className="guia-pp-celebra" role="status" data-guia-celebra={celebra.tipo}>
          <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
            <circle cx="20" cy="20" r="16" pathLength={1} className="ilu-traza" />
            <path d="M13 20.5 L18 25.5 L27 15" pathLength={1} className="ilu-traza d4" />
          </svg>
          <div>
            <h2>{celebra.tipo === "listo" ? t("guia.pp.listo.titulo") : t("guia.pp.paso.titulo", { titulo: celebra.titulo })}</h2>
            {celebra.tipo === "listo" ? <p>{t("guia.pp.listo.cuerpo")}</p> : null}
          </div>
        </div>
      ) : null}
      {children}
      <ol className="guia-pp-lista">{primeros.map(tarjeta)}</ol>
      {resto.length > 0 ? (
        <details className="guia-pp-mas">
          <summary>{t("guia.pp.verMas", { n: resto.length })}</summary>
          <ol className="guia-pp-lista">{resto.map(tarjeta)}</ol>
        </details>
      ) : null}
    </div>
  );
}

// Probador de conversación del Agente de WhatsApp: gemelo del probador de voz (voz/GloboLlamada.tsx + VistaPreviaLlamada de @atiende/ui).
//  · GLOBO flotante «Probar conversación» (logo oficial de WhatsApp) abajo a la derecha, mismas medidas y entrada que el de voz; se oculta mientras
//    la vista previa está abierta.
//  · VISTA PREVIA a pantalla completa (marco del shell en escritorio, <body> en móvil): cabecera «‹ Atrás», panel decorativo a la izquierda y el CHAT a
//    la derecha, con la forma de WhatsApp (cabecera con avatar y estado, fondo con patrón, burbujas con cola, hora y palomitas, separador de fecha,
//    agrupación, «escribiendo…», formato de texto, tarjeta del pedido simulado). Diálogo modal: foco atrapado, Escape y «Atrás» cierran.
// Conectado al agente REAL en modo preview (la lógica de simulación no cambió):
//  · el servidor corre las mismas herramientas SIN efectos: `crear_pedido` devuelve un pedido simulado PRUEBA-xxxx; nada se escribe ni se avisa a nadie;
//    el historial vive solo en el navegador;
//  · sin proveedor de IA el servidor contesta 503/429 y el chat lo dice tal cual en una burbuja del agente: nunca hay respuestas por palabras clave.
// Simular cliente, probar con los cambios sin guardar y Reiniciar viven en el encabezado. Estilos y variables --wa-* (re-tematizables): widget-whatsapp.css.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, CheckCheck, RotateCcw, Send, SlidersHorizontal } from "lucide-react";
import { Checkbox, FormField, Selector, useMarcoShell } from "@atiende/ui";
import { fechaCortaEsMx, hora24EsMx } from "../../../lib/formato-fecha.ts";
import { enviarMensajePrueba } from "../lib/agente-whatsapp-client.ts";
import type { ConfigAgenteForm, MensajePrueba } from "../lib/agente-whatsapp-client.ts";
import { fetchBranchTimezone } from "../lib/config-client.ts";
import { fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerSummary } from "../lib/customers-client.ts";
import { pedidoSimuladoDe } from "../lib/voz-client.ts";
import type { PedidoSimulado } from "../lib/voz-client.ts";
import { FormatoWhatsApp } from "./formato-whatsapp.tsx";
import { TarjetaPedidoSimulado } from "./TarjetaPedidoSimulado.tsx";
import { WhatsAppIcon } from "./WhatsAppIcon.tsx";
import "./widget-whatsapp.css";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Nombre que se muestra en el encabezado (sucursal activa). */
  readonly nombreNegocio?: string;
  /** Configuración del formulario (sin guardar): si se pasa, aparece «Probar con los cambios sin guardar» en las opciones. */
  readonly borrador?: ConfigAgenteForm;
}

type Mensaje =
  | { readonly id: string; readonly rol: "cliente" | "agente"; readonly texto: string; readonly hora: Date }
  | { readonly id: string; readonly rol: "sistema"; readonly texto: string; readonly hora: Date; readonly pedido: PedidoSimulado };

/** Tope del servidor (AGENTE_PREVIEW_LIMITES.maxMensajes). */
const LIMITE_MENSAJES = 40;
/** Mensaje del agente cuando algo falla, como en el original; el detalle honesto del servidor va debajo. */
const TEXTO_FALLO = "Ahorita no pude procesar tu mensaje — intenta de nuevo en un momento.";
const CONSULTA_ESCRITORIO = "(min-width: 768px)";
const ENFOCABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `true`/`false` según el ancho de la ventana; `null` sin matchMedia (pruebas). Misma regla que la vista previa de llamada. */
function useEscritorio(): boolean | null {
  return useSyncExternalStore(
    (aviso) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const mq = window.matchMedia(CONSULTA_ESCRITORIO);
      mq.addEventListener("change", aviso);
      return () => mq.removeEventListener("change", aviso);
    },
    () => (typeof window.matchMedia === "function" ? window.matchMedia(CONSULTA_ESCRITORIO).matches : null),
    () => null,
  );
}

/** Palomitas: una gris (enviado), dos grises (entregado) o dos azules (leído). El estado también va en texto para lectores de pantalla. */
function Palomitas({ leido, entregado }: { readonly leido: boolean; readonly entregado: boolean }) {
  const estado = leido ? "Leído" : entregado ? "Entregado" : "Enviado";
  return (
    <span className="wa-palomitas" data-estado={leido ? "leido" : entregado ? "entregado" : "enviado"}>
      {entregado ? <CheckCheck aria-hidden="true" strokeWidth={2.25} /> : <Check aria-hidden="true" strokeWidth={2.25} />}
      <span className="wa-solo-lectores">{estado}</span>
    </span>
  );
}

const nuevaSesion = (): string => crypto.randomUUID();
const inicial = (nombre: string): string => (nombre.trim().charAt(0) || "A").toLocaleUpperCase("es-MX");

export function WidgetWhatsApp({ apiBaseUrl, token, propertyId, nombreNegocio = "Agente de WhatsApp", borrador }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [opcionesAbiertas, setOpcionesAbiertas] = useState(false);
  const [sesionId, setSesionId] = useState(nuevaSesion);
  const [mensajes, setMensajes] = useState<readonly Mensaje[]>([]);
  const [borradorTexto, setBorradorTexto] = useState("");
  const [escribiendo, setEscribiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [usarBorrador, setUsarBorrador] = useState(false);
  const [clientes, setClientes] = useState<readonly CustomerSummary[]>([]);
  const [clienteId, setClienteId] = useState("");
  // Zona horaria de la sucursal para la hora de las burbujas; sin ella (o si falla) rige la de la plataforma (America/Mexico_City).
  const [zona, setZona] = useState<string | undefined>(undefined);
  const fin = useRef<HTMLDivElement | null>(null);
  const campo = useRef<HTMLInputElement | null>(null);
  const globo = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const yaAbrio = useRef(false);
  const idOpciones = useId();
  const marco = useMarcoShell();
  const escritorio = useEscritorio();
  // Móvil: pantalla completa fija sobre TODO, montada en <body>. Escritorio con marco del shell: cubre la barra superior y la página.
  const enBody = escritorio === false;

  // Clientes de la organización para «Simular cliente»: se piden en cada apertura.
  useEffect(() => {
    if (!abierto) return undefined;
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { limit: 25 })
      .then((p) => {
        if (!cancelado) setClientes(p.customers);
      })
      .catch(() => {
        if (!cancelado) setClientes([]);
      });
    return () => {
      cancelado = true;
    };
  }, [abierto, apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (!abierto) return undefined;
    let cancelado = false;
    fetchBranchTimezone(fetch, apiBaseUrl, token, propertyId)
      .then((c) => {
        if (!cancelado && c.zonaHoraria) setZona(c.zonaHoraria);
      })
      .catch(() => undefined);
    return () => {
      cancelado = true;
    };
  }, [abierto, apiBaseUrl, token, propertyId]);

  // Scroll automático al último mensaje (suave, salvo con movimiento reducido).
  useEffect(() => {
    const reducido = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    fin.current?.scrollIntoView?.({ behavior: reducido ? "auto" : "smooth", block: "end" });
  }, [mensajes, escribiendo, error, abierto]);

  // Diálogo modal: el foco entra al campo al abrir, Escape cierra y al cerrar vuelve al globo (que reaparece al cerrar).
  const alCerrar = useRef(() => setAbierto(false));
  useEffect(() => {
    if (!abierto) {
      if (yaAbrio.current) globo.current?.focus();
      return undefined;
    }
    yaAbrio.current = true;
    campo.current?.focus();
    const alTeclear = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // La lista de Simular cliente vive en un portal: Escape con ella abierta cierra solo la lista.
      if ((e.target as HTMLElement | null)?.closest?.('[role="listbox"]') || document.querySelector('[role="listbox"]')) return;
      e.stopPropagation();
      alCerrar.current();
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [abierto]);

  function reiniciar() {
    setSesionId(nuevaSesion());
    setMensajes([]);
    setError(null);
    setAviso(null);
    setBorradorTexto("");
  }

  async function enviar() {
    const limpio = borradorTexto.trim();
    if (!limpio || escribiendo) return;
    // El servidor acepta hasta 40 mensajes por prueba: antes de rebasarlos se reinicia sola la conversación (sin esperar un 400 técnico).
    if (mensajes.filter((m) => m.rol !== "sistema").length + 1 > LIMITE_MENSAJES) {
      reiniciar();
      setBorradorTexto(limpio);
      setAviso(`La conversación de prueba llegó al límite de ${LIMITE_MENSAJES} mensajes y se reinició. Vuelve a enviar tu mensaje.`);
      return;
    }
    setAviso(null);
    const mio: Mensaje = { id: crypto.randomUUID(), rol: "cliente", texto: limpio, hora: new Date() };
    const antes = mensajes;
    const historial: readonly MensajePrueba[] = [...antes, mio].flatMap((m): MensajePrueba[] => (m.rol === "sistema" ? [] : [{ rol: m.rol === "cliente" ? "usuario" : "agente", texto: m.texto }]));
    setMensajes([...antes, mio]);
    setBorradorTexto("");
    setEscribiendo(true);
    setError(null);
    try {
      const r = await enviarMensajePrueba(fetch, apiBaseUrl, token, propertyId, { sesionId, mensajes: historial, clienteSimuladoId: clienteId || null, borrador: usarBorrador && borrador ? borrador : null });
      const nuevos: Mensaje[] = [mio, { id: crypto.randomUUID(), rol: "agente", texto: r.respuesta, hora: new Date() }];
      const simulado = pedidoSimuladoDe({ order: r.pedidoSimulado });
      if (simulado) nuevos.push({ id: crypto.randomUUID(), rol: "sistema", texto: `Pedido simulado · ${simulado.folio} · Prueba`, hora: new Date(), pedido: simulado });
      setMensajes([...antes, ...nuevos]);
    } catch (err) {
      // El mensaje del cliente se quita para que pueda reenviarlo: el servidor no guardó nada de este turno.
      setMensajes(antes);
      setBorradorTexto(limpio);
      setError(err instanceof Error ? err.message : "No se pudo probar el agente.");
    } finally {
      setEscribiendo(false);
    }
  }

  // Tab no sale del diálogo (foco atrapado).
  function atraparTab(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(ENFOCABLES));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const primero = items[0]!;
    const ultimo = items[items.length - 1]!;
    const dentro = panel.current.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === primero || document.activeElement === panel.current || !dentro)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && (document.activeElement === ultimo || !dentro)) {
      e.preventDefault();
      primero.focus();
    }
  }

  const noDisponible = error?.startsWith("No disponible") ?? false;
  const hayMensajes = mensajes.length > 0;
  const hoy = fechaCortaEsMx(new Date(), zona);
  const estadoChat = escribiendo ? "escribiendo…" : "En línea";
  const chip = escribiendo ? "● Escribiendo" : hayMensajes ? "● Conversación" : "Vista previa";
  // Palomitas: azules cuando el agente ya contestó después de ese mensaje; grises (entregado) mientras espera.
  const ultimoAgente = mensajes.reduce((acc, m, i) => (m.rol === "agente" ? i : acc), -1);

  const vista = (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={`Vista previa de conversación: Agente de WhatsApp de ${nombreNegocio}`}
      tabIndex={-1}
      onKeyDown={atraparTab}
      className={`wa-widget wa-vista voz-aparece ${enBody ? "wa-vista--fija" : "wa-vista--marco"}`}
      data-testid="chat-whatsapp"
    >
      <header className="wa-top">
        <div className="wa-top__izq">
          <button type="button" className="wa-atras" onClick={() => setAbierto(false)} aria-label="Cerrar la vista previa, volver atrás" data-testid="cerrar-chat-whatsapp">
            ‹ Atrás
          </button>
          <span className="wa-top__sep" aria-hidden="true">
            |
          </span>
          <div className="wa-top__titulo">
            <p>Agente de WhatsApp</p>
            <p>{nombreNegocio}</p>
          </div>
        </div>
        <div className="wa-top__der">
          <button type="button" className="wa-icono" onClick={reiniciar} disabled={escribiendo} aria-label="Reiniciar conversación" title="Reiniciar conversación" data-testid="reiniciar-prueba">
            <RotateCcw aria-hidden="true" strokeWidth={1.75} />
          </button>
          <button type="button" className="wa-icono" onClick={() => setOpcionesAbiertas((v) => !v)} aria-expanded={opcionesAbiertas} aria-controls={idOpciones} aria-label="Opciones de prueba" title="Opciones de prueba">
            <SlidersHorizontal aria-hidden="true" strokeWidth={1.75} />
          </button>
          <span data-testid="chip-estado" className="wa-chip" data-activo={escribiendo || hayMensajes ? "true" : undefined}>
            {chip}
          </span>
        </div>
      </header>

      {opcionesAbiertas ? (
        <div id={idOpciones} className="wa-opciones" role="group" aria-label="Opciones de prueba">
          <FormField label="Simular cliente" {...(hayMensajes ? { hint: "Reinicia la conversación para cambiar de cliente." } : {})}>
            <Selector value={clienteId} onChange={(e) => setClienteId(e.target.value)} disabled={hayMensajes}>
              <option value="">Cliente nuevo</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? "Sin nombre"} · {c.orderCount} {c.orderCount === 1 ? "pedido" : "pedidos"}
                </option>
              ))}
            </Selector>
          </FormField>
          {borrador ? <Checkbox label="Probar con los cambios sin guardar" checked={usarBorrador} onChange={(e) => setUsarBorrador(e.target.checked)} /> : null}
        </div>
      ) : null}

      <div className="wa-cuerpo-vista">
        <aside className="wa-lateral">
          <span className="wa-lateral__logo">
            <WhatsAppIcon />
          </span>
          <p className="wa-lateral__titulo">{hayMensajes ? "Conversación de prueba en curso" : "Aún no hay una conversación"}</p>
          <p className="wa-lateral__texto">Escríbele al agente como lo haría un cliente. Puede tomar un pedido de principio a fin, pero es una prueba: no se crean pedidos ni se avisa a nadie.</p>
        </aside>

        <section className="wa-chat" aria-label="Chat de prueba">
          <div className="wa-chat__cabecera">
            <span className="wa-avatar" aria-hidden="true">
              {inicial(nombreNegocio)}
            </span>
            <div className="wa-chat__cabecera-texto">
              <p className="wa-chat__nombre">{nombreNegocio}</p>
              <p className="wa-chat__estado">{estadoChat} · Prueba</p>
            </div>
          </div>

          <div className="wa-cuerpo" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversación de prueba">
            {!hayMensajes && !error ? (
              <div className="wa-vacio">
                <p>
                  Escríbele al agente de WhatsApp de {nombreNegocio} como lo haría un cliente. Puede tomar un pedido de principio a fin, pero es una prueba: no se crean pedidos ni se avisa a nadie.
                </p>
              </div>
            ) : null}

            {mensajes.map((m, i) => {
              const previo = mensajes[i - 1];
              const dia = fechaCortaEsMx(m.hora, zona);
              const separador = !previo || fechaCortaEsMx(previo.hora, zona) !== dia ? (dia === hoy ? "Hoy" : dia) : null;
              const sep = separador ? (
                <div className="wa-fecha" key={`f-${m.id}`}>
                  <span>{separador}</span>
                </div>
              ) : null;
              if (m.rol === "sistema") {
                return (
                  <div key={m.id} className="wa-sistema">
                    {sep}
                    <span className="wa-sistema__pildora">{m.texto}</span>
                    <div className="wa-sistema__tarjeta">
                      <TarjetaPedidoSimulado pedido={m.pedido} compacta />
                    </div>
                  </div>
                );
              }
              const primero = !previo || previo.rol !== m.rol || separador !== null;
              const pie = (
                <span className="wa-hora">
                  {hora24EsMx(m.hora, zona)}
                  {m.rol === "cliente" ? <Palomitas entregado leido={i < ultimoAgente} /> : null}
                </span>
              );
              return (
                <div key={m.id} className="wa-grupo">
                  {sep}
                  <div className={`wa-fila wa-fila--${m.rol}`} data-primero={primero ? "true" : undefined}>
                    <div className={`wa-burbuja wa-burbuja--${m.rol}`} data-cola={primero ? "true" : undefined}>
                      <span className="wa-solo-lectores">{m.rol === "cliente" ? "Cliente: " : "Agente: "}</span>
                      <FormatoWhatsApp texto={m.texto} fin={pie} />
                    </div>
                  </div>
                </div>
              );
            })}

            {escribiendo ? (
              <div className="wa-fila wa-fila--agente" role="status" data-primero="true">
                <span className="wa-solo-lectores">El agente está escribiendo…</span>
                <div className="wa-escribiendo wa-burbuja--agente" data-cola="true" aria-hidden="true">
                  <span className="wa-punto" />
                  <span className="wa-punto" />
                  <span className="wa-punto" />
                </div>
              </div>
            ) : null}

            {aviso ? (
              <div className="wa-sistema" role="status" data-testid="aviso-limite">
                <span className="wa-sistema__pildora">{aviso}</span>
              </div>
            ) : null}

            {error ? (
              <div className="wa-fila wa-fila--agente" role="alert" data-testid="error-prueba" data-primero="true">
                <div className="wa-burbuja wa-burbuja--agente wa-burbuja--error" data-cola="true">
                  <span>{noDisponible ? "Por ahora no puedo contestar." : TEXTO_FALLO}</span>
                  <span className="wa-burbuja__detalle">{error}</span>
                </div>
              </div>
            ) : null}
            <div ref={fin} />
          </div>

          <form
            className="wa-barra"
            onSubmit={(e) => {
              e.preventDefault();
              void enviar();
            }}
          >
            <input ref={campo} className="wa-campo" aria-label="Mensaje de prueba" maxLength={1000} value={borradorTexto} placeholder="Escribe un mensaje" onChange={(e) => setBorradorTexto(e.target.value)} disabled={escribiendo} autoComplete="off" />
            <button type="submit" className="wa-enviar" aria-label="Enviar mensaje" disabled={escribiendo || borradorTexto.trim() === ""}>
              <Send aria-hidden="true" strokeWidth={2} />
            </button>
          </form>
        </section>
      </div>
    </div>
  );

  const destino = enBody ? document.body : escritorio && marco ? marco : null;

  return (
    <>
      {abierto ? null : createPortal(
        <div className="wa-widget">
          <button
            ref={globo}
            type="button"
            className="globo-whatsapp"
            data-testid="globo-whatsapp"
            aria-label="Probar conversación con el agente de WhatsApp (vista previa)"
            onClick={() => setAbierto(true)}
          >
            <span className="globo-whatsapp__logo" aria-hidden="true">
              <WhatsAppIcon />
            </span>
            <span>Probar conversación</span>
          </button>
        </div>,
        document.body,
      )}
      {abierto ? (destino ? createPortal(vista, destino) : vista) : null}
    </>
  );
}

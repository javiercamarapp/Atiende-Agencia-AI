// Dialogo de "Chatea con tus datos": presentacional (sin red ni estado de negocio). El shell de cada
// vertical lo conecta a su API; el motor y el catalogo viven en el backend (docs/DATA-CHAT.md).
// Muestra lo que el servidor ya verifico: las tablas y graficas salen de los RESULTADOS de las
// consultas (nunca del texto del modelo) y cada respuesta cita de que datos sale, el periodo y el
// alcance. Todo es texto de React (escapado): ningun dato se interpreta como HTML.
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MessageCircle, SendHorizonal } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "../lib/utils";

export type ChatDatosColumnKind = "text" | "integer" | "mxn" | "percent" | "decimal";
export type ChatDatosCell = string | number | null;

export interface ChatDatosColumna {
  readonly key: string;
  readonly label: string;
  readonly kind: ChatDatosColumnKind;
}

export interface ChatDatosBloque {
  readonly tool: string;
  readonly title: string;
  readonly columns: readonly ChatDatosColumna[];
  readonly rows: readonly Readonly<Record<string, ChatDatosCell>>[];
  readonly chart?: { readonly kind: "bar" | "line"; readonly x: string; readonly y: string };
  readonly truncated: boolean;
}

export interface ChatDatosFuente {
  readonly source: string;
  readonly periodLabel?: string;
  readonly scopeLabel: string;
}

/** MODO SIN IA: cuando el asistente no puede usar el modelo, el servidor devuelve el catalogo de consultas directas. */
export interface ChatDatosOpcionSinIa {
  readonly tool: string;
  readonly label: string;
  readonly description: string;
}

export interface ChatDatosSinIa {
  readonly reason: "provider_down" | "budget" | "kill_switch";
  readonly options: readonly ChatDatosOpcionSinIa[];
}

export interface ChatDatosMensaje {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Estado de la respuesta del servidor (ok, no_data, clarify, out_of_catalog, rate_limited, budget_exceeded, unavailable...). */
  readonly status?: string;
  readonly blocks?: readonly ChatDatosBloque[];
  readonly sources?: readonly ChatDatosFuente[];
  /** Presente solo cuando la respuesta se dio sin IA: sus `options` se ofrecen como botones de consulta directa. */
  readonly noAi?: ChatDatosSinIa;
}

export interface ChatDatosDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly nombreNegocio?: string;
  readonly mensajes: readonly ChatDatosMensaje[];
  readonly enviando: boolean;
  readonly onEnviar: (pregunta: string) => void;
  /** Ejecuta una consulta directa del modo sin IA (boton de `noAi.options`). Sin el, las opciones no se muestran como botones. */
  readonly onEjecutarOpcion?: (opcion: ChatDatosOpcionSinIa) => void;
  /** Preguntas de ejemplo (solo cubren lo que el catalogo de la vertical sabe responder). */
  readonly sugerencias?: readonly string[];
  readonly maxCaracteres?: number;
}

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const int = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 2 });

export function formatChatCell(kind: ChatDatosColumnKind, value: ChatDatosCell): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  switch (kind) {
    case "mxn":
      return `${mxn.format(value)} MXN`;
    case "integer":
      return int.format(value);
    case "percent":
      return `${dec.format(value)}%`;
    case "decimal":
      return dec.format(value);
    default:
      return String(value);
  }
}

function numericValue(v: ChatDatosCell | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Grafica simple y accesible (barras CSS / linea SVG) con la MISMA informacion que la tabla de abajo. */
function GraficaSimple({ bloque }: { bloque: ChatDatosBloque }) {
  const chart = bloque.chart;
  if (!chart || bloque.rows.length < 2) return null;
  const col = bloque.columns.find((c) => c.key === chart.y);
  const kind = col?.kind ?? "decimal";
  const points = bloque.rows.map((r) => ({ label: formatChatCell("text", r[chart.x] ?? null), value: numericValue(r[chart.y]) }));
  const max = Math.max(...points.map((p) => p.value), 0);
  const resumen = `Gráfica de ${col?.label ?? chart.y} por ${bloque.columns.find((c) => c.key === chart.x)?.label ?? chart.x}: ${points.map((p) => `${p.label} ${formatChatCell(kind, p.value)}`).join("; ")}`;

  if (chart.kind === "line") {
    const w = 300;
    const h = 80;
    const step = points.length > 1 ? w / (points.length - 1) : w;
    const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(h - (max > 0 ? (p.value / max) * (h - 8) : 0) - 4).toFixed(1)}`).join(" ");
    return (
      <svg role="img" aria-label={resumen} viewBox={`0 0 ${w} ${h}`} className="w-full h-20 text-primary" preserveAspectRatio="none">
        <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }
  return (
    <div role="img" aria-label={resumen} className="flex flex-col gap-1">
      {points.slice(0, 12).map((p, i) => (
        <div key={`${p.label}-${i}`} className="flex items-center gap-2 text-[11px]" aria-hidden="true">
          <span className="w-24 shrink-0 truncate text-muted-foreground">{p.label}</span>
          <span className="h-2.5 rounded-sm bg-primary/80" style={{ width: `${max > 0 ? Math.max((p.value / max) * 100, 2) : 0}%` }} />
        </div>
      ))}
    </div>
  );
}

function BloqueTabla({ bloque }: { bloque: ChatDatosBloque }) {
  return (
    <section aria-label={bloque.title} className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-foreground">{bloque.title}</h4>
      <GraficaSimple bloque={bloque} />
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {bloque.columns.map((c) => (
                <TableHead key={c.key} className={cn("h-8 px-2 text-[11px]", c.kind !== "text" && "text-right")}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {bloque.rows.map((row, i) => (
              <TableRow key={i}>
                {bloque.columns.map((c) => (
                  <TableCell key={c.key} className={cn("px-2 py-1.5 text-xs", c.kind !== "text" && "text-right tabular-nums")}>
                    {formatChatCell(c.kind, row[c.key] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {bloque.truncated ? <p className="text-[11px] text-muted-foreground">Se muestran las primeras filas; hay más datos que no caben aquí.</p> : null}
    </section>
  );
}

function Fuentes({ fuentes }: { fuentes: readonly ChatDatosFuente[] }) {
  if (fuentes.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 border-t border-border pt-2 text-[11px] text-muted-foreground" aria-label="Fuente de los datos">
      {fuentes.map((f, i) => (
        <li key={i}>
          <span className="font-medium">Fuente:</span> {f.source}
          {f.periodLabel ? (
            <>
              {" · "}
              <span className="font-medium">Periodo:</span> {f.periodLabel}
            </>
          ) : null}
          {" · "}
          <span className="font-medium">Alcance:</span> {f.scopeLabel}
        </li>
      ))}
    </ul>
  );
}

const AVISO_POR_ESTADO: Readonly<Record<string, string>> = {
  no_data: "Sin datos para ese periodo",
  out_of_catalog: "Fuera de lo que puedo consultar",
  unavailable: "No disponible por ahora",
  rate_limited: "Demasiadas preguntas seguidas",
  budget_exceeded: "Tope de uso alcanzado",
};

function OpcionesSinIa({ opciones, deshabilitado, onEjecutar }: { opciones: readonly ChatDatosOpcionSinIa[]; deshabilitado: boolean; onEjecutar: (o: ChatDatosOpcionSinIa) => void }) {
  if (opciones.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label="Consultas directas sin IA">
      <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">Consultas directas</p>
      <div className="flex flex-wrap gap-2">
        {opciones.map((o) => (
          <button
            key={o.tool}
            type="button"
            title={o.description}
            disabled={deshabilitado}
            onClick={() => onEjecutar(o)}
            className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Burbuja({ m, enviando, onEjecutarOpcion }: { m: ChatDatosMensaje; enviando: boolean; onEjecutarOpcion?: (o: ChatDatosOpcionSinIa) => void }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap break-words">{m.text}</p>
      </div>
    );
  }
  const aviso = m.status ? AVISO_POR_ESTADO[m.status] : undefined;
  return (
    <div className="flex">
      <div className="flex w-full max-w-[95%] flex-col gap-3 rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2.5">
        {aviso ? <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{aviso}</p> : null}
        <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">{m.text}</p>
        {(m.blocks ?? []).map((b, i) => (
          <BloqueTabla key={`${b.tool}-${i}`} bloque={b} />
        ))}
        <Fuentes fuentes={m.sources ?? []} />
        {m.noAi && onEjecutarOpcion ? <OpcionesSinIa opciones={m.noAi.options} deshabilitado={enviando} onEjecutar={onEjecutarOpcion} /> : null}
      </div>
    </div>
  );
}

export function ChatDatosDialog({ open, onOpenChange, nombreNegocio, mensajes, enviando, onEnviar, onEjecutarOpcion, sugerencias = [], maxCaracteres = 600 }: ChatDatosDialogProps) {
  const [texto, setTexto] = useState("");
  const inputId = useId();
  const finRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView?.({ block: "end" });
  }, [mensajes.length, enviando]);

  function enviar(e?: FormEvent) {
    e?.preventDefault();
    const pregunta = texto.trim();
    if (!pregunta || enviando) return;
    setTexto("");
    onEnviar(pregunta);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-3 p-4 sm:p-6 rest:p-4 rest:sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            Chatea con tus datos
          </DialogTitle>
          <DialogDescription>
            Pregunta sobre {nombreNegocio ?? "tu negocio"}. Solo consulto tus datos (no modifico nada) y siempre te digo de dónde salen las cifras.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[12rem] flex-1 flex-col gap-3 overflow-y-auto pr-1" role="log" aria-live="polite" aria-label="Conversación">
          {mensajes.length === 0 ? (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>Prueba con una pregunta como:</p>
              <div className="flex flex-wrap gap-2">
                {sugerencias.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={enviando}
                    onClick={() => onEnviar(s)}
                    className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            mensajes.map((m) => <Burbuja key={m.id} m={m} enviando={enviando} onEjecutarOpcion={onEjecutarOpcion} />)
          )}
          {enviando ? (
            <p role="status" className="text-xs text-muted-foreground">
              Consultando tus datos…
            </p>
          ) : null}
          <div ref={finRef} />
        </div>

        <form onSubmit={enviar} className="flex items-center gap-2">
          <label htmlFor={inputId} className="sr-only">
            Tu pregunta sobre los datos
          </label>
          <Input
            id={inputId}
            value={texto}
            maxLength={maxCaracteres}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Ej. ¿Cuánto vendí esta semana?"
            autoComplete="off"
            disabled={enviando}
          />
          <Button type="submit" size="sm" disabled={enviando || texto.trim().length === 0} aria-label="Enviar pregunta">
            <SendHorizonal className="h-4 w-4" aria-hidden="true" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

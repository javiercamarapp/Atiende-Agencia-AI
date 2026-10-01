// Harness de las pruebas del Copiloto: react-dom/client + jsdom directo (como apps/web/tests/test-utils/render.tsx,
// sin @testing-library) y un transporte FALSO controlable. Los dobles viven solo aqui, nunca en el componente.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import type {
  ChatDatosShellProps,
  CopilotoEvento,
  CopilotoRespuesta,
  CopilotoTransporte,
} from "../src/components/copiloto/tipos";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// jsdom no implementa canvas: CampoPixeles sale temprano si no hay contexto.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

export interface Montado {
  readonly container: HTMLElement;
  unmount(): void;
}

export function montar(el: ReactElement, ruta = "/"): Montado {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<MemoryRouter initialEntries={[ruta]}>{el}</MemoryRouter>);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function limpiarDom() {
  document.body.innerHTML = "";
}

export async function microtareas() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function clic(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function escribir(el: HTMLTextAreaElement | HTMLInputElement, valor: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    set?.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function tecla(el: Element, key: string, init: KeyboardEventInit = {}) {
  let evento!: KeyboardEvent;
  act(() => {
    evento = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(evento);
  });
  return evento;
}

export function porEtiqueta<T extends HTMLElement = HTMLElement>(raiz: ParentNode, etiqueta: string): T {
  const el = raiz.querySelector<T>(`[aria-label="${etiqueta}"]`);
  if (!el) throw new Error(`No hay elemento con aria-label="${etiqueta}"`);
  return el;
}

export function porTexto<T extends HTMLElement = HTMLElement>(raiz: ParentNode, selector: string, texto: string | RegExp): T {
  const el = Array.from(raiz.querySelectorAll<T>(selector)).find((e) =>
    typeof texto === "string" ? e.textContent?.trim() === texto : texto.test(e.textContent ?? ""),
  );
  if (!el) throw new Error(`No hay <${selector}> con texto ${String(texto)}`);
  return el;
}

export const FASES: ChatDatosShellProps["textos"]["fases"] = [
  [0, "Leyendo tus pedidos…"],
  [3000, "Calculando cifras…"],
  [9000, "Cruzando cifras…"],
  [17000, "Preparando la respuesta…"],
  [30000, "Esto está tardando más de lo normal…"],
];

export function propsBase(transporte: CopilotoTransporte, extra: Partial<ChatDatosShellProps> = {}): ChatDatosShellProps {
  return {
    transporte,
    textos: {
      titulo: "Pregunta a tus datos",
      subtitulo: "Tu operación, con la cifra que ya calculó el sistema.",
      nota: "Responde con cifras ya calculadas en el servidor; si no hay dato, te lo dice. No inventa números.",
      placeholder: "Pregunta sobre tu operación…",
      fases: FASES,
    },
    sugerencias: ["¿Cuánto vendí esta semana?", "¿Cuál es mi ticket medio?"],
    categorias: [
      { titulo: "Ventas", preguntas: ["Ventas por día", "Ticket medio"] },
      { titulo: "Operación", preguntas: ["Pedidos por canal"] },
      { titulo: "Clientes", preguntas: ["Clientes recurrentes"] },
    ],
    etiquetasHerramienta: { ventas_por_dia: "Leyendo ventas por día", ticket_medio: "Calculando el ticket medio" },
    maxCaracteres: 600,
    ...extra,
  };
}

export const RESPUESTA_OK: CopilotoRespuesta = {
  text: "Vendiste $2,480.75 MXN.\nSegunda línea.",
  status: "ok",
  seq: 2,
  blocks: [
    {
      tool: "ventas_por_dia",
      title: "Ventas por día",
      columns: [
        { key: "periodo", label: "Día", kind: "text" },
        { key: "ventas", label: "Ventas", kind: "mxn" },
      ],
      rows: [
        { periodo: "2026-09-28", ventas: 1500.5 },
        { periodo: "2026-09-29", ventas: 980.25 },
      ],
      truncated: false,
    },
  ],
  sources: [{ tool: "ventas_por_dia", source: "Pedidos", periodLabel: "Últimos 7 días", scopeLabel: "Todas tus sucursales" }],
};

export interface Pendiente<T> {
  promesa: Promise<T>;
  resolver(v: T): void;
  rechazar(e: unknown): void;
}
export function pendiente<T>(): Pendiente<T> {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

type ArgsEnviar = Parameters<CopilotoTransporte["enviar"]>[0];

/** Transporte falso: `enviar` es un vi.fn que por defecto responde RESPUESTA_OK; `rechazaAlAbortar` imita fetch. */
export function transporteFalso(over: Partial<CopilotoTransporte> = {}) {
  const enviar = vi.fn<(p: ArgsEnviar) => Promise<CopilotoRespuesta>>(async () => RESPUESTA_OK);
  const t: CopilotoTransporte = { enviar, ...over };
  return { t, enviar };
}

/** Envio que queda colgado hasta que el test lo resuelve; rechaza con AbortError si se aborta. */
export function envioColgado() {
  const p = pendiente<CopilotoRespuesta>();
  const eventos: Array<(e: CopilotoEvento) => void> = [];
  let senal: AbortSignal | undefined;
  const enviar = vi.fn((args: ArgsEnviar) => {
    senal = args.senal;
    eventos.push(args.onEvento);
    args.senal.addEventListener("abort", () => p.rechazar(new DOMException("abortado", "AbortError")));
    return p.promesa;
  });
  return { enviar, p, emitir: (e: CopilotoEvento) => eventos.forEach((f) => f(e)), senal: () => senal };
}

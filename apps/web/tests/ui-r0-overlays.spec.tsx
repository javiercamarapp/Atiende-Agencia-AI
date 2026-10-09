// @vitest-environment jsdom
//
// UNI-R0: familia unica de overlays. Modal con tamanos y cabecera con icono, FormDialogElegante, ConfirmDialog
// destructivo con icono, Toaster (region asertiva, limite apilado, barra de autocierre), centro de notificaciones,
// Panel y EstadoVacio. Teclado, foco, aria y reduced-motion (el CSS global apaga animaciones: se verifica el contrato).
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CentroNotificaciones,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EstadoVacio,
  FormDialogElegante,
  NotificationBell,
  Panel,
  TAMANOS_MODAL,
  TOASTS_VISIBLES,
  Toaster,
  notify,
  type CentroNotificacionItem,
} from "@atiende/ui";
import { click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const dialogo = () => document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;
const boton = (t: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t)!;

describe("Dialog: tamanos y cabecera con icono", () => {
  it.each(Object.entries(TAMANOS_MODAL))("size=%s aplica %s y el valor por defecto es md", (size, clase) => {
    rendered = renderComponent(
      <Dialog open>
        <DialogContent size={size as keyof typeof TAMANOS_MODAL}>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(dialogo().className).toContain(clase);
    expect(TAMANOS_MODAL.md).toBe("max-w-lg");
  });

  it("DialogHeader con icono pinta la insignia circular (decorativa) y conserva titulo y descripcion enlazados", () => {
    rendered = renderComponent(
      <Dialog open>
        <DialogContent>
          <DialogHeader icono={Trash2} tono="danger">
            <DialogTitle>Eliminar</DialogTitle>
            <DialogDescription>No se puede deshacer</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button>OK</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const chip = dialogo().querySelector<HTMLElement>('span[aria-hidden="true"].rounded-full')!;
    expect(chip.className).toContain("bg-destructive-tint");
    expect(document.getElementById(dialogo().getAttribute("aria-labelledby")!)?.textContent).toBe("Eliminar");
    expect(dialogo().querySelector("[class*='sm:justify-end']")).not.toBeNull();
  });

  it("Escape cierra, clic en el overlay cierra y el foco vuelve al disparador", async () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    keydown(document.activeElement ?? dialogo(), "Escape");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("FormDialogElegante", () => {
  it("cabecera centrada con insignia, franja de marca, titulo accesible y boton de ancho completo", () => {
    const onGuardar = vi.fn();
    rendered = renderComponent(
      <FormDialogElegante open onOpenChange={() => {}} icono={Trash2} titulo="Editar horario" subtitulo="Dias y horas" onGuardar={onGuardar}>
        <input aria-label="Nombre" />
      </FormDialogElegante>,
    );
    const d = dialogo();
    expect(d.querySelector(".bg-gradient-to-r")?.className).toContain("to-franja");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Editar horario");
    expect(boton("Guardar cambios").className).toContain("w-full");
    click(boton("Guardar cambios"));
    // el boton es submit dentro de <form>: Enter/clic guarda
    act(() => d.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onGuardar).toHaveBeenCalled();
  });

  it("bloquearCierre ignora Escape y oculta la x", () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(
      <FormDialogElegante open onOpenChange={onOpenChange} titulo="Guardando" bloquearCierre>
        <p>cuerpo</p>
      </FormDialogElegante>,
    );
    keydown(document.activeElement ?? dialogo(), "Escape");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialogo().querySelector('button[class*="size-11"]')).toBeNull();
  });
});

describe("ConfirmDialog destructivo", () => {
  it("lleva icono de alerta en tono peligro; el foco inicial queda en Cancelar", () => {
    rendered = renderComponent(<ConfirmDialog open onOpenChange={() => {}} titulo="Cancelar pedido" tono="danger" onConfirm={() => {}} />);
    expect(dialogo().getAttribute("role")).toBe("alertdialog");
    expect(dialogo().querySelector("span.bg-destructive-tint")).not.toBeNull();
    expect(document.activeElement).toBe(boton("Cancelar"));
  });
});

describe("Toaster / notify", () => {
  it("limite de apilado, posicion fija y region asertiva solo para errores", async () => {
    expect(TOASTS_VISIBLES).toBe(3);
    rendered = renderComponent(<Toaster />);
    const region = () => document.body.querySelector<HTMLElement>('[data-testid="toaster-asertivo"]')!;
    expect(region().getAttribute("aria-live")).toBe("assertive");
    expect(region().getAttribute("role")).toBe("alert");
    await act(async () => {
      notify.success("Guardado");
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(region().textContent).toBe("");
    await act(async () => {
      notify.error("No se pudo guardar", { description: "Sin conexion" });
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(region().textContent).toBe("No se pudo guardar. Sin conexion");
    const lista = document.body.querySelector("[data-sonner-toaster]")!;
    expect(lista.getAttribute("data-y-position")).toBe("bottom");
    expect(lista.getAttribute("data-x-position")).toBe("right");
    await act(async () => {
      notify.dismiss();
      await flushMicrotasks();
    });
  });

  it("cada toast lleva su duracion para la barra de autocierre; las persistentes (con accion) no tienen barra", async () => {
    rendered = renderComponent(<Toaster />);
    await act(async () => {
      notify.warning("Aviso");
      notify.success("Borrado", { deshacer: { onClick: () => {} } });
      await new Promise((r) => setTimeout(r, 80));
    });
    const toasts = [...document.body.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
    const estilos = toasts.map((t) => t.getAttribute("style") ?? "");
    expect(estilos.some((e) => e.includes("--toast-ms: 6000ms"))).toBe(true);
    expect(estilos.some((e) => e.includes("--toast-ms: 0ms"))).toBe(true);
    expect(toasts.every((t) => t.className.includes("toast-progreso"))).toBe(true);
    await act(async () => {
      notify.dismiss();
      await new Promise((r) => setTimeout(r, 260));
    });
  });

  it("la barra de autocierre se apaga con prefers-reduced-motion y se pausa al pasar el cursor (contrato del CSS)", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/ui/src/index.css"), "utf8");
    expect(css).toMatch(/\.toast-progreso:hover::after[^}]*animation-play-state:\s*paused/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.toast-progreso::after\s*\{\s*display:\s*none/);
  });
});

describe("CentroNotificaciones", () => {
  const items: CentroNotificacionItem[] = [
    { id: "1", titulo: "Pedido nuevo", cuerpo: "Mesa 4", cuando: "hace 2 min", severidad: "atencion", sinLeer: true, enlace: "/restaurantes/x/pedidos" },
    { id: "2", titulo: "Reporte listo", cuando: "ayer", severidad: "info", sinLeer: false },
  ];
  const montar = (extra: Partial<React.ComponentProps<typeof CentroNotificaciones>> = {}) =>
    (rendered = renderComponent(
      <MemoryRouter>
        <CentroNotificaciones href="/restaurantes/x/notificaciones" hayNoLeidas items={items} estado="listo" {...extra} />
      </MemoryRouter>,
    ));
  const campana = () => document.body.querySelector<HTMLElement>('button[data-no-leidas]')!;

  it("la campana abre un popover con lista, no leidas con punto, y 'Ver todas' lleva a la pagina", async () => {
    const onAbrir = vi.fn();
    montar({ onAbrir });
    expect(campana().getAttribute("aria-label")).toBe("Notificaciones: hay avisos sin leer");
    click(campana());
    await act(async () => flushMicrotasks());
    expect(onAbrir).toHaveBeenCalledTimes(1);
    const filas = [...document.body.querySelectorAll('[data-testid="centro-item"]')];
    expect(filas).toHaveLength(2);
    expect(document.body.querySelectorAll('[data-testid="centro-sin-leer"]')).toHaveLength(1);
    expect(document.body.querySelector('a[href="/restaurantes/x/notificaciones"]')?.textContent).toContain("Ver todas");
    expect(filas[0]!.textContent).toContain("Requiere atención");
  });

  it("marcar todas y leer una llaman a los handlers; Escape cierra y devuelve el foco a la campana", async () => {
    const onMarcarTodas = vi.fn();
    const onLeer = vi.fn();
    montar({ onMarcarTodas, onLeer });
    click(campana());
    await act(async () => flushMicrotasks());
    click(boton("Marcar todas"));
    expect(onMarcarTodas).toHaveBeenCalled();
    click(document.body.querySelector('[data-testid="centro-item"] a')!);
    expect(onLeer).toHaveBeenCalledWith("1");
    click(campana());
    await act(async () => flushMicrotasks());
    keydown(document.activeElement ?? document.body, "Escape");
    await act(async () => flushMicrotasks());
    expect(document.body.querySelector('[data-testid="centro-item"]')).toBeNull();
  });

  it("estados vacio, cargando y error", async () => {
    montar({ items: [], hayNoLeidas: false });
    click(campana());
    await act(async () => flushMicrotasks());
    expect(document.body.textContent).toContain("Estás al día");
    rendered!.unmount();
    document.body.innerHTML = "";
    montar({ estado: "cargando", items: [] });
    click(campana());
    await act(async () => flushMicrotasks());
    expect(document.body.querySelector('[role="status"][aria-label="Cargando notificaciones"]')).not.toBeNull();
    rendered!.unmount();
    document.body.innerHTML = "";
    const onReintentar = vi.fn();
    montar({ estado: "error", items: [], onReintentar });
    click(campana());
    await act(async () => flushMicrotasks());
    click(boton("Volver a intentar"));
    expect(onReintentar).toHaveBeenCalled();
  });

  it("NotificationBell con `centro` abre el popover; sin `centro` sigue siendo un enlace (Likida)", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <NotificationBell href="/x" hayNoLeidas={false} />
      </MemoryRouter>,
    );
    expect(document.body.querySelector("a[href='/x']")).not.toBeNull();
  });
});

describe("Panel y EstadoVacio", () => {
  it("Panel: una sola receta de borde, radio, fondo y relleno; relleno none para tablas", () => {
    rendered = renderComponent(
      <>
        <Panel data-testid="p">a</Panel>
        <Panel relleno="none" data-testid="n">
          b
        </Panel>
      </>,
    );
    const p = rendered.container.querySelector<HTMLElement>('[data-testid="p"]')!;
    for (const c of ["rounded-lg", "border", "border-border", "bg-card", "p-4", "space-y-3"]) expect(p.className.split(/\s+/)).toContain(c);
    expect(rendered.container.querySelector<HTMLElement>('[data-testid="n"]')!.className).not.toContain("p-4");
  });

  it("EstadoVacio centrado (icono tenue de 40 px) y variante fila; ambos role=status", () => {
    rendered = renderComponent(
      <>
        <EstadoVacio mensaje="Sin pedidos" />
        <EstadoVacio variante="fila" mensaje="Sin datos" />
      </>,
    );
    const [a, b] = [...rendered.container.querySelectorAll<HTMLElement>('[role="status"]')];
    expect(a!.querySelector("svg")!.getAttribute("class")).toContain("size-10");
    expect(a!.className).toContain("justify-items-center");
    expect(b!.className).toContain("items-start");
  });
});

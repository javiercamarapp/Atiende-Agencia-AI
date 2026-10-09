// @vitest-environment jsdom
//
// UNI-3c: pop-ups y estados identicos a Likida -- Dialog, AlertDialog, Sheet,
// Popover, DropdownMenu, Tooltip, Toaster, ConfirmDialog, FormDialog, Skeleton y
// los estados vacio/error/cargando (spec-diseno-likida-atiende 6.5).
//
// Dos capas:
//  1. Medidas: cada clase que materializa la receta se resuelve a pixeles con los
//     tokens REALES (tailwind-preset + index.css) y se compara con la spec con
//     tolerancia <= 1 px. jsdom no tiene layout; la medicion renderizada contra
//     Likida va en las capturas del PR (Chromium, getComputedStyle).
//  2. Accesibilidad: foco atrapado y devuelto, Escape, roles y nombres accesibles.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@atiende/ui";
import preset from "../../../packages/ui/src/tailwind-preset.ts";
import { click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

// ---- Resolucion de clases a pixeles con los tokens reales ------------------

const CSS = readFileSync(resolve(__dirname, "../../../packages/ui/src/index.css"), "utf8");
const extend = preset.theme!.extend as { borderRadius: Record<string, string>; fontSize: Record<string, [string, { lineHeight: string }]> };

function remAPx(valor: string): number {
  const m = /^(-?[\d.]+)(rem|px)$/.exec(valor.trim());
  if (!m) throw new Error(`valor no resoluble: ${valor}`);
  return m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
}
function variable(nombre: string): number {
  const m = new RegExp(`${nombre}:\\s*([^;]+);`).exec(CSS);
  if (!m) throw new Error(`variable ${nombre} no existe en index.css`);
  return remAPx(m[1]!);
}
/** Radio en px de `rounded-<k>`; las de Tailwind por defecto (2xl = 1rem, xl = 0.75rem, full) se listan. */
function radioPx(k: string): number {
  const defaults: Record<string, number> = { xl: 12, "2xl": 16, full: 9999 };
  if (k in defaults) return defaults[k]!;
  const v = extend.borderRadius[k];
  if (v === undefined) throw new Error(`rounded-${k} desconocido`);
  if (v.startsWith("var(")) return variable(v.slice(4, -1));
  return remAPx(v);
}
/** Tamano de fuente en px de `text-<k>`. */
function textoPx(k: string): number {
  const base: Record<string, number> = { xs: 12, sm: 14, base: 16 };
  if (k in base) return base[k]!;
  const def = extend.fontSize[k];
  if (!def) throw new Error(`text-${k} desconocido`);
  return variable(def[0].slice(4, -1));
}
function ms(nombre: string): number {
  const m = new RegExp(`${nombre}:\\s*(\\d+)ms`).exec(CSS);
  if (!m) throw new Error(`duracion ${nombre} no existe`);
  return Number(m[1]);
}
/** Escala de espaciado de Tailwind: n * 4 px (size-11 = 44). */
const espacioPx = (n: number) => n * 4;
const dentro = (real: number, esperado: number) => Math.abs(real - esperado) <= 1;

const clases = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);
function tiene(el: Element | null | undefined, ...esperadas: string[]) {
  const c = clases(el);
  for (const e of esperadas) expect(c, `falta la clase ${e}`).toContain(e);
}

// ---- Harness -----------------------------------------------------------------

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const montar = (el: React.ReactElement) => (rendered = renderComponent(el));
const abierto = () => document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]')!;
const porTexto = (texto: string) => [...document.body.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === texto)!;
const asincrono = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function DialogoBase({ pie = true }: { pie?: boolean }) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar cliente</DialogTitle>
          <DialogDescription>Cambia los datos de contacto.</DialogDescription>
        </DialogHeader>
        <input aria-label="Nombre" />
        {pie && (
          <DialogFooter>
            <button type="button">Cancelar</button>
            <button type="button">Guardar</button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- 1. Medidas frente a la spec ----------------------------------------------

describe("medidas del pop-up (spec 6.5): <= 1 px frente a Likida", () => {
  it("Dialog: tarjeta de radio 16, p-5 (20 px), hairline, bg-card y sombra de elevacion", () => {
    montar(<DialogoBase />);
    const d = abierto();
    tiene(d, "rounded-lg", "border", "border-border", "bg-card", "p-5", "shadow-elevated");
    expect(dentro(radioPx("lg"), 16)).toBe(true);
    expect(dentro(espacioPx(5), 20)).toBe(true);
    // sin los restos del estilo anterior (p-6, bg-background, shadow-lg)
    for (const viejo of ["p-6", "bg-background", "shadow-lg"]) expect(clases(d)).not.toContain(viejo);
  });

  it("Dialog: titulo 16 px semibold, descripcion 13 px, botones del pie apilados en movil y en fila desde sm", () => {
    montar(<DialogoBase />);
    const titulo = document.getElementById(abierto().getAttribute("aria-labelledby")!)!;
    const desc = document.getElementById(abierto().getAttribute("aria-describedby")!)!;
    tiene(titulo, "text-base", "font-semibold");
    expect(dentro(textoPx("base"), 16)).toBe(true);
    tiene(desc, "text-ui", "text-muted-foreground");
    expect(dentro(textoPx("ui"), 13)).toBe(true);
    const pie = porTexto("Guardar").parentElement!;
    tiene(pie, "flex", "flex-col-reverse", "gap-2", "sm:flex-row", "sm:justify-end");
  });

  it("Dialog: hoja inferior rounded-t-2xl (16) con safe-area en < md y centrado con modal-in en >= md", () => {
    montar(<DialogoBase />);
    const d = abierto();
    tiene(d, "max-md:bottom-0", "max-md:rounded-t-2xl", "max-md:rounded-b-none", "max-md:pb-[calc(1.25rem+var(--safe-area-bottom))]", "max-md:data-[state=open]:animate-sheet-up", "data-[state=open]:animate-modal-in");
    expect(dentro(radioPx("2xl"), 16)).toBe(true);
  });

  it("Dialog: cierre de 44 px en movil y 32 px en escritorio, con nombre accesible 'Cerrar'", () => {
    montar(<DialogoBase />);
    const cerrar = [...abierto().querySelectorAll("button")].find((b) => b.textContent === "Cerrar")!;
    tiene(cerrar, "size-11", "md:size-8", "rounded-lg");
    expect(dentro(espacioPx(11), 44)).toBe(true);
    expect(dentro(espacioPx(8), 32)).toBe(true);
    expect(cerrar.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("overlay: bg-foreground/40 con blur y animacion overlay-in de 150 ms; modal-in de 250 ms", () => {
    montar(<DialogoBase />);
    const overlay = document.body.querySelector<HTMLElement>("[data-state='open'].fixed.inset-0")!;
    tiene(overlay, "bg-foreground/40", "backdrop-blur-sm", "data-[state=open]:animate-overlay-in");
    expect(ms("--dur-fast")).toBe(150);
    expect(ms("--dur-base")).toBe(250);
    tiene(abierto(), "data-[state=open]:animate-modal-in");
    expect((extend as unknown as { animation: Record<string, string> }).animation["modal-in"]).toContain("var(--dur-base)");
  });
});

describe("medidas de los demas pop-ups y estados", () => {
  it("AlertDialog: mismo material que Dialog, titulo 16 px, descripcion 13 px, pie con gap-2 y sin boton de cierre", () => {
    montar(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar reserva</AlertDialogTitle>
            <AlertDialogDescription>No se puede deshacer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction>Si</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const d = abierto();
    tiene(d, "rounded-lg", "border-border", "bg-card", "p-5", "shadow-elevated", "max-md:rounded-t-2xl");
    tiene(document.getElementById(d.getAttribute("aria-labelledby")!), "text-base", "font-semibold");
    tiene(document.getElementById(d.getAttribute("aria-describedby")!), "text-ui", "text-muted-foreground");
    tiene(porTexto("Si").parentElement, "gap-2", "flex-col-reverse", "sm:flex-row");
    // botones del pie de 36 px (h-9 de Likida) y cancelar de contorno
    tiene(porTexto("Si"), "h-[var(--control-md)]");
    expect(variable("--control-md")).toBe(36);
    tiene(porTexto("No"), "border", "bg-card");
    expect(d.querySelector("button[aria-label='Cerrar']")).toBeNull();
  });

  it("ConfirmDialog con tono danger usa el boton de peligro de Likida (tinte + texto destructivo)", () => {
    montar(<ConfirmDialog open onOpenChange={() => {}} titulo="Borrar" tono="danger" onConfirm={() => {}} />);
    tiene(porTexto("Confirmar"), "bg-destructive-tint", "text-destructive", "h-[var(--control-md)]");
  });

  it("Sheet inferior: rounded-t-2xl, bg-card, p-4, safe-area y cierre de 44 px", () => {
    montar(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetTitle>Mas secciones</SheetTitle>
          <SheetDescription>Resto de la navegacion</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const d = abierto();
    tiene(d, "rounded-t-2xl", "bg-card", "p-4", "shadow-elevated", "pb-[calc(1rem+var(--safe-area-bottom))]");
    const cerrar = [...d.querySelectorAll("button")].find((b) => b.textContent === "Cerrar")!;
    tiene(cerrar, "size-11");
    expect(dentro(espacioPx(11), 44)).toBe(true);
    tiene(document.getElementById(d.getAttribute("aria-labelledby")!), "text-sm", "font-semibold");
  });

  it("DropdownMenu: tarjeta de radio 16 con items de 13 px y py-1.5 (31 px como el sidebar), hover canvas", async () => {
    montar(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Uno</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = rendered!.container.querySelector("button")!;
    trigger.focus();
    keydown(trigger, "Enter");
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    tiene(menu, "rounded-lg", "border-border", "bg-popover", "shadow-elevated", "p-1", "text-ui");
    const item = menu.querySelector<HTMLElement>('[role="menuitem"]')!;
    tiene(item, "px-2.5", "py-1.5", "text-ui", "focus:bg-primary/10", "rounded-md");
    // alto de fila = interlineado de text-ui (13 * 1.5 = 19.5) + 2 * py-1.5 (6) = 31.5 px, el item del sidebar
    expect(dentro(textoPx("ui") * 1.5 + 2 * espacioPx(1.5), 31.5)).toBe(true);
    // el hover ya no es el azul solido
    expect(clases(item)).not.toContain("hover:bg-primary");
  });

  it("Tooltip y Popover comparten material: hairline, bg-popover, radio 16 y sombra de elevacion", async () => {
    montar(
      <>
        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger>t</TooltipTrigger>
            <TooltipContent>Ayuda</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Popover open>
          <PopoverTrigger>p</PopoverTrigger>
          <PopoverContent>Detalle</PopoverContent>
        </Popover>
      </>,
    );
    await asincrono();
    const tip = document.body.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] .z-50.text-xs')!;
    tiene(tip, "rounded-lg", "border-border", "bg-popover", "shadow-elevated", "text-xs");
    const pop = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    tiene(pop, "rounded-lg", "border-border", "bg-popover", "p-3", "text-ui", "shadow-elevated");
    expect(pop.textContent).toBe("Detalle");
  });

  it("EstadoVacio (variante fila, la de Likida): tarjeta p-4, chip de 36 px (radio 12, canvas + hairline), icono de 17 px y texto de 14 px", () => {
    montar(<EstadoVacio variante="fila" titulo="Sin citas" mensaje="Crea la primera" />);
    const raiz = rendered!.container.firstElementChild as HTMLElement;
    tiene(raiz, "card", "rounded-lg", "border", "border-border", "bg-card", "shadow-card", "flex", "items-start", "gap-3", "p-4");
    expect(raiz.className).not.toContain("border-dashed");
    const chip = raiz.firstElementChild!;
    tiene(chip, "size-9", "rounded-lg", "bg-canvas", "border", "border-border");
    expect(dentro(espacioPx(9), 36)).toBe(true);
    tiene(chip.querySelector("svg"), "size-[17px]", "text-primary");
    tiene(raiz.lastElementChild, "text-sm", "pt-1");
    expect(dentro(textoPx("sm"), 14)).toBe(true);
  });

  it("EstadoError: chip de peligro (tinte + icono de 17 px) y 'Reintentar' en pildora identica a Likida", () => {
    const onReintentar = vi.fn();
    montar(<EstadoError mensaje="Fallo la lectura" onReintentar={onReintentar} />);
    const raiz = rendered!.container.firstElementChild as HTMLElement;
    tiene(raiz, "card", "rounded-lg", "border-border", "bg-card", "shadow-card", "p-4", "gap-3");
    tiene(raiz.firstElementChild, "size-9", "rounded-lg", "bg-destructive-tint");
    tiene(raiz.querySelector("svg"), "size-[17px]", "text-destructive");
    const b = raiz.querySelector("button")!;
    tiene(b, "mt-2", "text-xs", "font-medium", "px-3", "py-1.5", "rounded-full", "border", "border-border", "hover:opacity-70");
    click(b);
    expect(onReintentar).toHaveBeenCalledTimes(1);
  });

  it("EstadoCargando: filas skeleton de 14 px (h-3.5) con space-y-2 y la ultima al 60 %; sin pulso", () => {
    montar(<EstadoCargando lineas={3} />);
    const raiz = rendered!.container.firstElementChild as HTMLElement;
    tiene(raiz, "space-y-2");
    const filas = [...raiz.querySelectorAll<HTMLElement>(".ds-skeleton")];
    expect(filas).toHaveLength(3);
    for (const f of filas) tiene(f, "h-3.5", "rounded-md", "bg-canvas");
    expect(dentro(espacioPx(3.5), 14)).toBe(true);
    tiene(filas[0], "w-full");
    tiene(filas[2], "w-3/5");
    for (const f of filas) expect(clases(f)).not.toContain("animate-pulse");
  });

  it("Skeleton: barrido de Likida (ds-skeleton) sobre canvas", () => {
    montar(<Skeleton className="h-4" />);
    tiene(rendered!.container.firstElementChild, "ds-skeleton", "bg-canvas", "rounded-md");
    expect(CSS).toMatch(/\.ds-skeleton\s*\{[^}]*ds-shimmer 1\.4s/);
  });
});

// ---- 2. Accesibilidad ------------------------------------------------------------

describe("accesibilidad de los pop-ups", () => {
  it("Dialog: nombre y descripcion accesibles; foco entra al abrir, se atrapa y vuelve al disparador al cerrar con Escape", async () => {
    function App() {
      return (
        <Dialog>
          <DialogTrigger>Abrir editor</DialogTrigger>
          <DialogContent>
            <DialogTitle>Editar cliente</DialogTitle>
            <DialogDescription>Datos de contacto.</DialogDescription>
            <input aria-label="Nombre" />
            <button type="button">Ultimo</button>
          </DialogContent>
        </Dialog>
      );
    }
    montar(<App />);
    const disparador = porTexto("Abrir editor");
    disparador.focus();
    click(disparador);
    await asincrono();
    const d = abierto();
    expect(d.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Editar cliente");
    expect(document.getElementById(d.getAttribute("aria-describedby")!)?.textContent).toBe("Datos de contacto.");
    expect(d.contains(document.activeElement)).toBe(true);

    // atrapado: Tab desde el ultimo control vuelve a un control DENTRO del dialogo
    const ultimo = porTexto("Ultimo");
    ultimo.focus();
    keydown(ultimo, "Tab");
    expect(d.contains(document.activeElement)).toBe(true);

    keydown(document.activeElement!, "Escape");
    await asincrono(60);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  it("AlertDialog: role alertdialog, Escape cancela y devuelve el foco al disparador", async () => {
    montar(
      <AlertDialog>
        <AlertDialogTrigger>Eliminar</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Eliminar cliente</AlertDialogTitle>
          <AlertDialogDescription>Es definitivo.</AlertDialogDescription>
          <AlertDialogCancel>No</AlertDialogCancel>
          <AlertDialogAction>Si</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const disparador = porTexto("Eliminar");
    disparador.focus();
    click(disparador);
    await asincrono();
    expect(abierto().getAttribute("role")).toBe("alertdialog");
    expect(document.activeElement).toBe(porTexto("No")); // opcion segura
    keydown(document.activeElement!, "Escape");
    await asincrono(60);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  it("Sheet: nombre accesible y devuelve el foco al cerrar con el boton 'Cerrar'", async () => {
    montar(
      <Sheet>
        <SheetTrigger>Mas</SheetTrigger>
        <SheetContent side="bottom">
          <SheetTitle>Mas secciones</SheetTitle>
          <SheetDescription>Resto</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const disparador = porTexto("Mas");
    disparador.focus();
    click(disparador);
    await asincrono();
    expect(document.getElementById(abierto().getAttribute("aria-labelledby")!)?.textContent).toBe("Mas secciones");
    click(porTexto("Cerrar"));
    await asincrono(60);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  it("Popover: el disparador anuncia aria-expanded, Escape cierra y el foco vuelve al disparador", async () => {
    montar(
      <Popover>
        <PopoverTrigger>Filtros</PopoverTrigger>
        <PopoverContent aria-label="Filtros de la lista">
          <button type="button">Aplicar</button>
        </PopoverContent>
      </Popover>,
    );
    const disparador = porTexto("Filtros");
    expect(disparador.getAttribute("aria-expanded")).toBe("false");
    disparador.focus();
    click(disparador);
    await asincrono();
    expect(disparador.getAttribute("aria-expanded")).toBe("true");
    const pop = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(pop.getAttribute("aria-label")).toBe("Filtros de la lista");
    expect(pop.contains(document.activeElement)).toBe(true);
    keydown(document.activeElement!, "Escape");
    await asincrono(60);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  it("DropdownMenu: Escape cierra y el foco vuelve al disparador", async () => {
    montar(
      <DropdownMenu>
        <DropdownMenuTrigger>Acciones</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Editar</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const disparador = porTexto("Acciones");
    disparador.focus();
    keydown(disparador, "Enter");
    await asincrono();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    keydown(document.activeElement!, "Escape");
    await asincrono(60);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  it("FormDialog: cierre circular de 44 px en movil (28 px en escritorio) con nombre 'Cerrar', franja de marca de 4 px y titulo de 16 px", () => {
    montar(
      <FormDialog open onOpenChange={() => {}} titulo="Nueva reserva" subtitulo="Captura los datos">
        <input aria-label="Nombre" />
      </FormDialog>,
    );
    const d = abierto();
    const cerrar = d.querySelector<HTMLElement>('button[aria-label="Cerrar"]')!;
    tiene(cerrar, "size-11", "md:size-7", "rounded-full");
    // franja de marca del ModalFormularioLateral del repo suelto (h-1, primary -> franja)
    tiene(d.querySelector(".bg-gradient-to-r"), "h-1", "from-primary", "to-franja");
    tiene(document.getElementById(d.getAttribute("aria-labelledby")!), "text-base", "font-semibold");
  });

  it("los estados se anuncian: vacio como status, error como alert y carga como status ocupado con nombre", () => {
    montar(
      <>
        <EstadoVacio mensaje="Nada por aqui" />
        <EstadoError mensaje="Fallo" />
        <EstadoCargando etiqueta="Cargando pedidos" />
      </>,
    );
    const c = rendered!.container;
    expect(c.querySelector('[role="status"]:not([aria-busy])')?.textContent).toContain("Nada por aqui");
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("Fallo");
    const carga = c.querySelector('[aria-busy="true"]')!;
    expect(carga.getAttribute("role")).toBe("status");
    expect(carga.getAttribute("aria-label")).toBe("Cargando pedidos");
  });
});

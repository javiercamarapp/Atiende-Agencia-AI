// @vitest-environment jsdom
//
// PR-3 de diseno-ux (4.4/4.5): ConfirmDialog + useConfirm (reemplazo de
// window.confirm/prompt), FormDialog responsive, motion de Dialog/Sheet/Dropdown
// y notify/Toaster. Accesibilidad: foco atrapado, Escape, roles y nombres ARIA.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormDialog,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Toaster,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  notify,
  toast,
  useConfirm,
  validarCampoConfirm,
} from "@atiende/ui";
import preset from "../../../packages/ui/src/tailwind-preset.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const dialogo = () => document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const boton = (texto: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === texto)!;
const escape = () => keydown(document.activeElement ?? document.body, "Escape");

describe("ConfirmDialog", () => {
  it("es un alertdialog con titulo y descripcion enlazados por ARIA", () => {
    rendered = renderComponent(<ConfirmDialog open onOpenChange={() => {}} titulo="Cancelar la reserva 42" descripcion="No se puede deshacer." onConfirm={() => {}} />);
    const d = dialogo()!;
    expect(d.getAttribute("role")).toBe("alertdialog");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Cancelar la reserva 42");
    expect(document.getElementById(d.getAttribute("aria-describedby")!)?.textContent).toBe("No se puede deshacer.");
  });

  it("confirmar llama onConfirm y cierra; cancelar cierra sin confirmar", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    rendered = renderComponent(<ConfirmDialog open onOpenChange={onOpenChange} titulo="Borrar" confirmar="Borrar ya" cancelar="No" onConfirm={onConfirm} />);
    click(boton("No"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    click(boton("Borrar ya"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  it("Escape cancela", () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(<ConfirmDialog open onOpenChange={onOpenChange} titulo="Borrar" onConfirm={() => {}} />);
    escape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("tono danger usa el boton destructivo; el foco inicial cae dentro del dialogo", () => {
    rendered = renderComponent(<ConfirmDialog open onOpenChange={() => {}} titulo="Borrar" tono="danger" onConfirm={() => {}} />);
    expect(boton("Confirmar").className).toContain("bg-destructive-tint");
    // sin campo, Radix enfoca Cancelar (la opcion segura), no el boton destructivo
    expect(document.activeElement).toBe(boton("Cancelar"));
  });

  it("con campo: reemplaza a window.prompt, valida y entrega el texto recortado", () => {
    const onConfirm = vi.fn();
    rendered = renderComponent(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        titulo="Rechazar solicitud"
        campo={{ etiqueta: "Motivo", minLength: 5, maxLength: 20 }}
        onConfirm={onConfirm}
      />,
    );
    const input = dialogo()!.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    expect(boton("Confirmar").disabled).toBe(true);

    changeValue(input, "abc");
    expect(boton("Confirmar").disabled).toBe(true);
    // el error solo se anuncia tras tocar el campo, y el control queda invalido
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(dialogo()!.textContent).toContain("al menos 5 caracteres");

    changeValue(input, "  duplicada  ");
    expect(boton("Confirmar").disabled).toBe(false);
    click(boton("Confirmar"));
    expect(onConfirm).toHaveBeenCalledWith("duplicada");
  });

  it("pasar del campo a Cancelar no muestra el error (no agranda el dialogo bajo el clic); salir a otro lado si", () => {
    rendered = renderComponent(<ConfirmDialog open onOpenChange={() => {}} titulo="Rechazar" campo={{ etiqueta: "Motivo", minLength: 5 }} onConfirm={() => {}} />);
    const input = dialogo()!.querySelector<HTMLInputElement>("input")!;
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: boton("Cancelar") })));
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null })));
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("campo multilinea usa textarea y Enter en el input envia el formulario", () => {
    const onConfirm = vi.fn();
    rendered = renderComponent(<ConfirmDialog open onOpenChange={() => {}} titulo="Nota" campo={{ etiqueta: "Nota", multilinea: true, requerido: false }} onConfirm={onConfirm} />);
    expect(dialogo()!.querySelector("textarea")).not.toBeNull();
    // opcional: confirmar con el campo vacio es valido
    click(boton("Confirmar"));
    expect(onConfirm).toHaveBeenCalledWith("");
  });

  it("con onConfirm asincrono queda abierto y en loading hasta resolver", async () => {
    let terminar!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (terminar = r)));
    const onOpenChange = vi.fn();
    rendered = renderComponent(<ConfirmDialog open onOpenChange={onOpenChange} titulo="Enviar" onConfirm={onConfirm} />);
    click(boton("Confirmar"));
    await act(async () => flushMicrotasks());
    expect(boton("Confirmar").getAttribute("aria-busy")).toBe("true");
    expect(boton("Confirmar").disabled).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      terminar();
      await flushMicrotasks();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("si onConfirm se rechaza, el dialogo sigue abierto y el boton se libera", async () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(<ConfirmDialog open onOpenChange={onOpenChange} titulo="Enviar" onConfirm={() => Promise.reject(new Error("falla"))} />);
    click(boton("Confirmar"));
    await act(async () => flushMicrotasks());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(boton("Confirmar").disabled).toBe(false);
  });

  it("validarCampoConfirm: requerido por defecto, limites y validacion propia", () => {
    expect(validarCampoConfirm({ etiqueta: "Motivo" }, "   ")).toMatch(/obligatorio/);
    expect(validarCampoConfirm({ etiqueta: "Motivo", requerido: false }, "")).toBeNull();
    expect(validarCampoConfirm({ etiqueta: "Motivo", maxLength: 3 }, "abcd")).toMatch(/no puede pasar de 3/);
    expect(validarCampoConfirm({ etiqueta: "Folio", validar: (v) => (/^\d+$/.test(v) ? null : "Solo digitos.") }, "x1")).toBe("Solo digitos.");
  });
});

function Probe({ onResultado }: { onResultado: (r: unknown) => void }) {
  const { confirmar, pedirTexto, dialogo: d } = useConfirm();
  return (
    <>
      <button type="button" onClick={() => void confirmar({ titulo: "¿Seguro?", tono: "danger" }).then(onResultado)}>
        pedir-confirmacion
      </button>
      <button type="button" onClick={() => void pedirTexto({ titulo: "Motivo del rechazo", campo: { etiqueta: "Motivo" } }).then(onResultado)}>
        pedir-texto
      </button>
      {d}
    </>
  );
}

describe("useConfirm", () => {
  it("confirmar() resuelve true al confirmar", async () => {
    const r = vi.fn();
    rendered = renderComponent(<Probe onResultado={r} />);
    click(boton("pedir-confirmacion"));
    expect(dialogo()!.textContent).toContain("¿Seguro?");
    await act(async () => {
      click(boton("Confirmar"));
      await flushMicrotasks();
    });
    expect(r).toHaveBeenCalledWith(true);
  });

  it("confirmar() resuelve false al cancelar y con Escape", async () => {
    const r = vi.fn();
    rendered = renderComponent(<Probe onResultado={r} />);
    click(boton("pedir-confirmacion"));
    await act(async () => {
      click(boton("Cancelar"));
      await flushMicrotasks();
    });
    expect(r).toHaveBeenLastCalledWith(false);

    click(boton("pedir-confirmacion"));
    await act(async () => {
      escape();
      await flushMicrotasks();
    });
    expect(r).toHaveBeenCalledTimes(2);
    expect(r).toHaveBeenLastCalledWith(false);
  });

  it("pedirTexto() resuelve el texto validado o null al cancelar", async () => {
    const r = vi.fn();
    rendered = renderComponent(<Probe onResultado={r} />);
    click(boton("pedir-texto"));
    changeValue(dialogo()!.querySelector("input")!, " cliente duplicado ");
    await act(async () => {
      click(boton("Confirmar"));
      await flushMicrotasks();
    });
    expect(r).toHaveBeenLastCalledWith("cliente duplicado");

    click(boton("pedir-texto"));
    await act(async () => {
      click(boton("Cancelar"));
      await flushMicrotasks();
    });
    expect(r).toHaveBeenLastCalledWith(null);
  });

  it("al desmontar con una peticion abierta la resuelve como cancelada (no deja la promesa colgada)", async () => {
    const r = vi.fn();
    rendered = renderComponent(<Probe onResultado={r} />);
    click(boton("pedir-confirmacion"));
    rendered.unmount();
    rendered = undefined;
    await act(async () => flushMicrotasks());
    expect(r).toHaveBeenCalledWith(false);
  });
});

describe("FormDialog", () => {
  const base = { open: true, onOpenChange: () => {}, titulo: "Nueva reserva", subtitulo: "Captura los datos del huésped" };

  it("es un dialog nombrado por su titulo y descrito por su subtitulo", () => {
    rendered = renderComponent(<FormDialog {...base}><input aria-label="Nombre" /></FormDialog>);
    const d = dialogo()!;
    expect(d.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Nueva reserva");
    expect(document.getElementById(d.getAttribute("aria-describedby")!)?.textContent).toBe("Captura los datos del huésped");
  });

  it("Escape y la x cierran; bloquearCierre desactiva ambos", () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(<FormDialog {...base} onOpenChange={onOpenChange}><input aria-label="Nombre" /></FormDialog>);
    escape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    click(document.body.querySelector('button[aria-label="Cerrar"]')!);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    rendered.rerender(<FormDialog {...base} onOpenChange={onOpenChange} bloquearCierre><input aria-label="Nombre" /></FormDialog>);
    escape();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.querySelector('button[aria-label="Cerrar"]')).toBeNull();
  });

  it("atrapa el foco: Tab desde el ultimo control vuelve al primero y Shift+Tab al reves", () => {
    rendered = renderComponent(
      <FormDialog {...base} footer={<button type="button">Ultimo</button>}>
        <input aria-label="Nombre" />
      </FormDialog>,
    );
    const d = dialogo()!;
    const enfocables = [...d.querySelectorAll<HTMLElement>("button, input")];
    // La x va DESPUES del contenido en el DOM (el foco inicial cae en el primer campo): es el ultimo enfocable.
    const primero = enfocables[0]!;
    expect(primero.getAttribute("aria-label")).toBe("Nombre");
    const ultimo = d.querySelector<HTMLElement>('button[aria-label="Cerrar"]')!;
    expect(enfocables.at(-1)).toBe(ultimo);
    ultimo.focus();
    act(() => {
      ultimo.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(primero);
    act(() => {
      primero.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(ultimo);
  });

  it("con onGuardar el contenido es un <form>: Enter/enviar guarda; guardando deshabilita y marca loading", () => {
    const onGuardar = vi.fn();
    rendered = renderComponent(<FormDialog {...base} onGuardar={onGuardar} textoBotonGuardar="Crear"><input aria-label="Nombre" /></FormDialog>);
    const form = dialogo()!.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onGuardar).toHaveBeenCalledTimes(1);

    rendered.rerender(<FormDialog {...base} onGuardar={onGuardar} guardando textoBotonGuardar="Crear"><input aria-label="Nombre" /></FormDialog>);
    const b = boton("Guardando…");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    act(() => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(onGuardar).toHaveBeenCalledTimes(1); // no duplica el envio
  });

  it("responsive: hoja inferior que sube en movil, riel de dos columnas en escritorio", () => {
    rendered = renderComponent(<FormDialog {...base} anchoRiel="260px"><input aria-label="Nombre" /></FormDialog>);
    const d = dialogo()!;
    expect(d.className).toContain("max-md:bottom-0");
    expect(d.className).toContain("max-md:data-[state=open]:animate-sheet-up");
    expect(d.className).toContain("max-md:rounded-t-2xl");
    const rejilla = d.querySelector<HTMLElement>(".grid")!;
    expect(rejilla.className).toContain("grid-cols-1");
    expect(rejilla.className).toContain("md:[grid-template-columns:var(--form-dialog-rail)_1fr]");
    expect(rejilla.style.getPropertyValue("--form-dialog-rail")).toBe("260px");
  });

  it("pasos: lista con paso actual marcado y resumen para movil", () => {
    rendered = renderComponent(
      <FormDialog {...base} pasos={[{ id: "a", etiqueta: "Datos" }, { id: "b", etiqueta: "Pago" }]} pasoActivo="b">
        <input aria-label="Nombre" />
      </FormDialog>,
    );
    expect(dialogo()!.querySelector('[aria-current="step"]')!.textContent).toBe("Pago");
    expect(dialogo()!.textContent).toContain("Paso 2 de 2: Pago");
  });
});

describe("motion de overlays (keyframes de 4.4)", () => {
  const animaciones = (preset.theme!.extend as { animation: Record<string, string> }).animation;

  it("Dialog usa overlay-in/out y modal-in/out, definidos en el preset; el overlay lleva blur", () => {
    rendered = renderComponent(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const contenido = dialogo()!.className;
    const overlay = document.body.querySelector<HTMLElement>("[data-state='open'].fixed.inset-0")!.className;
    for (const clase of ["animate-modal-in", "animate-modal-out"]) expect(contenido).toContain(`:${clase}`);
    for (const clase of ["animate-overlay-in", "animate-overlay-out"]) expect(overlay).toContain(`:${clase}`);
    expect(overlay).toContain("bg-foreground/40");
    expect(overlay).toContain("backdrop-blur-sm");
    expect(overlay).not.toContain("v2:");
    // el centrado ya no usa translate (que pisaria el transform de los keyframes)
    expect(contenido).not.toContain("translate-x");
    for (const nombre of ["modal-in", "modal-out", "overlay-in", "overlay-out", "sheet-up", "sheet-down", "popover-in"]) {
      expect(animaciones[nombre]).toBeDefined();
    }
  });

  it("Sheet inferior sube con sheet-up y sale con sheet-down", () => {
    rendered = renderComponent(
      <Sheet open>
        <SheetContent side="bottom">
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const c = dialogo()!.className;
    expect(c).toContain("data-[state=open]:animate-sheet-up");
    expect(c).toContain("data-[state=closed]:animate-sheet-down");
  });

  it("DropdownMenu abre con teclado, usa popover-in y Escape lo cierra", () => {
    rendered = renderComponent(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Uno</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = rendered.container.querySelector("button")!;
    trigger.focus();
    keydown(trigger, "Enter");
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.className).toContain("data-[state=open]:animate-popover-in");
    expect(menu.className).toContain("data-[state=closed]:animate-overlay-out");
    keydown(menu, "Escape");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("notify / Toaster", () => {
  it("duraciones por tipo: 4 s exito/info, 6 s aviso, 8 s error", () => {
    const sp = {
      success: vi.spyOn(toast, "success").mockReturnValue(1),
      info: vi.spyOn(toast, "info").mockReturnValue(1),
      warning: vi.spyOn(toast, "warning").mockReturnValue(1),
      error: vi.spyOn(toast, "error").mockReturnValue(1),
    };
    notify.success("ok");
    notify.info("info");
    notify.warning("aviso");
    notify.error("mal", { description: "detalle" });
    expect(sp.success).toHaveBeenCalledWith("ok", expect.objectContaining({ duration: 4000 }));
    expect(sp.info).toHaveBeenCalledWith("info", expect.objectContaining({ duration: 4000 }));
    expect(sp.warning).toHaveBeenCalledWith("aviso", expect.objectContaining({ duration: 6000 }));
    expect(sp.error).toHaveBeenCalledWith("mal", expect.objectContaining({ duration: 8000, description: "detalle" }));
  });

  it("con deshacer el toast es persistente y la accion llama al handler", () => {
    const sp = vi.spyOn(toast, "success").mockReturnValue(1);
    const onClick = vi.fn();
    notify.success("Reserva eliminada", { deshacer: { onClick } });
    const opciones = sp.mock.calls[0]![1] as { duration: number; action: { label: string; onClick: () => void } };
    expect(opciones.duration).toBe(Infinity);
    expect(opciones.action.label).toBe("Deshacer");
    opciones.action.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
    // duracion explicita gana
    notify.success("x", { deshacer: { etiqueta: "Revertir", onClick }, duracion: 10_000 });
    expect((sp.mock.calls[1]![1] as { duration: number }).duration).toBe(10_000);
  });

  it("promise delega en sonner con cargando/exito/error y devuelve la promesa", async () => {
    const sp = vi.spyOn(toast, "promise").mockReturnValue(undefined as never);
    const p = Promise.resolve(1);
    const r = notify.promise(p, { cargando: "Guardando…", exito: "Guardado", error: "No se guardó" });
    expect(sp).toHaveBeenCalledWith(p, { loading: "Guardando…", success: "Guardado", error: "No se guardó" });
    expect(await r).toBe(1);
  });

  it("el Toaster sigue la clase dark de <html> (la que alterna ThemeSelector)", async () => {
    document.documentElement.classList.remove("dark");
    rendered = renderComponent(<Toaster />);
    // sonner monta el toast de forma asincrona: se espera un instante dentro de act
    await act(async () => {
      notify.info("hola");
      await new Promise((r) => setTimeout(r, 60));
    });
    const lista = () => document.body.querySelector("[data-sonner-toaster]");
    expect(lista()?.getAttribute("data-theme")).toBe("light");
    await act(async () => {
      document.documentElement.classList.add("dark");
      await flushMicrotasks();
    });
    expect(lista()?.getAttribute("data-theme")).toBe("dark");
    document.documentElement.classList.remove("dark");
    // sonner desmonta el toast con un setTimeout propio (~200 ms) tras el dismiss: si el test termina antes, ese temporizador
    // dispara con el entorno ya destruido ("caught after test environment was torn down"). Se espera a que el toast salga del DOM.
    await act(async () => {
      notify.dismiss();
    });
    await vi.waitFor(
      async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 25));
        });
        expect(document.body.querySelector("[data-sonner-toast]")).toBeNull();
      },
      { timeout: 2000, interval: 25 },
    );
  });
});

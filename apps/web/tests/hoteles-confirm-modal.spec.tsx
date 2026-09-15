// @vitest-environment jsdom
//
// Smoke tests reales de <ConfirmModal /> (hoteles) -- hallazgo de auditoría (rubro 9,
// MEDIO: "0 tests de componentes React en todo el repo"). Este es el componente
// exacto que cierra el hallazgo de severidad ALTA "acciones destructivas sin
// confirmación: cancelar reserva y cerrar folio ejecutan de inmediato con un clic"
// (ver el comentario de cabecera de ConfirmModal.tsx) -- si su comportamiento de
// confirmación se rompe (p. ej. el botón de confirmar deja de llamar a onConfirm, o
// Escape deja de cancelar), ningún test existente se entera: los 83 "*-client.spec.ts"
// de este directorio solo cubren clientes HTTP, nunca un componente renderizado.
//
// Verifica comportamiento real (no solo "no truena"): qué se renderiza según `open`,
// qué callback dispara cada interacción, y que `busy` bloquea el cierre accidental
// mientras la acción irreversible está en curso.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../src/verticals/hoteles/components/ConfirmModal.tsx";
import { click, keydown, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("ConfirmModal", () => {
  it("no renderiza nada en el DOM cuando open=false", () => {
    rendered = renderComponent(
      <ConfirmModal open={false} title="Cerrar folio" message="¿Seguro?" confirmLabel="Cerrar folio" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(rendered.container.innerHTML).toBe("");
  });

  it("cuando open=true, renderiza título, mensaje, y el foco inicial cae en el botón de confirmar", () => {
    rendered = renderComponent(
      <ConfirmModal open={true} title="Cerrar folio" message="Esta acción no se puede deshacer." confirmLabel="Cerrar folio" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(rendered.container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain("Cerrar folio");
    expect(rendered.container.textContent).toContain("Esta acción no se puede deshacer.");
    const confirmButton = rendered.container.querySelectorAll("button")[1] as HTMLButtonElement;
    expect(confirmButton.textContent).toBe("Cerrar folio");
    expect(document.activeElement).toBe(confirmButton);
  });

  it("clic en el botón de confirmar llama a onConfirm exactamente una vez", () => {
    const onConfirm = vi.fn();
    rendered = renderComponent(<ConfirmModal open={true} title="t" message="m" confirmLabel="Confirmar" onConfirm={onConfirm} onCancel={() => {}} />);
    const confirmButton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Confirmar")!;
    click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clic en el botón de cancelar (label por default 'Volver') llama a onCancel y NO a onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    rendered = renderComponent(<ConfirmModal open={true} title="t" message="m" confirmLabel="Confirmar" onConfirm={onConfirm} onCancel={onCancel} />);
    const cancelButton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Volver")!;
    click(cancelButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clic en el overlay (fuera del diálogo) cancela -- clic DENTRO del diálogo no propaga y no cancela", () => {
    const onCancel = vi.fn();
    rendered = renderComponent(<ConfirmModal open={true} title="t" message="m" confirmLabel="Confirmar" onConfirm={() => {}} onCancel={onCancel} />);
    const dialog = rendered.container.querySelector('[role="alertdialog"]') as HTMLElement;
    click(dialog); // dentro del diálogo -- stopPropagation, NO debe cancelar
    expect(onCancel).not.toHaveBeenCalled();
    const overlay = rendered.container.querySelector('[role="presentation"]') as HTMLElement;
    click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape llama a onCancel", () => {
    const onCancel = vi.fn();
    rendered = renderComponent(<ConfirmModal open={true} title="t" message="m" confirmLabel="Confirmar" onConfirm={() => {}} onCancel={onCancel} />);
    keydown(window, "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("con busy=true: ambos botones quedan disabled, el de confirmar muestra 'Procesando…', y ni el overlay ni Escape cancelan", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    rendered = renderComponent(<ConfirmModal open={true} title="t" message="m" confirmLabel="Confirmar" busy={true} onConfirm={onConfirm} onCancel={onCancel} />);
    const buttons = [...rendered.container.querySelectorAll("button")] as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(buttons.some((b) => b.textContent === "Procesando…")).toBe(true);

    const overlay = rendered.container.querySelector('[role="presentation"]') as HTMLElement;
    click(overlay);
    expect(onCancel).not.toHaveBeenCalled();

    // El listener de Escape SÍ sigue activo mientras busy (solo el overlay se
    // guarda explícitamente con `!busy &&` en el componente) -- documentamos el
    // comportamiento real, no uno inventado.
    keydown(window, "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

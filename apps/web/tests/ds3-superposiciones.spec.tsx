// @vitest-environment jsdom
//
// ds3 / lote 4 (superposiciones unificadas): Drawer 420/480/640 y Modal 440/560 con UNA anatomia (cabecera 15/600 + subtitulo + cerrar,
// cuerpo con scroll propio, pie a la derecha, logo al pie del Drawer). Comportamiento: nombre accesible por el titulo, foco inicial en
// [data-autofocus], Esc y la X cierran y el foco vuelve al disparador; la agarradera de la hoja inferior cierra con > 80 px.
// Solo AÑADE: no toca ningun spec existente.
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANCHOS_SUPERPOSICION, Drawer, HOJA_UMBRAL_CIERRE_PX, Modal, tamanoDrawerPara } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const dialogo = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

function ConDisparador({ onCerrar }: { onCerrar?: () => void }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <button type="button" data-testid="abrir" onClick={() => setAbierto(true)}>
        Abrir
      </button>
      <Drawer
        open={abierto}
        onOpenChange={(v) => {
          setAbierto(v);
          if (!v) onCerrar?.();
        }}
        titulo="Filtros"
        subtitulo="Ajusta lo que ves"
        tamano="md"
        pie={<button type="button">Aplicar</button>}
        notaPie="3 activos"
      >
        <label>
          Buscar
          <input data-testid="campo" />
        </label>
        <button type="button" data-autofocus data-testid="enfocado">
          Limpiar
        </button>
      </Drawer>
    </>
  );
}

describe("ds3 — anchos unicos de las superposiciones", () => {
  it("Drawer 420/480/640, Modal 440/560, Popover 340; un ancho heredado se redondea al estandar", () => {
    expect(ANCHOS_SUPERPOSICION).toEqual({ drawer: { sm: 420, md: 480, lg: 640 }, modal: { sm: 440, md: 560 }, popover: 340 });
    expect(tamanoDrawerPara(380)).toBe("sm");
    expect(tamanoDrawerPara(460)).toBe("md");
    expect(tamanoDrawerPara(900)).toBe("lg");
    expect(HOJA_UMBRAL_CIERRE_PX).toBe(80);
  });
});

describe("ds3 — Drawer", () => {
  it("anatomia: titulo como nombre accesible, subtitulo como descripcion, cuerpo, pie con nota y logo de Atiende al pie", () => {
    rendered = renderComponent(<ConDisparador />);
    click(document.body.querySelector('[data-testid="abrir"]')!);
    const d = dialogo()!;
    expect(d.classList.contains("ds3-drawer")).toBe(true);
    expect(d.getAttribute("data-tamano")).toBe("md");
    expect(d.className).toContain("min-[820px]:w-[min(480px,calc(100vw-16px))]");
    const titulo = document.getElementById(d.getAttribute("aria-labelledby")!)!;
    expect(titulo.textContent).toBe("Filtros");
    expect(titulo.classList.contains("ds3-ov-titulo")).toBe(true);
    expect(document.getElementById(d.getAttribute("aria-describedby")!)!.textContent).toBe("Ajusta lo que ves");
    expect(d.querySelector(".ds3-ov-cuerpo [data-testid='campo']")).not.toBeNull();
    const pie = d.querySelector(".ds3-ov-pie")!;
    expect(pie.textContent).toBe("3 activosAplicar");
    const marca = d.querySelector('[data-testid="drawer-marca"]')!;
    expect(marca.getAttribute("aria-hidden")).toBe("true");
    expect(marca.className).toContain("opacity-60");
    expect(marca.querySelector('[data-atiende-wordmark="ds3"]')).not.toBeNull();
    // El logo va DESPUES del pie.
    expect(pie.compareDocumentPosition(marca) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("el foco arranca en [data-autofocus]; la X cierra y el foco vuelve al disparador", async () => {
    const onCerrar = vi.fn();
    rendered = renderComponent(<ConDisparador onCerrar={onCerrar} />);
    const abrir = document.body.querySelector<HTMLButtonElement>('[data-testid="abrir"]')!;
    abrir.focus();
    click(abrir);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("enfocado");
    const cerrar = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent === "Cerrar")!;
    expect(cerrar.classList.contains("ds3-ov-cerrar")).toBe(true);
    click(cerrar);
    expect(onCerrar).toHaveBeenCalledTimes(1);
    expect(dialogo()).toBeNull();
    // Radix devuelve el foco al desmontar la trampa (en la tarea siguiente).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(abrir);
  });

  it("Esc cierra", () => {
    const onCerrar = vi.fn();
    rendered = renderComponent(<ConDisparador onCerrar={onCerrar} />);
    click(document.body.querySelector('[data-testid="abrir"]')!);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCerrar).toHaveBeenCalledTimes(1);
  });

  it("la agarradera de la hoja inferior: arrastrar mas de 80 px cierra; menos, vuelve a su lugar", () => {
    const onOpenChange = vi.fn();
    rendered = renderComponent(
      <Drawer open onOpenChange={onOpenChange} titulo="Más">
        <p>cuerpo</p>
      </Drawer>,
    );
    const agarre = document.body.querySelector<HTMLElement>('[data-testid="drawer-agarre"]')!;
    expect(agarre.getAttribute("aria-hidden")).toBe("true");
    const arrastrar = (desde: number, hasta: number) => {
      act(() => {
        agarre.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: desde, pointerId: 1 }));
        agarre.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: hasta, pointerId: 1 }));
      });
      expect(dialogo()!.style.transform).toBe(`translateY(${Math.max(0, hasta - desde)}px)`);
      act(() => {
        agarre.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: hasta, pointerId: 1 }));
      });
      expect(dialogo()!.style.transform).toBe("");
    };
    arrastrar(100, 150);
    expect(onOpenChange).not.toHaveBeenCalled();
    arrastrar(100, 100 + HOJA_UMBRAL_CIERRE_PX + 1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ds3 — Modal", () => {
  it("misma anatomia sin logo, 440 por omision y 560 en md", () => {
    rendered = renderComponent(
      <Modal open onOpenChange={() => {}} titulo="Confirmar" tamano="md" pie={<button type="button">Aceptar</button>}>
        <p>¿Seguro?</p>
      </Modal>,
    );
    const d = dialogo()!;
    expect(d.classList.contains("ds3-modal")).toBe(true);
    expect(d.className).toContain("w-[min(560px,calc(100vw-32px))]");
    expect(d.querySelector('[data-testid="drawer-marca"]')).toBeNull();
    expect(d.querySelector(".ds3-ov-pie")!.textContent).toBe("Aceptar");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe("Confirmar");
  });
});

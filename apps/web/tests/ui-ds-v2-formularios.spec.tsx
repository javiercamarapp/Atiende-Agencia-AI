// @vitest-environment jsdom
//
// PR-2 de diseno-ux: primitivos de formulario de @atiende/ui (Textarea,
// NativeSelect, Checkbox, Switch, FormField). Sustituyen 119 <select>, 37
// <textarea> y 16 checkbox crudos con clases distintas (F-08).
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox, FormField, Input, NativeSelect, Switch, Textarea } from "@atiende/ui";
import { act } from "react";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function q<T extends Element>(selector: string): T {
  const el = rendered!.container.querySelector<T>(selector);
  if (!el) throw new Error(`no existe ${selector}`);
  return el;
}

describe("Textarea", () => {
  it("es un <textarea> controlable con filas por defecto, foco visible y ref", () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    rendered = renderComponent(<Textarea ref={ref} aria-label="Notas" defaultValue="hola" onChange={onChange} />);
    const t = q<HTMLTextAreaElement>("textarea");
    expect(ref.current).toBe(t);
    expect(t.rows).toBe(3);
    expect(t.className).toContain("focus-visible:ring-2");
    expect(t.className).toContain("rounded-field");
    changeValue(t, "adios");
    expect(onChange).toHaveBeenCalled();
    expect(t.value).toBe("adios");
  });

  it("disabled y aria-invalid llegan al DOM (el estilo de error cuelga de aria-invalid)", () => {
    rendered = renderComponent(<Textarea aria-label="x" disabled aria-invalid />);
    const t = q<HTMLTextAreaElement>("textarea");
    expect(t.disabled).toBe(true);
    expect(t.getAttribute("aria-invalid")).toBe("true");
    expect(t.className).toContain("aria-[invalid=true]:border-destructive");
  });
});

describe("NativeSelect", () => {
  function Demo({ onChange }: { onChange: (v: string) => void }) {
    const [v, setV] = useState("a");
    return (
      <NativeSelect
        aria-label="Letra"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          onChange(e.target.value);
        }}
      >
        <option value="a">A</option>
        <option value="b">B</option>
      </NativeSelect>
    );
  }

  it("es un <select> nativo con sus <option> y cambia de valor", () => {
    const onChange = vi.fn();
    rendered = renderComponent(<Demo onChange={onChange} />);
    const s = q<HTMLSelectElement>("select");
    expect(s.options).toHaveLength(2);
    expect(s.value).toBe("a");
    changeValue(s, "b");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(s.value).toBe("b");
  });

  it("el chevron es decorativo, no intercepta clics y no cuenta como control", () => {
    rendered = renderComponent(
      <NativeSelect aria-label="x">
        <option>1</option>
      </NativeSelect>,
    );
    const icono = q<SVGElement>("svg");
    expect(icono.getAttribute("aria-hidden")).toBe("true");
    expect(icono.getAttribute("class")).toContain("pointer-events-none");
  });

  it("tamanos sm / md por token de control; className va al <select> y wrapperClassName al contenedor", () => {
    rendered = renderComponent(
      <NativeSelect aria-label="x" size="sm" className="w-auto" wrapperClassName="max-w-xs">
        <option>1</option>
      </NativeSelect>,
    );
    expect(q<HTMLSelectElement>("select").className).toContain("h-[var(--control-sm)]");
    expect(q<HTMLSelectElement>("select").className).toContain("w-auto");
    expect(rendered.container.firstElementChild!.className).toContain("max-w-xs");
    rendered.rerender(
      <NativeSelect aria-label="x">
        <option>1</option>
      </NativeSelect>,
    );
    expect(q<HTMLSelectElement>("select").className).toContain("h-[var(--control-md)]");
  });

  it("forwardRef, disabled y name para formularios nativos", () => {
    const ref = createRef<HTMLSelectElement>();
    rendered = renderComponent(
      <NativeSelect ref={ref} aria-label="x" name="zona" disabled>
        <option>1</option>
      </NativeSelect>,
    );
    expect(ref.current?.name).toBe("zona");
    expect(ref.current?.disabled).toBe(true);
  });
});

describe("Checkbox", () => {
  it("es un input checkbox real que alterna con clic y avisa del cambio", () => {
    const onChange = vi.fn();
    rendered = renderComponent(<Checkbox aria-label="Aceptar" onChange={onChange} />);
    const c = q<HTMLInputElement>("input");
    expect(c.type).toBe("checkbox");
    expect(c.checked).toBe(false);
    click(c);
    expect(c.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    click(c);
    expect(c.checked).toBe(false);
  });

  it("con label envuelve en <label>: clicar el texto alterna la casilla; descripcion visible", () => {
    rendered = renderComponent(<Checkbox label="Recibir avisos" descripcion="Por WhatsApp" />);
    const label = q<HTMLLabelElement>("label");
    expect(label.textContent).toContain("Recibir avisos");
    expect(label.textContent).toContain("Por WhatsApp");
    click(q<HTMLElement>("label span.font-medium"));
    expect(q<HTMLInputElement>("input").checked).toBe(true);
  });

  it("indeterminate se refleja en la propiedad del DOM y se limpia", () => {
    rendered = renderComponent(<Checkbox aria-label="Todos" indeterminate />);
    expect(q<HTMLInputElement>("input").indeterminate).toBe(true);
    rendered.rerender(<Checkbox aria-label="Todos" indeterminate={false} />);
    expect(q<HTMLInputElement>("input").indeterminate).toBe(false);
  });

  it("disabled no alterna; el trazo usa border-control (>=3:1) y hay foco visible", () => {
    rendered = renderComponent(<Checkbox aria-label="x" disabled />);
    const c = q<HTMLInputElement>("input");
    expect(c.disabled).toBe(true);
    // HTMLElement.click() respeta disabled como el navegador (un MouseEvent sintetico via dispatchEvent no).
    act(() => c.click());
    expect(c.checked).toBe(false);
    expect(c.className).toContain("border-control");
    expect(c.className).toContain("focus-visible:ring-2");
  });

  it("forwardRef entrega el input aunque se use internamente otro ref", () => {
    const ref = createRef<HTMLInputElement>();
    rendered = renderComponent(<Checkbox ref={ref} aria-label="x" indeterminate />);
    expect(ref.current).toBe(q<HTMLInputElement>("input"));
  });
});

describe("Switch", () => {
  it("expone role=switch con aria-checked y alterna al clic (no controlado)", () => {
    const onCheckedChange = vi.fn();
    rendered = renderComponent(<Switch aria-label="Activo" onCheckedChange={onCheckedChange} />);
    const s = q<HTMLButtonElement>("button");
    expect(s.getAttribute("role")).toBe("switch");
    expect(s.getAttribute("type")).toBe("button");
    expect(s.getAttribute("aria-checked")).toBe("false");
    click(s);
    expect(s.getAttribute("aria-checked")).toBe("true");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    click(s);
    expect(s.getAttribute("aria-checked")).toBe("false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("defaultChecked arranca encendido", () => {
    rendered = renderComponent(<Switch aria-label="x" defaultChecked />);
    expect(q<HTMLButtonElement>("button").getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLButtonElement>("button").dataset.state).toBe("checked");
  });

  it("controlado: el estado lo manda el padre (sin onCheckedChange no cambia solo)", () => {
    const onCheckedChange = vi.fn();
    rendered = renderComponent(<Switch aria-label="x" checked={false} onCheckedChange={onCheckedChange} />);
    const s = q<HTMLButtonElement>("button");
    click(s);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(s.getAttribute("aria-checked")).toBe("false");
    rendered.rerender(<Switch aria-label="x" checked onCheckedChange={onCheckedChange} />);
    expect(s.getAttribute("aria-checked")).toBe("true");
  });

  it("disabled no responde", () => {
    const onCheckedChange = vi.fn();
    rendered = renderComponent(<Switch aria-label="x" disabled onCheckedChange={onCheckedChange} />);
    click(q<HTMLButtonElement>("button"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("onClick propio con preventDefault cancela el cambio", () => {
    const onCheckedChange = vi.fn();
    rendered = renderComponent(<Switch aria-label="x" onClick={(e) => e.preventDefault()} onCheckedChange={onCheckedChange} />);
    click(q<HTMLButtonElement>("button"));
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>("button").getAttribute("aria-checked")).toBe("false");
  });

  it("con name emite el input oculto solo cuando esta encendido (viaja en un form nativo)", () => {
    rendered = renderComponent(<Switch aria-label="x" name="activo" />);
    expect(rendered.container.querySelector("input[type=hidden]")).toBeNull();
    click(q<HTMLButtonElement>("button"));
    const oculto = q<HTMLInputElement>("input[type=hidden]");
    expect(oculto.name).toBe("activo");
    expect(oculto.value).toBe("on");
  });

  it("apagado usa el trazo bg-control (>=3:1) y tiene foco visible", () => {
    rendered = renderComponent(<Switch aria-label="x" />);
    const cls = q<HTMLButtonElement>("button").className;
    expect(cls).toContain("bg-control");
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).toContain("data-[state=checked]:bg-primary");
  });
});

describe("FormField", () => {
  it("enlaza la etiqueta con el control (htmlFor = id) y genera ids unicos", () => {
    rendered = renderComponent(
      <>
        <FormField label="Nombre">
          <Input />
        </FormField>
        <FormField label="Apellido">
          <Input />
        </FormField>
      </>,
    );
    const inputs = [...rendered.container.querySelectorAll("input")];
    const labels = [...rendered.container.querySelectorAll("label")];
    expect(inputs[0]!.id).toBeTruthy();
    expect(inputs[0]!.id).not.toBe(inputs[1]!.id);
    expect(labels[0]!.htmlFor).toBe(inputs[0]!.id);
    expect(labels[1]!.htmlFor).toBe(inputs[1]!.id);
  });

  it("hint y error se enlazan con aria-describedby; el error marca aria-invalid y se anuncia con role=alert", () => {
    rendered = renderComponent(
      <FormField label="Correo" hint="Usa tu correo de trabajo" error="Formato no valido">
        <Input />
      </FormField>,
    );
    const input = q<HTMLInputElement>("input");
    const describedBy = input.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy).toHaveLength(2);
    const [hintId, errorId] = describedBy;
    expect(document.getElementById(hintId!)?.textContent).toBe("Usa tu correo de trabajo");
    const error = document.getElementById(errorId!)!;
    expect(error.textContent).toBe("Formato no valido");
    expect(error.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("sin error ni hint no hay aria-describedby ni aria-invalid", () => {
    rendered = renderComponent(
      <FormField label="Nombre">
        <Input />
      </FormField>,
    );
    const input = q<HTMLInputElement>("input");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(rendered.container.querySelector("[role=alert]")).toBeNull();
  });

  it("required: asterisco visual oculto a AT, texto 'obligatorio' para lectores y aria-required (no el atributo HTML)", () => {
    rendered = renderComponent(
      <FormField label="Telefono" required>
        <Input />
      </FormField>,
    );
    const input = q<HTMLInputElement>("input");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.required).toBe(false);
    expect(q<HTMLElement>("label [aria-hidden='true']").textContent).toBe("*");
    expect(q<HTMLElement>("label .sr-only").textContent).toContain("obligatorio");
  });

  it("respeta el id propio del control y conserva su aria-describedby", () => {
    rendered = renderComponent(
      <FormField label="Notas" hint="Opcional">
        <Textarea id="mis-notas" aria-describedby="otro" />
      </FormField>,
    );
    const t = q<HTMLTextAreaElement>("textarea");
    expect(t.id).toBe("mis-notas");
    expect(q<HTMLLabelElement>("label").htmlFor).toBe("mis-notas");
    expect(t.getAttribute("aria-describedby")).toContain("otro");
    expect(t.getAttribute("aria-describedby")).toContain("mis-notas-ayuda");
  });

  it("acepta una funcion hija para controles compuestos y funciona con NativeSelect", () => {
    rendered = renderComponent(
      <>
        <FormField label="Zona" error="Elige una zona">
          {(props) => (
            <NativeSelect {...props}>
              <option>Centro</option>
            </NativeSelect>
          )}
        </FormField>
      </>,
    );
    const s = q<HTMLSelectElement>("select");
    expect(q<HTMLLabelElement>("label").htmlFor).toBe(s.id);
    expect(s.getAttribute("aria-invalid")).toBe("true");
  });

  it("el error pasa de ausente a presente sin perder el foco del control", () => {
    rendered = renderComponent(
      <FormField label="Nombre">
        <Input />
      </FormField>,
    );
    const input = q<HTMLInputElement>("input");
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    rendered.rerender(
      <FormField label="Nombre" error="Obligatorio">
        <Input />
      </FormField>,
    );
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("Input (campo base compartido)", () => {
  it("usa el alto por token de control y el radio de campo; un h-* explicito gana", () => {
    rendered = renderComponent(<Input aria-label="x" />);
    expect(q<HTMLInputElement>("input").className).toContain("h-[var(--control-md)]");
    expect(q<HTMLInputElement>("input").className).toContain("rounded-field");
    rendered.rerender(<Input aria-label="x" className="h-9" />);
    expect(q<HTMLInputElement>("input").className).toContain("h-9");
    expect(q<HTMLInputElement>("input").className).not.toContain("h-[var(--control-md)]");
  });
});

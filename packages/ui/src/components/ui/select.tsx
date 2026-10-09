import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "../../lib/utils";
import { campoBase } from "./field-styles";
import { SUPERFICIE_FLOTANTE } from "./superficies";

/*
 * Lista desplegable UNICA del sistema (Select de shadcn/Radix del repo suelto,
 * `components/ui/select.tsx`): disparador con chevron, lista flotante con scroll
 * y flechas, opcion con palomita a la izquierda y el azul de marca como
 * resaltado (foco = primary/20, elegida = primary/10), teclado y busqueda por
 * letra de Radix. Sustituye a NativeSelect en las pantallas migradas.
 * Animacion: fade + zoom + slide de tailwindcss-animate (como el original),
 * apagada con prefers-reduced-motion (motion-reduce).
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

export interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: "sm" | "md";
}

const SelectTrigger = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Trigger>, SelectTriggerProps>(
  ({ className, children, size = "md", ...props }, ref) => (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        campoBase,
        "flex items-center justify-between gap-2 py-0 text-left data-[placeholder]:text-muted-foreground [&>span]:line-clamp-1",
        size === "sm" ? "h-[var(--control-sm)]" : "h-[var(--control-md)]",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  ),
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton ref={ref} className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)} {...props}>
    <ChevronUp aria-hidden="true" className="size-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton ref={ref} className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)} {...props}>
    <ChevronDown aria-hidden="true" className="size-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        "relative z-[60] max-h-80 min-w-[8rem] overflow-hidden", SUPERFICIE_FLOTANTE,
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 motion-reduce:animate-none",
        position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className,
      )}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn("p-1", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} className={cn("py-1.5 pl-8 pr-2 text-xs font-semibold text-muted-foreground", className)} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-2 text-ui outline-none transition-colors duration-fast",
      "focus:bg-primary/20 focus:text-primary data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex size-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden="true" className="size-4 text-primary" strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-line2", className)} {...props} />);
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

// ---------------------------------------------------------------------------
// Selector: la forma "de una linea" para las pantallas. Acepta los mismos hijos
// que un <select> (<option>, <optgroup>) y `onChange` con un evento que trae
// `target.value`, de modo que migrar un NativeSelect es cambiar el nombre; o el
// par `value`/`onValueChange` si la pantalla ya trabaja con valores.
// El valor "" (opcion "Todos", "Sin asignar") no existe en Radix: se mapea a un
// centinela interno y se devuelve "" hacia fuera.
// ---------------------------------------------------------------------------
const VACIO = "__vacio__";
const haciaRadix = (v: string | undefined) => (v === "" ? VACIO : v);
const desdeRadix = (v: string) => (v === VACIO ? "" : v);

interface OpcionNormalizada {
  readonly valor: string;
  readonly etiqueta: React.ReactNode;
  readonly deshabilitada: boolean;
}
type Grupo = { readonly etiqueta?: string; readonly opciones: readonly OpcionNormalizada[] };

function normalizarHijos(children: React.ReactNode): Grupo[] {
  const grupos: Grupo[] = [];
  let suelto: OpcionNormalizada[] = [];
  const vaciar = () => {
    if (suelto.length) grupos.push({ opciones: suelto });
    suelto = [];
  };
  const leerOpcion = (el: React.ReactElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode }>): OpcionNormalizada => ({
    valor: el.props.value !== undefined ? String(el.props.value) : textoPlano(el.props.children),
    etiqueta: el.props.children,
    deshabilitada: Boolean(el.props.disabled),
  });
  const recorrer = (nodos: React.ReactNode) => {
    React.Children.forEach(nodos, (nodo) => {
      if (!React.isValidElement(nodo)) return;
      const el = nodo as React.ReactElement<{ label?: string; children?: React.ReactNode; value?: string | number; disabled?: boolean }>;
      if (el.type === React.Fragment) return recorrer(el.props.children);
      if (el.type === "optgroup") {
        vaciar();
        const opciones: OpcionNormalizada[] = [];
        React.Children.forEach(el.props.children, (h) => {
          if (React.isValidElement(h) && h.type === "option") opciones.push(leerOpcion(h as React.ReactElement<{ value?: string | number }>));
        });
        grupos.push({ etiqueta: el.props.label, opciones });
        return;
      }
      if (el.type === "option") suelto.push(leerOpcion(el));
    });
  };
  recorrer(children);
  vaciar();
  return grupos;
}

function textoPlano(n: React.ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textoPlano).join("");
  return "";
}

export interface SelectorProps {
  value?: string | number;
  defaultValue?: string | number;
  /** Recibe el valor elegido ("" para la opcion vacia). */
  onValueChange?: (valor: string) => void;
  /** Compatibilidad con <select onChange>: `e.target.value` y `e.currentTarget.value`. */
  onChange?: (e: { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } }) => void;
  children?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  size?: "sm" | "md";
  className?: string;
  wrapperClassName?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true";
  "data-testid"?: string;
  title?: string;
}

const Selector = React.forwardRef<HTMLButtonElement, SelectorProps>(
  (
    { value, defaultValue, onValueChange, onChange, children, placeholder, disabled, required, name, id, size, className, wrapperClassName, ...aria },
    ref,
  ) => {
    const grupos = React.useMemo(() => normalizarHijos(children), [children]);
    // Sin opcion de valor "": Radix ya trata "" como "sin seleccion" y pinta el marcador; con ella, "" es un valor real.
    const hayVacio = grupos.some((g) => g.opciones.some((o) => o.valor === ""));
    const haciaRadixLocal = (v: string | undefined) => (hayVacio ? haciaRadix(v) : v);
    const cambiar = (v: string) => {
      const real = desdeRadix(v);
      onValueChange?.(real);
      onChange?.({ target: { value: real, name }, currentTarget: { value: real, name } });
    };
    const marcador = placeholder ?? "Selecciona…";
    const { title, "data-testid": testId, ...ariaProps } = aria;
    // Una opcion con valor "" actua de marcador (como <option value="">Todos</option>): se muestra su etiqueta.
    return (
      <div className={cn("w-full", wrapperClassName)}>
        <Select
          value={value === undefined ? undefined : haciaRadixLocal(String(value))}
          defaultValue={defaultValue === undefined ? undefined : haciaRadixLocal(String(defaultValue))}
          onValueChange={cambiar}
          disabled={disabled}
          required={required}
          name={name}
        >
          <SelectTrigger ref={ref} id={id} size={size} className={className} title={title} data-testid={testId} {...ariaProps}>
            <SelectValue placeholder={marcador} />
          </SelectTrigger>
          <SelectContent>
            {grupos.map((g, gi) => {
              const items = g.opciones.map((o) => (
                <SelectItem key={o.valor} value={haciaRadix(o.valor) as string} disabled={o.deshabilitada}>
                  {o.etiqueta}
                </SelectItem>
              ));
              return g.etiqueta ? (
                <SelectGroup key={`g${gi}`}>
                  <SelectLabel>{g.etiqueta}</SelectLabel>
                  {items}
                </SelectGroup>
              ) : (
                <React.Fragment key={`g${gi}`}>{items}</React.Fragment>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    );
  },
);
Selector.displayName = "Selector";

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
  Selector,
};

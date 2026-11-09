// Alias o palabras clave de un producto, editables como fichas. Son los nombres con los que la gente pide el platillo
// ("chela", "flautas"); el agente los usa para encontrarlo. Se normalizan igual que en el servidor
// (admin-catalog.ts::optionalSearchKeywords): minúsculas, sin acentos, espacios colapsados y sin duplicados.
import { useState } from "react";
import { FormField, Input, StatusBadge, useT } from "@atiende/ui";
import { restaurantesProductos } from "@atiende/ui/i18n/restaurantes/productos";
import { X } from "lucide-react";

export const MAX_ALIAS = 30;
export const MAX_ALIAS_LARGO = 60;

/** Misma limpieza que el servidor. Devuelve "" si no queda nada que guardar. */
export function normalizarAlias(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

const ALIAS_VALIDO = /^[a-z0-9][a-z0-9 .-]*$/;

export interface AliasChipsProps {
  readonly alias: readonly string[];
  readonly onChange: (alias: readonly string[]) => void;
  readonly disabled?: boolean;
  /** Texto escrito y aún no agregado como ficha: el formulario lo usa para no guardar y perderlo en silencio. */
  readonly onBorradorChange?: (texto: string) => void;
}

export function AliasChips({ alias, onChange, disabled = false, onBorradorChange }: AliasChipsProps) {
  const t = useT(restaurantesProductos);
  const [borrador, setBorrador] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const cambiarBorrador = (texto: string) => {
    setBorrador(texto);
    onBorradorChange?.(texto);
  };

  // Acepta varios a la vez separados por coma ("flautas, taquitos dorados").
  function agregar(texto: string): boolean {
    const nuevos: string[] = [];
    for (const parte of texto.split(",")) {
      const limpio = normalizarAlias(parte);
      if (!limpio) continue;
      if (limpio.length > MAX_ALIAS_LARGO) {
        setAviso(t("restaurantes.productos.alias.largo", { max: MAX_ALIAS_LARGO }));
        return false;
      }
      if (!ALIAS_VALIDO.test(limpio)) {
        setAviso(t("restaurantes.productos.alias.invalido"));
        return false;
      }
      if (!alias.includes(limpio) && !nuevos.includes(limpio)) nuevos.push(limpio);
    }
    if (alias.length + nuevos.length > MAX_ALIAS) {
      setAviso(t("restaurantes.productos.alias.maximo", { max: MAX_ALIAS }));
      return false;
    }
    setAviso(null);
    if (nuevos.length > 0) onChange([...alias, ...nuevos]);
    return true;
  }

  function confirmarBorrador() {
    if (borrador.trim() === "") return;
    if (agregar(borrador)) cambiarBorrador("");
  }

  return (
    <FormField
      label={t("restaurantes.productos.alias.campo")}
      hint={t("restaurantes.productos.alias.ayuda")}
      error={aviso ?? undefined}
    >
      {(control) => (
      <div className="grid gap-2">
        {alias.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("restaurantes.productos.alias.lista")}>
            {alias.map((a) => (
              <li key={a}>
                <StatusBadge tone="info" dot={false} className="gap-1 pr-1">
                  {a}
                  <button
                    type="button"
                    aria-label={t("restaurantes.productos.alias.quitar", { alias: a })}
                    disabled={disabled}
                    onClick={() => onChange(alias.filter((x) => x !== a))}
                    className="inline-flex size-4 items-center justify-center rounded-full hover:bg-info/10 disabled:opacity-50"
                  >
                    <X className="size-3" strokeWidth={2} />
                  </button>
                </StatusBadge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("restaurantes.productos.alias.vacio")}</p>
        )}
        <Input
          {...control}
          placeholder={t("restaurantes.productos.alias.ph")}

          value={borrador}
          disabled={disabled}
          onChange={(e) => {
            cambiarBorrador(e.target.value);
            if (aviso) setAviso(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              // Enter dentro de un FormDialog enviaría el formulario: aquí solo agrega la ficha.
              e.preventDefault();
              confirmarBorrador();
            }
          }}
          onBlur={confirmarBorrador}
        />
      </div>
      )}
    </FormField>
  );
}

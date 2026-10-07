// Alias o palabras clave de un producto, editables como fichas. Son los nombres con los que la gente pide el platillo
// ("chela", "flautas"); el agente los usa para encontrarlo. Se normalizan igual que en el servidor
// (admin-catalog.ts::optionalSearchKeywords): minúsculas, sin acentos, espacios colapsados y sin duplicados.
import { useState } from "react";
import { FormField, Input, StatusBadge } from "@atiende/ui";
import { X } from "lucide-react";

export const MAX_ALIAS = 30;
export const MAX_ALIAS_LARGO = 60;

/** Misma limpieza que el servidor. Devuelve "" si no queda nada que guardar. */
export function normalizarAlias(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

const ALIAS_VALIDO = /^[a-z0-9][a-z0-9 .-]*$/;

export interface AliasChipsProps {
  readonly alias: readonly string[];
  readonly onChange: (alias: readonly string[]) => void;
  readonly disabled?: boolean;
}

export function AliasChips({ alias, onChange, disabled = false }: AliasChipsProps) {
  const [borrador, setBorrador] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);

  // Acepta varios a la vez separados por coma ("flautas, taquitos dorados").
  function agregar(texto: string): boolean {
    const nuevos: string[] = [];
    for (const parte of texto.split(",")) {
      const limpio = normalizarAlias(parte);
      if (!limpio) continue;
      if (limpio.length > MAX_ALIAS_LARGO) {
        setAviso(`Cada alias admite hasta ${MAX_ALIAS_LARGO} caracteres.`);
        return false;
      }
      if (!ALIAS_VALIDO.test(limpio)) {
        setAviso("Usa solo letras, números, espacios, punto o guion.");
        return false;
      }
      if (!alias.includes(limpio) && !nuevos.includes(limpio)) nuevos.push(limpio);
    }
    if (alias.length + nuevos.length > MAX_ALIAS) {
      setAviso(`Máximo ${MAX_ALIAS} alias por producto.`);
      return false;
    }
    setAviso(null);
    if (nuevos.length > 0) onChange([...alias, ...nuevos]);
    return true;
  }

  function confirmarBorrador() {
    if (borrador.trim() === "") return;
    if (agregar(borrador)) setBorrador("");
  }

  return (
    <FormField
      label="Alias o palabras clave"
      hint="Así lo piden los clientes (ej. «chela» para cerveza). El agente los usa para encontrar este producto. Enter o coma para agregar."
      error={aviso ?? undefined}
    >
      {(control) => (
      <div className="grid gap-2">
        {alias.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Alias del producto">
            {alias.map((a) => (
              <li key={a}>
                <StatusBadge tone="info" dot={false} className="gap-1 pr-1">
                  {a}
                  <button
                    type="button"
                    aria-label={`Quitar alias ${a}`}
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
          <p className="text-xs text-muted-foreground">Todavía no tiene alias.</p>
        )}
        <Input
          {...control}
          placeholder="Escribe un alias (ej. flautas)"
          value={borrador}
          disabled={disabled}
          onChange={(e) => {
            setBorrador(e.target.value);
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

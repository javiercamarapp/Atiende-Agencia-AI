import { useEffect, useState } from "react";
import { Sun, Monitor, Moon } from "lucide-react";
import type { Clave } from "../i18n/mensajes/index.ts";
import { useT } from "../i18n/proveedor";
import { CLAVE_TEMA, aplicarTema, leerTema, suscribirTemaSistema, type Tema } from "../lib/tema.js";

// El tema (leer/aplicar/suscribir) vive en lib/tema.ts, compartido con ThemeBoot y /theme-boot.js.
// Portado 1:1 desde atiende-restaurantes (src/components/ThemeSelector.tsx):
// mismo localStorage key, mismo comportamiento ("sistema" solo se
// reevalúa mientras el usuario lo tenga elegido explícito), mismo
// role="radiogroup"/aria-checked (REQ-UX-001, ACEPTACION §5).
const OPCIONES: Array<{ valor: Tema; Icono: typeof Sun; rotulo: Clave }> = [
  { valor: "claro", Icono: Sun, rotulo: "shell.tema.claro" },
  { valor: "sistema", Icono: Monitor, rotulo: "shell.tema.sistema" },
  { valor: "oscuro", Icono: Moon, rotulo: "shell.tema.oscuro" },
];

export function ThemeSelector({ tamano = "normal" }: { tamano?: "normal" | "compacto" } = {}) {
  const compacto = tamano === "compacto";
  const tr = useT();
  const [tema, setTema] = useState<Tema>("claro");

  useEffect(() => {
    const t = leerTema();
    setTema(t);
    aplicarTema(t);
    return suscribirTemaSistema();
  }, []);

  const elegir = (nuevo: Tema) => {
    try {
      window.localStorage.setItem(CLAVE_TEMA, nuevo);
    } catch {
      // El tema aplica igual en esta sesion aunque no se pueda recordar.
    }
    setTema(nuevo);
    aplicarTema(nuevo);
  };

  return (
    <div role="radiogroup" aria-label={tr("shell.tema")} className={
        compacto
          ? "inline-flex items-center gap-0.5 p-0.5 rounded-full border border-border bg-canvas"
          : "inline-flex items-center gap-0.5 p-0.5 rounded-full bg-muted"
      }
    >
      {OPCIONES.map(({ valor, Icono, rotulo }) => {
        const activo = tema === valor;
        return (
          <button
            key={valor}
            type="button"
            role="radio"
            aria-checked={activo}
            aria-label={tr(rotulo)}
            title={tr(rotulo)}
            onClick={() => elegir(valor)}
            className={`${compacto ? "size-6" : "w-11 h-11"} rounded-full flex items-center justify-center transition-colors ${
              activo
                ? compacto
                  ? "border border-border bg-card text-foreground"
                  : "bg-card text-foreground shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            <Icono className={compacto ? "size-3" : "w-4 h-4"} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

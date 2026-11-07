// Piezas compartidas por las dos pantallas de acceso de las verticales: la actual (`VerticalLoginLegado`) y la del
// diseno ds3 (`VerticalLoginDs3`, identica a la de Rovaq AI). Solo tipos, la validacion del correo y el detector de
// escritorio; la logica de red sigue en lib/google-auth.ts.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export interface VerticalLoginHero {
  /** Ruta relativa a `import.meta.env.BASE_URL` (p. ej. "images/login-hero-citas.jpg"). */
  readonly imagen: string;
  readonly alt: string;
  readonly kicker: string;
  readonly texto: ReactNode;
  /** Lamina con foto a la derecha (como el login del repo suelto de Restaurantes) en vez del panel editorial. Solo la vertical que lo pide cambia. */
  readonly lamina?: boolean;
  /** Leyenda y texto alternativo de la lamina en ingles (la rama editorial ya trae los suyos). */
  readonly laminaEn?: { readonly kicker: string; readonly texto: ReactNode; readonly alt: string };
  /** Dimensiones de la imagen de la lamina (evita saltos de layout). */
  readonly laminaAncho?: number;
  readonly laminaAlto?: number;
}

export interface VerticalLoginProps {
  readonly apiBaseUrl: string;
  /** Identificador de la vertical que reciben el inicio con Google y el magic link ("citas"). */
  readonly vertical: string;
  /** Nombre visible en el titulo: "Bienvenido a atiende {nombre}". */
  readonly nombre: string;
  readonly descripcion: string;
  /** @default "Acceso al panel" */
  readonly kicker?: string;
  /** @default "tu@negocio.com" */
  readonly placeholderCorreo?: string;
  /** `olvidoContrasena` (por defecto activo): enlace "¿Olvidaste tu contraseña?" (PL-21); se apaga solo si la vertical no usa contraseña. */
  readonly metodos?: { readonly google?: boolean; readonly magicLink?: boolean; readonly olvidoContrasena?: boolean };
  readonly hero: VerticalLoginHero;
  /** Reemplaza el pie por defecto ("Pídele a tu negocio que te dé de alta"); p. ej. rentas ofrece alta autoservicio. */
  readonly pie?: ReactNode;
}

export function esCorreoValido(correo: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim());
}

/** `true` solo en escritorio (>= lg). La lamina con foto y el canvas de particulas no se montan en movil. */
export function useEscritorio(): boolean {
  const consulta = "(min-width: 1024px)";
  const [escritorio, setEscritorio] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(consulta).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const m = window.matchMedia(consulta);
    const alCambiar = () => setEscritorio(m.matches);
    alCambiar();
    m.addEventListener("change", alCambiar);
    return () => m.removeEventListener("change", alCambiar);
  }, []);
  return escritorio;
}

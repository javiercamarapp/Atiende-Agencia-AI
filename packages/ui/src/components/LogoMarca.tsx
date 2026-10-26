import { BedDouble, Globe, House, Map as IconoMapa, Monitor, Star, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import {
  LOGOS_MARCA_GENERADOS,
  CLAVES_PENDIENTES_MARCA,
  type LogoMarcaAsset,
  type MarcaConAsset,
  type MarcaPendiente,
} from "../lib/logos-marca.generated";

/**
 * Componente UNICO para logos de terceros (ds3 #7, REDISENO §2.10). Uso NOMINATIVO: el logo solo identifica la
 * integracion o fuente a la que se refiere la pantalla; no sugiere alianza, patrocinio ni respaldo del titular.
 * Los SVG vienen de `lib/logos-marca.generated.ts` (simple-icons, CC0 sobre el archivo; la marca es del titular).
 * IMPORTAR por `@atiende/ui/logo-marca` (no esta en el barrel, para que `LogoMarcaDiferido` pueda dividir el chunk); `PENDIENTES_MARCA` por
 * `@atiende/ui/logos-marca`. Una marca sin asset verificado (`PENDIENTES_MARCA`) se muestra con icono neutro + nombre: no se dibuja ninguna.
 */
export type LogoMarcaClave = MarcaConAsset | MarcaPendiente;
export type LogoMarcaTamano = "xs" | "sm" | "md" | "lg";
export type LogoMarcaVariante = "color" | "mono";

/** Tamano en px por token (xs 14 · sm 16 · md 20 · lg 24). */
export const LOGO_MARCA_PX: Record<LogoMarcaTamano, number> = { xs: 14, sm: 16, md: 20, lg: 24 };
/** Minimo por marca (px). Por defecto 14; la «G» de Google no baja de 18. */
export const LOGO_MARCA_MINIMO_PX: Record<string, number> = { google: 18 };
export const LOGO_MARCA_MINIMO_DEFECTO_PX = 14;
/** Contraste minimo glifo/fondo para dejar la variante `color`; por debajo se fuerza `mono`. `decorativo` no tiene efecto en marcas pendientes (su nombre siempre es visible). */
export const LOGO_MARCA_CONTRASTE_MIN = 3;

const NOMBRES: Record<LogoMarcaClave, string> = {
  whatsapp: "WhatsApp",
  "google-calendar": "Google Calendar",
  stripe: "Stripe",
  airbnb: "Airbnb",
  expedia: "Expedia",
  google: "Google",
  booking: "Booking.com",
  vrbo: "Vrbo",
  tripadvisor: "Tripadvisor",
  meta: "Meta",
  openstreetmap: "OpenStreetMap",
  softrestaurant: "SoftRestaurant",
};

const ICONO_NEUTRO: Record<MarcaPendiente, LucideIcon> = {
  google: Globe,
  booking: BedDouble,
  vrbo: House,
  tripadvisor: Star,
  meta: Globe,
  openstreetmap: IconoMapa,
  softrestaurant: Monitor,
};

/** Baldosa clara del tema oscuro para la variante `color` (24-28 px, radio 8, borde 1 px). */
const BALDOSA: Record<LogoMarcaTamano, string> = {
  xs: "dark:p-[5px]",
  sm: "dark:p-1.5",
  md: "dark:p-1",
  lg: "dark:p-0.5",
};

export const MARCAS_CON_ASSET = Object.keys(LOGOS_MARCA_GENERADOS) as MarcaConAsset[];
export const MARCAS_PENDIENTES: readonly MarcaPendiente[] = CLAVES_PENDIENTES_MARCA;
export const LOGO_MARCA_CLAVES = [...MARCAS_CON_ASSET, ...MARCAS_PENDIENTES] as LogoMarcaClave[];

export function tieneAsset(marca: LogoMarcaClave): marca is MarcaConAsset {
  return Object.prototype.hasOwnProperty.call(LOGOS_MARCA_GENERADOS, marca);
}

/** Fondo claro MAS OSCURO donde puede caer un logo `color`: `--sunken` del modo claro ds3 (HSL 240 3.7% 94.7%, un spec lo compara con index.css). En el tema oscuro el logo va sobre baldosa blanca, que contrasta mas que esto. */
export const LOGO_MARCA_FONDO_CLARO_PEOR_HSL = [240, 3.7, 94.7] as const;

function canalLineal(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminanciaHex(hex: string): number {
  const canal = (i: number) => canalLineal(parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
}

function luminanciaHsl([h, s, l]: readonly [number, number, number]): number {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return 0.2126 * canalLineal(f(0)) + 0.7152 * canalLineal(f(8)) + 0.0722 * canalLineal(f(4));
}

/** Contraste WCAG del color de marca contra el peor fondo claro real del tema (no contra blanco fijo). */
export function contrasteContraFondoClaro(hex: string): number {
  const fondo = luminanciaHsl(LOGO_MARCA_FONDO_CLARO_PEOR_HSL);
  const glifo = luminanciaHex(hex);
  return (Math.max(fondo, glifo) + 0.05) / (Math.min(fondo, glifo) + 0.05);
}

/** `color` solo si el glifo se distingue (>=3:1) del peor fondo claro; si no, `mono`. */
export function variantePermitida(asset: LogoMarcaAsset, pedida: LogoMarcaVariante): LogoMarcaVariante {
  return pedida === "color" && contrasteContraFondoClaro(asset.hex) >= LOGO_MARCA_CONTRASTE_MIN ? "color" : "mono";
}

export function pxLogoMarca(marca: LogoMarcaClave, tamano: LogoMarcaTamano): number {
  return Math.max(LOGO_MARCA_PX[tamano], LOGO_MARCA_MINIMO_PX[marca] ?? LOGO_MARCA_MINIMO_DEFECTO_PX);
}

type Props = {
  marca: LogoMarcaClave;
  tamano?: LogoMarcaTamano;
  variante?: LogoMarcaVariante;
  /** Muestra el nombre de la marca al lado. En marcas sin asset el nombre SIEMPRE se muestra. */
  conNombre?: boolean;
  /** Oculta el logo a lectores de pantalla (el nombre ya esta al lado o en el contexto). */
  decorativo?: boolean;
  /** Nombre accesible; por defecto el nombre de la marca. */
  etiqueta?: string;
  className?: string;
};

export function LogoMarca({
  marca,
  tamano = "md",
  variante = "mono",
  conNombre = false,
  decorativo = false,
  etiqueta,
  className,
}: Props) {
  const nombre = NOMBRES[marca];
  const px = pxLogoMarca(marca, tamano);

  if (!tieneAsset(marca)) {
    const Icono = ICONO_NEUTRO[marca];
    return (
      <span data-logo-marca={marca} data-logo-estado="pendiente" className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
        <Icono aria-hidden="true" focusable="false" width={px} height={px} className="shrink-0" />
        <span className="text-sm font-medium">{nombre}</span>
      </span>
    );
  }

  const asset = LOGOS_MARCA_GENERADOS[marca];
  const efectiva = variantePermitida(asset, variante);
  const oculto = decorativo || conNombre;
  return (
    <span data-logo-marca={marca} data-logo-estado="asset" data-variante={efectiva} className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          efectiva === "color" && cn("dark:rounded-lg dark:border dark:border-border dark:bg-white", BALDOSA[tamano]),
          efectiva === "mono" && "text-foreground",
        )}
      >
        <svg
          viewBox={asset.viewBox}
          width={px}
          height={px}
          fill={efectiva === "color" ? asset.hex : "currentColor"}
          focusable="false"
          xmlns="http://www.w3.org/2000/svg"
          {...(oculto ? { "aria-hidden": true } : { role: "img", "aria-label": etiqueta ?? nombre })}
        >
          <path d={asset.path} />
        </svg>
      </span>
      {conNombre ? <span className="text-sm font-medium">{nombre}</span> : null}
    </span>
  );
}

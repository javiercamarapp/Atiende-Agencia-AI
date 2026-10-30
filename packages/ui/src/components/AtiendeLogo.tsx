// Recreación vectorial del logo real (figura corriendo + líneas de
// movimiento + wordmark "atiende", dos tonos de azul). Portado 1:1 desde
// atiende-restaurantes (src/components/AtiendeLogo.tsx) — mismo SVG inline,
// mismas props, mismos colores hex (REQ-UX-001, paridad de logo).
//
// ds3 / 2.3 (aditivo): `variante="ds3"` pinta el logo monocromo (tinta por `--logo-tinta`, con `--foreground` de
// respaldo hasta que el lote 1.2 lo defina; positivo en claro, negativo en oscuro) con UN punto de acento
// (`--primary`) que nunca se recolorea ni deforma. Sin degradado ni hex. Con `variante="legado"` (default) el
// dibujo es el de siempre, asi que ningun consumidor actual cambia.

/** `legado`: logo de dos tonos de hoy. `ds3`: monocromo + punto de acento. */
export type AtiendeLogoVariante = "legado" | "ds3";
/** `positivo`: tinta del tema (oscura en claro, clara en oscuro). `negativo`: siempre clara, para fondos oscuros fijos. */
export type AtiendeLogoTono = "positivo" | "negativo";

/** Minimos de la marca (px): simbolo 16 de alto, wordmark 100 de ancho. */
export const ATIENDE_MINIMO_SIMBOLO_PX = 16;
export const ATIENDE_MINIMO_WORDMARK_PX = 100;
/** Diametro del punto de acento en el viewBox del simbolo (r=5). El espacio libre es 2 diametros. */
export const ATIENDE_DIAMETRO_PUNTO = 10;
const ESPACIO_LIBRE = ATIENDE_DIAMETRO_PUNTO * 2;
const VIEWBOX_BASE = { x: 0, y: 0, w: 40, h: 32 } as const;
const VIEWBOX_LIBRE = `${-ESPACIO_LIBRE} ${-ESPACIO_LIBRE} ${VIEWBOX_BASE.w + ESPACIO_LIBRE * 2} ${VIEWBOX_BASE.h + ESPACIO_LIBRE * 2}`;

const TINTA = "text-[hsl(var(--logo-tinta,var(--foreground)))]";
const TONO: Record<AtiendeLogoTono, string> = { positivo: TINTA, negativo: "text-white" };

function MarkDs3({
  className,
  animado,
  tono,
  minimo,
  espacioLibre,
}: {
  className: string;
  animado: boolean;
  tono: AtiendeLogoTono;
  minimo: boolean;
  espacioLibre: boolean;
}) {
  // Con espacio libre el SVG crece (viewBox ampliado): el simbolo ocupa 32/72 del alto, por eso el minimo sube a 36 px.
  const min = !minimo ? "" : espacioLibre ? "min-h-9" : "min-h-4";
  return (
    <svg
      viewBox={espacioLibre ? VIEWBOX_LIBRE : "0 0 40 32"}
      className={`${className} ${min} ${TONO[tono]} ${animado ? "atiende-glifo-animado" : ""}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="atiende"
      focusable="false"
      data-atiende-logo="ds3"
      data-tono={tono}
    >
      <rect className="atiende-linea atiende-linea-1" x="0" y="4" width="13" height="4" rx="2" fill="currentColor" />
      <rect className="atiende-linea atiende-linea-2" x="4" y="12" width="13" height="4" rx="2" fill="currentColor" />
      <rect className="atiende-linea atiende-linea-3" x="0" y="20" width="13" height="4" rx="2" fill="currentColor" />
      <circle data-atiende-punto="" className="fill-primary" cx="26" cy="6" r="5" />
      <path
        d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function AtiendeMark({
  className = "h-7 w-auto",
  animado = false,
  variante = "legado",
  tono = "positivo",
  respetarMinimos = true,
  espacioLibre = false,
}: {
  className?: string;
  animado?: boolean;
  /** Solo ds3: ver `AtiendeLogoVariante`. */
  variante?: AtiendeLogoVariante;
  /** Solo ds3: `negativo` para fondos oscuros fijos. */
  tono?: AtiendeLogoTono;
  /** Solo ds3: aplica el minimo de 16 px de alto del simbolo. */
  respetarMinimos?: boolean;
  /** Solo ds3: reserva 2 diametros del punto alrededor del simbolo (el SVG crece; ajusta `className`). */
  espacioLibre?: boolean;
}) {
  if (variante === "ds3") {
    return (
      <MarkDs3 className={className} animado={animado} tono={tono} minimo={respetarMinimos} espacioLibre={espacioLibre} />
    );
  }
  return (
    <svg
      viewBox="0 0 40 32"
      className={`${className} ${animado ? "atiende-glifo-animado" : ""}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="atiende"
    >
      <rect className="atiende-linea atiende-linea-1" x="0" y="4" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-2" x="4" y="12" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-3" x="0" y="20" width="13" height="4" rx="2" fill="#7DD3FC" />
      <circle cx="26" cy="6" r="5" fill="#38BDF8" />
      <path
        d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
        stroke="#1D4ED8"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function AtiendeWordmark({
  className = "",
  markClassName = "",
  animado = false,
  tamano = "normal",
  variante = "legado",
  tono = "positivo",
  respetarMinimos = true,
  espacioLibre = false,
}: {
  /** Solo ds3: monocromo con un punto de acento; el texto usa `--logo-tinta`. */
  variante?: AtiendeLogoVariante;
  tono?: AtiendeLogoTono;
  /** Solo ds3: el lockup no baja de 100 px de ancho. */
  respetarMinimos?: boolean;
  /** Solo ds3: espacio libre (2 diametros del punto) alrededor del simbolo. */
  espacioLibre?: boolean;
  className?: string;
  markClassName?: string;
  animado?: boolean;
  /**
   * "sidebar": el lockup de 18 px de alto del sidebar de Likida (marca h-[18px],
   * texto de 18 px con interlineado de 18 px, hueco de 6 px). La marca y el
   * texto se dimensionan juntos: antes `className="h-[18px]"` no encogia a los
   * hijos (marca h-7 + texto text-2xl) y el logo medía ~28 px.
   */
  tamano?: "normal" | "sidebar";
}) {
  const sidebar = tamano === "sidebar";
  if (variante === "ds3") {
    return (
      <span
        data-atiende-wordmark="ds3"
        className={`inline-flex items-center ${respetarMinimos ? "min-w-[100px]" : ""} ${sidebar ? "h-[18px] gap-1.5" : "gap-2"} ${className}`}
      >
        <AtiendeMark
          variante="ds3"
          tono={tono}
          respetarMinimos={respetarMinimos}
          espacioLibre={espacioLibre}
          className={markClassName || (sidebar ? "h-[18px] w-auto shrink-0" : "h-7 w-auto")}
          animado={animado}
        />
        <span
          className={`font-display font-bold tracking-tight ${TONO[tono]} ${sidebar ? "text-lg leading-[18px]" : "text-2xl"}`}
        >
          atiende
        </span>
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center ${sidebar ? "h-[18px] gap-1.5" : "gap-2"} ${className}`}>
      <AtiendeMark className={markClassName || (sidebar ? "h-[18px] w-auto shrink-0" : "h-7 w-auto")} animado={animado} />
      <span
        className={`font-display font-bold tracking-tight text-marca-atiende ${
          sidebar ? "text-lg leading-[18px]" : "text-2xl"
        }`}
      >
        atiende
      </span>
    </span>
  );
}

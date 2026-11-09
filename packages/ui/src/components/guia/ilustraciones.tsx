// Mini-ilustraciones SVG del recorrido (Rovaq, components/onboarding/ilustraciones.tsx: 14 familias) + 3 propias de Atiende (pedido,
// agenda, voz). En linea, sin imagenes externas ni estilos en linea: color y movimiento viven en clases de guia.css (trazos que se dibujan,
// barras que crecen, puntos que aparecen). Decorativas: aria-hidden. El estado final es el que se ve con «reducir movimiento».
import type { ReactNode } from "react";

export type TipoIlustracion =
  | "barras" | "linea" | "chat" | "nodos" | "tarjetas" | "escudo" | "mapa" | "importar" | "corte" | "campana" | "lista" | "equipo" | "panel" | "cierre"
  | "pedido" | "agenda" | "voz";

export const TIPOS_ILUSTRACION: readonly TipoIlustracion[] = [
  "barras", "linea", "chat", "nodos", "tarjetas", "escudo", "mapa", "importar", "corte", "campana", "lista", "equipo", "panel", "cierre", "pedido", "agenda", "voz",
];

// pathLength=1 permite dibujar cualquier trazo con stroke-dasharray:1 sin conocer su longitud.
const Traza = ({ d, c = "ilu-a", n = "" }: { d: string; c?: string; n?: string }) => <path d={d} pathLength={1} className={`ilu-traza ${c} ${n}`} />;

const DIBUJOS: Record<TipoIlustracion, ReactNode> = {
  barras: (
    <>
      <line x1="14" y1="84" x2="94" y2="84" className="ilu-l" />
      <rect x="22" y="56" width="14" height="28" rx="3" className="ilu-barra ilu-f d1" />
      <rect x="44" y="40" width="14" height="44" rx="3" className="ilu-barra ilu-f d2" />
      <rect x="66" y="24" width="14" height="60" rx="3" className="ilu-barra ilu-fa d3" />
      <circle cx="125" cy="46" r="24" className="ilu-l ilu-sin-relleno ilu-anillo" />
      <circle cx="125" cy="46" r="24" pathLength={1} className="ilu-arco ilu-a" />
      <circle cx="125" cy="46" r="3" className="ilu-pop ilu-fa d4" />
    </>
  ),
  linea: (
    <>
      <Traza d="M16 12 V84 H146" c="ilu-l" />
      <Traza d="M20 70 L46 54 L70 62 L98 34 L124 42 L144 18" n="d2" />
      <circle cx="46" cy="54" r="3.5" className="ilu-pop ilu-fa d3" />
      <circle cx="98" cy="34" r="3.5" className="ilu-pop ilu-fa d4" />
      <circle cx="144" cy="18" r="3.5" className="ilu-pop ilu-fa d5" />
    </>
  ),
  chat: (
    <>
      <rect x="14" y="12" width="84" height="32" rx="10" className="ilu-pop ilu-bordea ilu-sin-relleno d1" />
      <line x1="26" y1="24" x2="82" y2="24" className="ilu-l" />
      <line x1="26" y1="33" x2="64" y2="33" className="ilu-l" />
      <rect x="62" y="52" width="84" height="32" rx="10" className="ilu-pop ilu-f d3" />
      <circle cx="84" cy="68" r="3" className="ilu-punto ilu-fa d4" />
      <circle cx="96" cy="68" r="3" className="ilu-punto ilu-fa d5" />
      <circle cx="108" cy="68" r="3" className="ilu-punto ilu-fa d6" />
    </>
  ),
  nodos: (
    <>
      <Traza d="M80 48 L30 22 M80 48 L130 22 M80 48 L30 76 M80 48 L130 76" c="ilu-l" />
      <circle cx="80" cy="48" r="13" className="ilu-pop ilu-fa d1" />
      <circle cx="30" cy="22" r="8" className="ilu-pop ilu-f ilu-bordea d2" />
      <circle cx="130" cy="22" r="8" className="ilu-pop ilu-f ilu-bordea d3" />
      <circle cx="30" cy="76" r="8" className="ilu-pop ilu-f ilu-bordea d4" />
      <circle cx="130" cy="76" r="8" className="ilu-pop ilu-f ilu-bordea d5" />
    </>
  ),
  tarjetas: (
    <>
      <rect x="34" y="52" width="92" height="30" rx="8" className="ilu-entra ilu-f d1" />
      <rect x="28" y="34" width="104" height="30" rx="8" className="ilu-entra ilu-f ilu-bordea d2" />
      <rect x="22" y="14" width="116" height="32" rx="8" className="ilu-entra ilu-sup d3" />
      <line x1="36" y1="26" x2="86" y2="26" className="ilu-l" />
      <line x1="36" y1="35" x2="64" y2="35" className="ilu-l" />
      <Traza d="M110 24 L116 30 L126 18" n="d5" />
    </>
  ),
  escudo: (
    <>
      <Traza d="M80 10 L118 24 V50 C118 68 100 80 80 88 C60 80 42 68 42 50 V24 Z" />
      <rect x="68" y="44" width="24" height="20" rx="4" className="ilu-pop ilu-fa d3" />
      <path d="M72 44 V38 A8 8 0 0 1 88 38 V44" className="ilu-pop ilu-a ilu-sin-relleno d4" />
    </>
  ),
  mapa: (
    <>
      <rect x="14" y="10" width="132" height="76" rx="10" className="ilu-l ilu-sin-relleno" />
      <circle cx="40" cy="30" r="3" className="ilu-pop ilu-f d1" />
      <circle cx="56" cy="44" r="3" className="ilu-pop ilu-f d2" />
      <circle cx="48" cy="62" r="3" className="ilu-pop ilu-f d3" />
      <circle cx="92" cy="30" r="3" className="ilu-pop ilu-f d2" />
      <circle cx="104" cy="52" r="3" className="ilu-pop ilu-f d4" />
      <circle cx="118" cy="66" r="3" className="ilu-pop ilu-f d3" />
      <circle cx="76" cy="58" r="3" className="ilu-pop ilu-f d5" />
      <circle cx="102" cy="42" r="6" className="ilu-pop ilu-fa d6" />
    </>
  ),
  importar: (
    <>
      <Traza d="M28 58 V78 H132 V58" c="ilu-l" />
      <rect x="62" y="12" width="36" height="28" rx="5" className="ilu-cae ilu-f ilu-bordea d1" />
      <Traza d="M80 40 V66 M70 56 L80 66 L90 56" n="d3" />
    </>
  ),
  corte: (
    <>
      <rect x="38" y="10" width="84" height="76" rx="8" className="ilu-pop ilu-f ilu-bordea d1" />
      <line x1="50" y1="26" x2="110" y2="26" className="ilu-l" />
      <line x1="50" y1="40" x2="110" y2="40" className="ilu-l" />
      <line x1="50" y1="54" x2="92" y2="54" className="ilu-l" />
      <circle cx="106" cy="68" r="10" className="ilu-pop ilu-fa d4" />
      <Traza d="M101 68 L105 72 L112 63" c="ilu-t" n="d5" />
    </>
  ),
  campana: (
    <>
      <Traza d="M80 12 C62 12 52 26 52 42 C52 58 46 64 40 70 H120 C114 64 108 58 108 42 C108 26 98 12 80 12 Z" />
      <path d="M72 76 A8 8 0 0 0 88 76" className="ilu-l ilu-sin-relleno" />
      <path d="M120 24 A24 24 0 0 1 130 40 M40 24 A24 24 0 0 0 30 40" className="ilu-onda ilu-a ilu-sin-relleno d3" />
    </>
  ),
  lista: (
    <>
      <rect x="26" y="14" width="108" height="18" rx="6" className="ilu-pop ilu-f d1" />
      <rect x="26" y="40" width="108" height="18" rx="6" className="ilu-pop ilu-f d2" />
      <rect x="26" y="66" width="108" height="18" rx="6" className="ilu-pop ilu-f d3" />
      <Traza d="M34 23 L39 28 L47 18" n="d2" />
      <Traza d="M34 49 L39 54 L47 44" n="d3" />
      <circle cx="40" cy="75" r="6" className="ilu-l ilu-sin-relleno" />
      <line x1="58" y1="23" x2="112" y2="23" className="ilu-l" />
      <line x1="58" y1="49" x2="100" y2="49" className="ilu-l" />
      <line x1="58" y1="75" x2="106" y2="75" className="ilu-l" />
    </>
  ),
  equipo: (
    <>
      <circle cx="80" cy="30" r="12" className="ilu-pop ilu-fa d1" />
      <path d="M58 76 C58 60 68 52 80 52 C92 52 102 60 102 76" className="ilu-pop ilu-a ilu-sin-relleno d1" />
      <circle cx="34" cy="40" r="9" className="ilu-pop ilu-f ilu-bordea d3" />
      <path d="M18 78 C18 66 25 60 34 60 C38 60 41 61 43 63" className="ilu-pop ilu-l ilu-sin-relleno d3" />
      <circle cx="126" cy="40" r="9" className="ilu-pop ilu-f ilu-bordea d4" />
      <path d="M142 78 C142 66 135 60 126 60 C122 60 119 61 117 63" className="ilu-pop ilu-l ilu-sin-relleno d4" />
    </>
  ),
  panel: (
    <>
      <rect x="16" y="12" width="60" height="32" rx="8" className="ilu-pop ilu-f ilu-bordea d1" />
      <rect x="84" y="12" width="60" height="32" rx="8" className="ilu-pop ilu-f d2" />
      <rect x="16" y="52" width="60" height="32" rx="8" className="ilu-pop ilu-f d3" />
      <rect x="84" y="52" width="60" height="32" rx="8" className="ilu-pop ilu-f ilu-bordea d4" />
      <rect x="26" y="30" width="8" height="8" rx="2" className="ilu-barra ilu-fa d3" />
      <rect x="40" y="24" width="8" height="14" rx="2" className="ilu-barra ilu-fa d4" />
      <rect x="54" y="18" width="8" height="20" rx="2" className="ilu-barra ilu-fa d5" />
      <circle cx="114" cy="70" r="9" className="ilu-a ilu-sin-relleno" />
    </>
  ),
  cierre: (
    <>
      <circle cx="80" cy="48" r="32" pathLength={1} className="ilu-traza ilu-a ilu-grueso ilu-sin-relleno" />
      <Traza d="M64 49 L76 61 L98 36" c="ilu-a ilu-grueso" n="d4" />
      <line x1="80" y1="4" x2="80" y2="10" className="ilu-chispa ilu-a d6" />
      <line x1="124" y1="14" x2="120" y2="18" className="ilu-chispa ilu-a d6" />
      <line x1="36" y1="14" x2="40" y2="18" className="ilu-chispa ilu-a d6" />
    </>
  ),
  // Atiende: un pedido que entra (bolsa + lineas del ticket + palomita).
  pedido: (
    <>
      <rect x="50" y="26" width="60" height="60" rx="8" className="ilu-cae ilu-f ilu-bordea d1" />
      <path d="M66 26 V20 A14 14 0 0 1 94 20 V26" className="ilu-pop ilu-a ilu-sin-relleno d2" />
      <line x1="62" y1="46" x2="98" y2="46" className="ilu-l" />
      <line x1="62" y1="56" x2="90" y2="56" className="ilu-l" />
      <circle cx="122" cy="70" r="10" className="ilu-pop ilu-fa d4" />
      <Traza d="M117 70 L121 74 L128 65" c="ilu-t" n="d5" />
    </>
  ),
  // Atiende: agenda (citas, reservas, turnos).
  agenda: (
    <>
      <rect x="34" y="16" width="92" height="70" rx="8" className="ilu-pop ilu-f ilu-bordea d1" />
      <line x1="34" y1="32" x2="126" y2="32" className="ilu-l" />
      <rect x="44" y="40" width="16" height="12" rx="3" className="ilu-pop ilu-f d2" />
      <rect x="66" y="40" width="16" height="12" rx="3" className="ilu-pop ilu-fa d3" />
      <rect x="88" y="40" width="16" height="12" rx="3" className="ilu-pop ilu-f d4" />
      <rect x="44" y="60" width="16" height="12" rx="3" className="ilu-pop ilu-f d5" />
      <rect x="66" y="60" width="16" height="12" rx="3" className="ilu-pop ilu-f d6" />
    </>
  ),
  // Atiende: agente de voz (microfono + ondas).
  voz: (
    <>
      <rect x="68" y="14" width="24" height="42" rx="12" className="ilu-pop ilu-fa d1" />
      <Traza d="M58 46 C58 62 68 70 80 70 C92 70 102 62 102 46 M80 70 V82" n="d2" />
      <path d="M118 30 A28 28 0 0 1 118 62 M42 30 A28 28 0 0 0 42 62" className="ilu-onda ilu-a ilu-sin-relleno d3" />
      <path d="M130 22 A40 40 0 0 1 130 70 M30 22 A40 40 0 0 0 30 70" className="ilu-onda ilu-l ilu-sin-relleno d5" />
    </>
  ),
};

export function Ilustracion({ tipo }: { tipo: string }) {
  const dibujo = DIBUJOS[(Object.hasOwn(DIBUJOS, tipo) ? tipo : "tarjetas") as TipoIlustracion];
  return (
    <svg className="guia-ilu" viewBox="0 0 160 96" aria-hidden="true" focusable="false">
      {dibujo}
    </svg>
  );
}

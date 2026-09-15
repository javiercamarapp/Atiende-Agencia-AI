// Hallazgo de auditoría (severidad MEDIA/BRANDING, "el título de pestaña está fijo
// en 'Restaurantes' para las 6 verticales"): `apps/web/index.html` fija
// `<title>Atiende — Restaurantes</title>` de forma ESTÁTICA en el HTML servido —
// esta es una SPA de una sola página con 6 verticales montados por
// react-router-dom (ver App.tsx), así que ese título nunca cambiaba sin importar
// qué panel estuviera realmente abierto (un staff de hoteles con la pestaña de
// `/hoteles/...` abierta seguía viendo "Restaurantes" en la pestaña del navegador).
//
// `useDocumentTitle` es el hook mínimo compartido para que cada Shell de vertical
// (HotelesShell.tsx aquí; RestaurantesShell/CitasShell/LicitacionesShell/
// DespachosShell/RentasShell quedan fuera del alcance de esta pasada — ver el
// comentario de HotelesShell.tsx) fije `document.title` real al montar, y lo
// restaure al desmontar (para que navegar de vuelta a otra vertical dentro de la
// misma sesión de navegador no deje pegado el título de la última vertical
// visitada). Separado en su propio archivo (en vez de un useEffect inline
// duplicado en cada Shell) porque es infraestructura genérica de la SPA completa,
// no específica de hoteles — mismo criterio que authed-fetch.ts/auth-client.ts de
// este mismo directorio.
//
// Extensión `.tsx` (aunque este archivo no tiene JSX) — a propósito, no un
// descuido: el `tsconfig.json` RAÍZ del monorepo (`npm run typecheck` de nivel
// repo) incluye `apps/*/src/**/*.ts` con SOLO `lib: ["ES2023"]` (sin `"dom"`, ver
// `packages/config/tsconfig.base.json`) -- ese patrón de include NUNCA matchea
// `.tsx`, así que los componentes de este panel (que sí usan `window`/`document`
// libremente, ej. HotelesShell.tsx) quedan fuera de ese check raíz sin necesitar
// ningún ajuste. Un archivo `.ts` normal que referencie `document` directo (como
// este) SÍ cae en ese include y rompe el typecheck raíz con
// "Cannot find name 'document'" -- `apps/web/tsconfig.json` (el que de verdad
// typechequea este paquete, `npm run typecheck --workspace apps/web`) SÍ trae
// `"dom"` en su `lib`, así que renombrar a `.tsx` es puramente para esquivar el
// gap del check raíz, no un cambio de comportamiento.
import { useEffect } from "react";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previo = document.title;
    document.title = title;
    return () => {
      document.title = previo;
    };
  }, [title]);
}

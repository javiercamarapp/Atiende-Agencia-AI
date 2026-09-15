# @atiende/ui

Reservado — biblioteca de componentes compartida, a portar 1:1 de `hoteles/packages/ui` (ya usa el scope `@atiende/*` sin sufijo de vertical). Aún no portado — ver `docs/REQUISITOS.md`.

## Decisión (auditoría UX/branding/accesibilidad, rubro 12, "sin design system compartido")

Se revisó si había evidencia real para empezar a poblar este paquete ahora con 2-3
primitivos (botón/input/modal) en vez de dejarlo vacío, y se decidió que NO todavía:

- **Cero consumidores hoy**: no hay un solo `import` de `@atiende/ui` en `apps/web`
  (ni en ningún otro paquete) — no hay nada que "extraer a" desde un consumidor real.
- **El único componente candidato real no está duplicado entre verticales**: `ConfirmModal`
  (`apps/web/src/verticals/hoteles/components/ConfirmModal.tsx`) es el único modal
  de confirmación construido como componente en las 6 verticales, y solo lo usa
  hoteles (3 llamadas dentro del mismo vertical). Las otras verticales que piden
  confirmación (citas, restaurantes) usan `window.confirm()` nativo — una diferencia
  de UX real (vale la pena unificar algún día), pero no es el mismo componente
  reimplementado N veces que un design system existiría para deduplicar; es una
  decisión de producto más grande ("¿todas las verticales deben migrar a modal
  custom?") fuera del alcance de una auditoría de accesibilidad/branding.
- **Los `<input>`/`<button>` de formularios son estilos inline por archivo, no
  componentes duplicados** — hay convenciones repetidas (p.ej. `inputStyle`,
  `labelStyle`) pero cada vertical las redefine como constantes locales, nunca como
  el mismo componente copiado; extraerlas sin una razón de negocio (un bug de
  inconsistencia visual real, un cambio de marca que haya que propagar) sería
  refactor especulativo, no un hallazgo cerrado.
- El propio `ConfirmModal.tsx` ya documenta este mismo criterio en su cabecera:
  "este monorepo no tiene ninguna librería de UI instalada... un solo modal
  genérico reutilizado por 3 acciones no justifica sumar una dependencia nueva".

**Qué SÍ justificaría poblar este paquete**: en cuanto un segundo vertical necesite
un modal de confirmación real (no `window.confirm`), o en cuanto se decida
unificar el patrón de confirmación en las 6 verticales, ESE es el momento de portar
`ConfirmModal` (ya con foco trap + `aria-describedby`, ver su historial de
auditoría) a `@atiende/ui` como el primer primitivo real, con un consumidor real
desde el día uno.

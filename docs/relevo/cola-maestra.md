# Cola maestra — backlog vigente por olas (9-nov-2026)

Plan de 5 olas aprobado el 9-nov a partir del inventario del Paso 1. Cada ola se cierra con un build verde de `main`; ninguna se fusiona sin CI (hoy bloqueado
por facturación) ni sin OK de Javier. Las letras son las de las tareas de preparación del 9-nov; las ramas listadas son locales (aún sin push ni PR) salvo que se diga.

## Ola 0 — prerequisitos (fuera del código)
- Destrabar GitHub Actions (facturación) y dejar `main` en verde con #815 (tope de memoria del typecheck).
- Aplicar las migraciones pendientes de `main`: 0075, `mcp_cfdi` 002, 0077, 0085, 0090 (ver `bloqueantes.md`).

## Ola 1 — correcciones de dinero y CI (A, B, C, E)
Rama de integración: `ola/1` (en construcción por otros agentes).

| Letra | Rama | Qué | Estado |
|---|---|---|---|
| A | `fix/hoteles-cobro-centavos` | hoteles: cobro con tarjeta en centavos tipados, timeout y cuerpo no-JSON en el fetch a Stripe, un cobro 3DS pendiente no responde como cobrado | 5 commits locales (prueba roja → arreglo) |
| B | `fix/billing-ledger-atomico` | escritura atómica del libro de cobro (por el nombre de la rama) | en preparación, sin commits |
| C | `ci/codeql-actions-read` | permisos de lectura de Actions para CodeQL («Resource not accessible by integration») | en preparación, sin commits |
| E | `ci/smoke-post-deploy-prod` | smoke post-deploy contra producción | en preparación, sin commits |

Además, los PRs ya listos que solo esperan CI: #762, #764, #812, #791 y, tras cambiar su base a `main`, #798, #703, #709.

## Ola 2 — seguridad, D y documentación (F, D, docs)
Rama de integración de seguridad: `ola/2-seguridad` (en construcción por otros agentes).

| Letra | Rama / PR | Qué |
|---|---|---|
| F | `seg/revoke-security-definer` | `revoke` de `public` en funciones `security definer` de core, hoteles, licitaciones y rentas, con `scripts/verify` contra Postgres (5 commits locales; espejos 830-833) |
| D | — | PM: cerrar (o confirmar cerrados) D31 (pedido grande) y D12 (cortesías y extras con un total que no suma los renglones), cada uno con su prueba; y fusionar la línea de voz #697 → #698 → #752 → #813 con CI verde (#697, #698 y #752 tienen base `main`; solo #813 está apilado sobre #752) |
| docs | `docs/evals-voz-relevo` (este PR) | evals, voz y relevo en el repo |

También en esta ola: MFA superadmin #766, CSP enforce #775 (rojo: lint + CodeQL), smoke #779, Sentry #780.

## Ola 3 — cobro y CFO
- Cobro: #771 → #793 → #802 → #809 (en cadena; #771 en conflicto; migraciones 000700-705 por renumerar; #802 rojo en `env-inventory`).
- CFO de la plataforma: #791 → #794 → #797 → #808 → #810 (migración 0085 de #786 pendiente de aplicar). Datos del dueño pendientes.

## Ola 4 — G y H
Rama de integración: `ola/4` (en construcción por otros agentes).

| Letra | Rama | Qué |
|---|---|---|
| G | `db/g1-espejos-huerfanos` | el guard `verify:migration-versions` falla ante espejos huérfanos; importa como canónicas las migraciones 0008-0014 que solo vivían en `supabase/migrations` (5 commits locales) |
| H | — | costos: techo duro de gasto por organización del agente de WhatsApp; partir el lote de Meta (`maxDuration` de 30 s y doble cobro de turnos del LLM por reintento) o hacerlo idempotente; medidor de mensajes para rentas, licitaciones y despachos; `VOICE_TOPE_MENSUAL_USD` con un valor por omisión seguro |

Agente de PM en paralelo, con OK de gasto: medir #718 en `fa304de9f` (C4 ×5) y #813 en su cabeza final (la fusión de la línea de voz es parte de D, Ola 2).

## Ola 5 — frontend y alta
- ds3: páginas de restaurantes #763 (conflicto), Resumen general #759, rediseño R2 #819, contenido #754 → #755, guía #747 → #749, retiro #760.
- i18n: #770 (padre, en conflicto) y sus ~17 hijos; #816 → #817; #818 (ver `prs-y-ramas.md`).
- Alta: «primer valor en < 30 min» #796 (conflicto + migración por renumerar), CTA de registro #798.
- Puertos del suelto: #765, #767, #769, #772, #773, #776, #777.

## Fuera de las olas (decidir)
- 22 PRs de octubre (#401-#588) sobre una base de hace 1,126-3,076 commits; 11 con alerta de GitGuardian y #486 con alerta alta de CodeQL. Nada de su contenido está en `main`:
  rehacer sobre `main` o cerrar.
- R23/R24 (#702-#713) apilados sobre `fix/r22-coe`; varios con choque de migraciones.
- #697/#698/#716 (voz: banco, `x-atiende-call-turn`, cerebro suelto en voz), #694, #714/#814 (dependabot).

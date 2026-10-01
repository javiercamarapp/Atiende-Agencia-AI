# Superadmin: gestion de organizaciones (SA-06)

Alta, suspender, reactivar y cambiar el **plan de cuenta** (`trial` <-> `active`) de una organizacion, siempre con el patron
**solicitar -> confirmar**. Pantalla `/superadmin/gestion-organizaciones`.

Codigo: `packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql` (base del flujo) y
`packages/db/migrations/0038_superadmin_gestion_organizaciones.sql` (doble control y contrato; espejo
`supabase/migrations/20240101000247_...`), `packages/db/src/superadmin-seguridad-repository.ts`,
`apps/api/src/routes/superadmin-organizaciones.ts`, `apps/web/src/superadmin/pages/GestionOrganizaciones.tsx`.
Verificacion SQL contra Postgres real: `scripts/verify-superadmin-gestion-organizaciones/` (y, para la base del flujo,
`scripts/verify-superadmin-mfa-switches-orgs/`); ambas las corre el gate de CI.

## Reglas (que hace cada capa)

| Regla | Donde se hace cumplir |
| --- | --- |
| Toda accion pide **solicitud con motivo** (>= 20 caracteres); nada cambia al solicitar | SQL (`request_org_admin_action`) |
| La solicitud **vence** (10 min; 60 min con doble control), es de **un solo uso** (estado terminal inmutable) y hay **una sola pendiente por organizacion** | SQL (guard + indice unico parcial) |
| Confirmar **re-valida el estado actual** (la organizacion pudo cambiar) y solo confirma **quien solicito** | SQL (`confirm_org_admin_action`) |
| **Step-up MFA reciente** al confirmar y al aprobar | API (`SENSITIVE_ROUTES`) |
| **Doble control**: suspender una organizacion con contrato vigente (SA-43) exige la aprobacion de un **segundo superadmin** distinto del solicitante; sin ella no se puede confirmar | SQL (`approve_org_admin_action`, CHECK `aprobado_por <> creado_por`) |
| Pasar a cuenta de prueba una organizacion con **contrato vigente** se rechaza; la solicitud y la ejecucion de suspender / cambiar plan registran el **contrato y su version** vigentes | SQL (`org_contrato_vigente`) |
| **Reactivar** restaura el estado previo a la ultima suspension ejecutada; **nunca se borra nada** (no hay DELETE en ninguna funcion) | SQL |
| Bitacora **append-only**: `core.org_admin_action` (no DELETE, estado terminal inmutable, aprobacion y contrato no se reescriben) y `core.superadmin_security_event` (`org_action_requested/approved/executed/cancelled/expired`) | SQL (triggers) |
| Solo superadmin real (no el rol `finanzas`, no staff de la organizacion, no anon) | SQL (`superadmin_require_caller`: `auth.uid() = p_caller_id`) y API |
| Pantalla: `ConfirmDialog` antes de ejecutar y antes de aprobar; descartarlo **nunca** ejecuta ni aprueba | Web |

## Flujo con doble control

1. El superadmin A solicita suspender (motivo). Si la organizacion tiene contrato vigente la solicitud queda con
   `requiereDobleControl = true`, `contratoId` y `contratoVersion`, y vence a los 60 min.
2. El superadmin B (otro) la ve en "Pendientes" con **Aprobar** (con step-up). Aprobar **no ejecuta**.
3. Solo A puede **Confirmar** (con step-up); sin la aprobacion de B responde 409. Si entre la solicitud y la confirmacion la
   organizacion obtuvo un contrato vigente y la solicitud no tenia doble control, confirmar tambien responde 409 y hay que
   rehacerla.

## Supuestos de producto (explicitos)

- "Contrato vigente" = un contrato de `core.customer_contract_version` cuya primera version ya empezo y cuyo fin (el de la ultima
  version) no paso, en fecha de Mexico. La version registrada es la ultima ya en vigor.
- **Plan de cuenta no es plan de cobro**: no toca Stripe ni `core.organization_billing` (se asigna en `/superadmin/planes`).
  "Respeta limites" se interpreto como: una cuenta con contrato vigente no baja a prueba. Los limites del catalogo de planes
  (`core.plan_limit`) se siguen evaluando y mostrando en `/superadmin/planes`, no aqui.
- No hay accion de "rechazar": una solicitud sin aprobar vence o la cancela quien la solicito.

## Compatibilidad con la base sin migrar

- Sin 0025: igual que antes (GET `disponible: false`, escrituras 503).
- Con 0025 y **sin 0038**: todo el flujo anterior sigue igual (las columnas nuevas se leen como "sin doble control") y solo
  `POST .../aprobar` responde 503 con un mensaje claro. Cada metodo del repositorio corre bajo `runWithSavepointFallback`
  (SQLSTATE 42883/42P01/42703), asi que la transaccion de la sesion sigue viva.
- 0038 requiere 0037 (contratos). Aplicar en orden: 0037, 0038.

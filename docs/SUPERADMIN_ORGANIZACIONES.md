# Superadmin: gestion de organizaciones (SA-06)

Alta, suspender, reactivar y cambiar el **plan de cuenta** (`trial` <-> `active`) de una organizacion, siempre con el patron
**solicitar -> confirmar**. Desde SA-L-20 vive en la pestana **Gestion** de `/superadmin/organizaciones`
(`/superadmin/gestion-organizaciones` redirige a `/superadmin/organizaciones?tab=gestion`, sin 404).

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

# Organizaciones / Clientes, Ficha 360 y onboarding medido (SA-L-20, SA-07, SA-18)

Codigo: `packages/db/migrations/0052_superadmin_organizaciones_ficha_onboarding.sql` (espejo `supabase/migrations/20240101000298_...`),
`packages/db/src/superadmin-organizaciones-ficha-repository.ts`, `apps/api/src/routes/superadmin-organizaciones-ficha.ts`,
`apps/web/src/superadmin/pages/{Organizaciones,OrganizacionFicha}.tsx`. Verificacion SQL contra Postgres real:
`scripts/verify-superadmin-organizaciones-ficha/` (la corre el gate de CI).

## Que muestra cada pantalla

| Pantalla | Fuente | Detalle |
| --- | --- | --- |
| `/superadmin/organizaciones` (pestana Clientes) | `GET /superadmin/organizaciones/resumen` | Odometro con el total, tabla (organizacion, vertical, estado, plan, operaciones y costo de IA a 30 dias, margen del mes, onboarding `x/y`), `Entrar` y `Ficha`, y barras "Top por costo de IA". |
| Columna **Margen** | `GET /superadmin/organizaciones/margen` | Ruta de la **zona CFO** (`RUTAS_FINANCIERAS`): step-up si hay MFA y bitacora de cada consulta. Se pide aparte: si el step-up se rechaza solo esa columna queda en "—". Usa el mismo motor que Costos y margen (`construirFilasCostoMargen`). |
| `/superadmin/organizaciones/:id` | `GET /superadmin/organizaciones/:id/ficha` | Uso (operaciones, conversaciones, minutos de voz), costo (IA, costo por evento, margen del mes), membresias por rol y ultimos accesos (sin nombres), ultimos errores (outbox muerto, accesos denegados), facturacion y contrato, checklist de onboarding. Una organizacion inexistente da **404 honesto**. |
| Pestana **Gestion** | las rutas de siempre (`/superadmin/organizaciones/acciones*`) | Sin cambios: doble control (SA-06) y step-up intactos. |
| `Entrar` | `POST /superadmin/impersonacion/sesiones` | Sesion de **solo lectura** de 15 minutos con motivo de **20+ caracteres**; con menos el boton queda bloqueado; Cancelar y Escape nunca llaman al servidor. |

## Onboarding por organizacion (SA-18)

`core.get_org_onboarding_for_superadmin` devuelve un checklist **por vertical**; cada paso es `hecho`, `pendiente` (se midio y falta) o
**`no_se_pudo_medir`** (no hay forma de saberlo todavia, con su razon: `fuente_no_migrada` o `sin_fuente`). Un paso que no se puede medir
**nunca** se pinta como pendiente ni como 0.

| Paso | Verticales | Criterio |
| --- | --- | --- |
| WhatsApp configurado | restaurantes, hoteles, citas | numero general o por sucursal (restaurantes), canal habilitado (hoteles), config activa (citas) |
| Catalogo cargado | restaurantes, hoteles, citas, rentas | productos disponibles, habitaciones, servicios activos, unidades |
| Staff invitado | todas | mas de una membresia |
| Primera operacion real | todas (despachos: `no_se_pudo_medir` / `sin_fuente`) | mismas definiciones que `get_consola_operaciones_for_superadmin` (0042), toda la historia |
| Plan asignado | todas | fila en `core.organization_plan` |
| Contrato registrado | todas | alguna version en `core.customer_contract_version` |

Los criterios replican en SQL los de las rutas de onboarding de restaurantes, citas y rentas (que corren con la sesion RLS del staff
de la organizacion y no sirven para el back office); no es el mismo codigo.

## Aviso "organizacion lista" (una sola vez, nunca desde un GET)

Cuando **todos** los pasos de una organizacion estan `hecho`, el cron `/internal/superadmin/mantenimiento` llama a
`core.avisar_organizaciones_listas_for_system()` (solo sistema): inserta el marcador persistente `core.org_onboarding_aviso` (PK por organizacion)
y devuelve las organizaciones a avisar; el cron emite `superadmin.organizacion.onboarding_listo` con `emitirNotificacion` **en la misma
transaccion** (si falla, se revierte el marcador y se reintenta en la siguiente corrida). Un paso `pendiente` o `no_se_pudo_medir` lo impide.
Las organizaciones con mas de 30 dias de alta se marcan sin notificar (no son noticia el dia que se aplica la migracion).

## Compatibilidad con la base sin migrar

Sin la 0052: la lista de organizaciones, el staff y el plan siguen saliendo de las funciones que ya existen; `GET .../resumen` responde 200
con `disponible: false` y las columnas nuevas en "—" con su razon; la ficha de una organizacion existente responde 200 `disponible: false` y la de una
inexistente 404; el cron sigue en `ok`. Cada fuente corre bajo su propio SAVEPOINT (`runWithSavepointFallback`).

## Huecos conocidos

- **Interruptores por organizacion**: el CHECK de `core.platform_switch` no admite scope `org` (0025:282); no se agrego sin pedirlo.
- **Senales de PMF**: fuera de alcance.
- **Crons por organizacion**: no hay fuente por organizacion (`core.cron_heartbeat` es de toda la plataforma); la ficha lo dice ("—" con razon).

# Alta del equipo inicial de una organizacion (SA-L-26 minimo, go-live G-07)

Una organizacion nueva puede nacer **sin miembros** (caso real: Los Taquitos de PM, 7 sucursales y 0 miembros en `core.membership`). Solo owner/admin de
la propia organizacion invitan, la impersonacion es de solo lectura y no hay registro publico, asi que nadie podia darle acceso al dueno. Este camino lo
resuelve sin insertar filas a mano.

Codigo: `packages/db/migrations/0053_superadmin_alta_equipo.sql` (espejo `supabase/migrations/20240101000367_...`),
`packages/db/src/superadmin-alta-equipo-repository.ts`, `apps/api/src/routes/superadmin-organizaciones-equipo.ts`,
`apps/web/src/superadmin/pages/OrganizacionFicha.tsx` (seccion "Equipo"). Verificacion SQL contra Postgres real:
`scripts/verify-superadmin-alta-equipo/` (la corre el gate de CI).

## Alta del equipo inicial (paso a paso)

1. Entra a `/superadmin/organizaciones`, abre la ficha de la organizacion y baja a **Equipo**.
2. **Invitar**: correo, rol (`owner`, `admin`, `staff`, `repartidor`), sucursales (vacio = todas) y **motivo** (minimo 20 caracteres). Si hay MFA activa
   pide el codigo (step-up). Para el primer dueno elige `owner` y deja las sucursales vacias.
3. La respuesta muestra el enlace de activacion **una sola vez** (solo su hash se guarda) y si el correo quedo encolado. El correo sale por la cola de
   correo de la vertical; si el envio aun no esta listo, comparte el enlace por otro medio.
4. La persona abre el enlace (`/aceptar-invitacion?token=...`), define su nombre y su contrasena (el superadmin nunca crea usuarios ni contrasenas) y queda
   dentro con el rol y las sucursales de la invitacion. El superadmin recibe el aviso in-app `superadmin.organizacion.miembro_aceptado` (sin datos personales).
5. **Reenviar** genera un token nuevo (el anterior deja de servir) y renueva la vigencia a 7 dias; **Revocar** impide aceptar. Ambas piden motivo y step-up.

## Reglas (que hace cada capa)

- **SQL (autoridad)**: cada funcion exige `auth.uid() = p_caller_id` y superadmin real (`core.superadmin_require_caller`); `anon` sin EXECUTE. Valida la lista
  blanca de roles (el `platform_role` sale del rol, no del llamador), que las sucursales sean de la organizacion indicada, correo ya miembro (409),
  invitacion pendiente duplicada (409), segundo owner sin confirmacion (409 `segundo_owner_requiere_confirmacion`) y motivo >= 20. Cada accion queda en
  `core.superadmin_security_event` (append-only) con el correo **enmascarado**.
- **API**: `GET/POST /superadmin/organizaciones/:id/invitaciones`, `POST .../:inviteId/reenviar`, `DELETE .../:inviteId`. Las tres mutaciones estan en
  `SENSITIVE_ROUTES` (step-up). Las respuestas nunca traen hashes y el correo va enmascarado; el token en claro solo se devuelve en la respuesta de crear/reenviar.
- **Correo**: se encola en una sesion de sistema propia despues de confirmar la invitacion; un fallo no la revierte (`correoEncolado: false`).
- **Solo restaurantes** tiene hoy su lista blanca de roles; las demas verticales responden 400 explicito hasta tener la suya.

## Correccion incluida: `core.accept_staff_invite`

La funcion de la migracion 0002 fallaba con SQLSTATE 42702 (`column reference "email" is ambiguous`) en cada llamada contra Postgres real, porque sus columnas de
salida se llaman igual que las columnas de las tablas que consulta; ninguna invitacion de staff (tampoco las de owner/admin) se podia aceptar. La 0053 la
reemplaza con la misma firma y el mismo comportamiento (`#variable_conflict use_column`). Hasta aplicar la 0053 en la base real, aceptar una invitacion falla.

## Compatibilidad con la base sin migrar

Sin la 0053: la lectura responde 200 `disponible: false` con su razon y las mutaciones 503 honesto; el aviso de aceptacion no hace nada (nunca rompe el alta).

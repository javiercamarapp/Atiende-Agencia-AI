# Superadmin: contrato por cliente (SA-43)

Registro de las condiciones comerciales de cada organizacion (cliente): base mensual, tarifa por sucursal con sucursales incluidas, bolsa
de minutos de voz, tarifa de excedente, instalacion, descuentos (porcentual y fijo), moneda MXN, vigencia, version y quien lo cambio.
De el sale la **facturacion ESTIMADA del mes**. Nada de esto cobra, factura ni envia: es un registro interno y una lectura.

Codigo: `packages/db/migrations/0037_superadmin_contrato_cliente.sql` (espejo `supabase/migrations/20240101000240_...`),
`packages/db/src/superadmin-contratos-repository.ts`, `packages/billing/src/contrato.ts` (calculo puro),
`apps/api/src/routes/superadmin-contratos.ts`, `apps/web/src/superadmin/pages/Contratos.tsx`.
Verificacion SQL contra Postgres real: `scripts/verify-superadmin-contratos/` (lo corre el gate de CI).

## Modelo

- `core.customer_contract_version`: **una fila por version** de un contrato. Es inmutable (triggers que rechazan UPDATE, DELETE y TRUNCATE con
  0A000, incluso para el dueño) y por eso es a la vez el historial y la bitacora append-only: version, quien (`created_by`), cuando y motivo
  (20 a 500 caracteres). Un cambio de condiciones es una version nueva, nunca una edicion.
- La version 1 usa su propio id como `contract_id`; las enmiendas comparten `contract_id` y suben `version`.
- Dinero en **centavos MXN enteros** (`bigint` con CHECK de rango); descuento porcentual en **puntos base** (100 = 1 %). Moneda fijada a MXN por CHECK.
- Sin llaves foraneas (la historia financiera debe sobrevivir al borrado de una organizacion o de una cuenta de staff, y un FK con
  cascade provocaria un DELETE/UPDATE sobre filas inmutables).
- **Vigencias**: `vigente_desde`/`vigente_hasta` inclusivos (`hasta` nulo = sin fin). Un contrato rige de su primera version al fin que dicta su
  ultima version. La BASE (trigger de insercion, serializado por organizacion con un candado de asesor) rechaza con 23P01 que dos contratos de la
  misma organizacion se traslapen (tambien una enmienda que extienda el fin sobre otro contrato) y con 22023 una version cuyo `vigente_desde` no
  crezca o que empiece despues del fin del contrato.
- Una enmienda no puede empezar antes del primer dia del mes en curso (hora de Mexico) ni dejar todas las condiciones iguales.
- Terminar un contrato es una enmienda que fija `vigente_hasta`.

## Seguridad (por capa)

| Capa | Regla |
| --- | --- |
| SQL, tabla | RLS habilitado SIN policy y `revoke all` a public, anon y authenticated: nadie la toca directo (por eso no hay GRANT por columna). Un tenant, aunque sea owner de su organizacion, no lee su contrato. |
| SQL, escritura | `superadmin_create_contract` / `superadmin_amend_contract`: definer con `search_path` fijo, `revoke` a public/anon, `core.superadmin_require_caller` (auth.uid() = p_caller_id, superadmin real y NO restringido al rol `finanzas`). |
| SQL, lectura | `list_customer_contracts_for_superadmin` y `get_contract_billing_inputs_for_superadmin`: cero filas si no es el superadmin autenticado (nunca un error que confirme datos). El rol `finanzas` (solo lectura) puede leer. |
| API | Solo superadmin (gateo de `/superadmin/*`). Alta y enmienda en `SENSITIVE_ROUTES` (step-up MFA). Las lecturas estan en `RUTAS_FINANCIERAS` de la zona CFO: quedan en `core.cfo_access_log` y el rol `finanzas` puede leerlas, no escribir. |
| Web | Pantalla `/superadmin/contratos`; escrituras con `fetchConStepUp`. |

## Facturacion estimada del mes

`GET /superadmin/contratos/estimacion?organizationId=...&mes=YYYY-MM` aplica `estimarFacturacionMes` (funcion pura, centavos enteros):

- recurrente de cada version = base + (sucursales activas hoy - incluidas) x tarifa por sucursal, menos descuento porcentual (redondeo mitad hacia
  arriba) y luego el fijo, con piso en 0;
- **cambio a mitad de mes**: cada version pesa por sus dias vigentes dentro del mes; un solo redondeo del total y el residuo se reparte por mayor fraccion;
- bolsa de minutos prorrateada igual; excedente = (minutos - bolsa) x tarifa de la ULTIMA version vigente del mes;
- subtotal antes de IVA; la instalacion no entra (se factura por hito);
- sin contrato vigente: `estado: "sin_contrato"` y todo `null`; sin eventos de voz en el mes los minutos son `null` ("no medidos") y el total tambien, con su razon;
- dos contratos traslapados dentro del mes (no deberia pasar: lo impide la base) devuelven `inconsistente` en lugar de cobrar doble.

Supuestos declarados en la respuesta: sucursales de hoy (no hay historial de altas por dia) y minutos de `core.usage_cost_event` (voz, redondeo hacia arriba).

## Base sin migrar y orden de despliegue

Compatible con la base sin `0037`: el repositorio corre cada llamada bajo `runWithSavepointFallback` (42883/42P01/42703 -> "no disponible aun" sin
abortar la transaccion de la sesion). Las lecturas responden `disponible: false` con su mensaje (200), alta y enmienda 503, nunca un 500; la pantalla
muestra el aviso y oculta los botones de escritura. Orden: desplegar el codigo (cualquier momento) y aplicar `0037` cuando se decida; hasta entonces
la pantalla dice que falta la migracion. Aplicar la migracion no cambia ningun precio ni cobra nada: no siembra contratos.

## Alcance honesto / pendiente

- El contrato aun NO alimenta el margen ni el P&L (siguen leyendo el plan de `0028`): conciliar "contrato vs plan vs Stripe" es un paso aparte.
- Las sucursales por contrato (`contract_branch` / `modo_voz`) del spec no estan: hoy se cuentan las sucursales activas de la organizacion.
- No hay prorrateo de sucursales por dia ni reconocimiento de ingreso por hito (instalacion).
- Los minutos de voz dependen de que algo registre eventos `voz` en `core.usage_cost_event`; sin ellos el excedente es "no disponible".

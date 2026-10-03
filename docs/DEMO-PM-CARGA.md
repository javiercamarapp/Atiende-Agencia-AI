# Runbook: cargar la demo de PM en la base real (y borrarla)

Este runbook deja la **demo de Los Taquitos de PM** en una base de Supabase: la organización demo con su menú real, el agente de
WhatsApp configurado y 3 meses de datos de demostración. **Este PR no ejecuta nada contra la base real**: todos los comandos de abajo
los corre una persona, a propósito, con el OK de quien administra el proyecto.

> Regla de oro: **nada se aplica sin `--apply`**, y contra una base que no sea local además hace falta `--confirm-host=<host exacto>`.
> Sin esas banderas todos los scripts son *dry-run*.

## 0. Qué crea (y qué NO)

| Se crea | Detalle |
| --- | --- |
| Organización **`los-taquitos-de-pm-demo`** | Nombre «Los Taquitos de PM (demo)». Slug distinto al de la cuenta real (`los-taquitos-de-pm`), así que nunca se mezclan. Marcada en `restaurantes.demo_organization` (`is_demo`). |
| 7 sucursales | T1 y T3 activas con su catálogo impreso; **T7 García Lavín activa (fase 1 del agente: lista T1-2026, decisión de Javier del 2-oct-2026)**; T2 y T8 con catálogo provisional (lista 2026 marcada `provisional_P5`) pero inactivas; T5 Playa (Chicxulub) inactiva fuera de temporada; T4 Galerías inactiva y sin pedidos. |
| Menú | 279 productos, 25 categorías (237 del menú impreso + 40 fracciones de kilo + Extra Salsa y Extra Piña); 42 productos de alcohol marcados `no_domicilio`; catálogo y precio por sucursal (T1 278, T2 263, T3 251, T5 262, T7 278, T8 278). |
| Reglas | Horario 12:00–01:00 (una sola franja), pedido mínimo a domicilio $200, propina solo con tarjeta, promoción `LUNES2X1PM` (2x1 en tacos al pastor, solo recoger, **automática**). |
| Agente de WhatsApp | Perfil `taqueria_pm` en `whatsapp_agent_config` con los datos del dueño (tono de *usted*, tiempo de entrega, salsas, promociones). El nombre del asistente queda vacío (el dueño no lo definió). |
| Voz | **Deshabilitada**, con comportamiento y saludo por sucursal cargados. |
| Volumen (paso 5) | Pedidos, clientes, conversaciones, handoffs y contactos de demostración, con teléfonos ficticios `0001xxxxxx`. |

**No crea**: usuarios ni contraseñas (solo enlaza a un usuario de staff que ya existe con `--owner-email`), números de WhatsApp, credenciales
de nada, ni tareas programadas. **No toca** ninguna otra organización (si el slug demo existiera en otra vertical, aborta).

## 1. Requisitos

1. **Migraciones aplicadas** en la base destino. El *preflight* de cada script lista exactamente cuáles faltan y sale con código 3 sin
   escribir nada. Para la demo completa hacen falta, además de las anteriores del esquema de restaurantes: `022`, `023`, `025`, `027`,
   `028`, `029`, `031`, `033`, **`038_promociones_por_sucursal.sql`** (alcance del 2x1 por sucursal: sin ella el preflight aborta) y **`037_demo_organization.sql`** (la nueva de este trabajo; espejo
   `supabase/migrations/20240101000253_037_restaurantes_demo_organization.sql`). Aplicarlas es una decisión aparte (`docs/DEPLOY.md`).
2. **Código desplegado**: el chat público `/demo/<slug>` y el endpoint `/v1/restaurantes/demo/<slug>/…` ya están en el despliegue.
3. **Una cadena de conexión de propietario** (la que puede saltarse RLS y ejecutar `restaurantes.demo_limpiar`), en la variable
   **`SEED_DATABASE_URL`** (a propósito **no** se lee `DATABASE_URL`):
   `export SEED_DATABASE_URL='postgresql://usuario@host:5432/base'` (la contraseña va en `PGPASSWORD` o en el *keychain*, no en el comando).
4. **Node 22+** y `npm ci` hecho en el repo.
5. Para que el **chat** responda: una llave de proveedor LLM en el servidor (`OPENROUTER_API_KEY` u otra soportada). Sin ella el chat
   dice «Agente no disponible: requiere OPENROUTER_API_KEY…» (no hay respuestas simuladas). Es un cambio de configuración aparte.

## 2. Dry-run del seed de la cuenta demo (no abre ninguna conexión)

```bash
node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts --demo
```

Imprime el plan: 7 sucursales (3 activas), 279 productos, 42 de alcohol, 1 promoción, el perfil del agente, el modo `DEMO` y la lista de
**pendientes del dueño** (cambio de turno, WhatsApp por sucursal, coordenadas de T3, mapa de colonias, catálogo de SoftRestaurant,
nombre del asistente, combo del martes, identidad de T4). Atajo: `npm run demo:seed`.

## 3. Cargar la cuenta demo

```bash
export SEED_DATABASE_URL='postgresql://usuario@host:5432/base'
node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts --demo --apply \
  --confirm-host=host \
  --owner-email=correo-del-dueno@ejemplo.com   # opcional: enlaza como owner a un usuario de staff que YA existe
```

- Imprime la base objetivo (`host:puerto/base`, sin usuario ni contraseña) y la marca `(REMOTA)` si no es local.
- `--confirm-host` debe ser **exactamente** el host mostrado; si no coincide, aborta.
- Se ejecuta en **una sola transacción** y es **idempotente**: repetirlo repara lo que el seed controla (precios, alcohol, promoción) y
  **no pisa** lo que el dueño edite (tono y textos del agente, voz habilitada, usos de la promoción, widget apagado).
- Si el preflight falla, imprime las migraciones que faltan y no escribe nada (código 3).

## 4. Cómo verificar la carga

Con `psql "$SEED_DATABASE_URL"`:

```sql
-- 4.1 Marca demo y sucursales
select o.slug, o.name, d.activo, d.seed_version from core.organization o join restaurantes.demo_organization d on d.organization_id = o.id where o.slug = 'los-taquitos-de-pm-demo';
select bd.slug, p.status from restaurantes.branch_detail bd join core.property p on p.id = bd.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm-demo' order by bd.display_order;   -- t1 y t3 active; las demás inactive
-- 4.2 Menú y reglas
select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm-demo';                       -- 279
select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm-demo' and pr.no_domicilio;    -- 42
select code, auto_apply, channels, days_of_week from restaurantes.promotions p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm-demo';  -- LUNES2X1PM, true, {recoger}, {1}
-- 4.3 Agente
select perfil, tone_style, agent_name, delivery_time_text, enabled from restaurantes.whatsapp_agent_config c join core.organization o on o.id = c.organization_id where o.slug = 'los-taquitos-de-pm-demo';  -- taqueria_pm, formal_directo, null, ...
select bd.slug, v.habilitado from restaurantes.branch_voice_config v join restaurantes.branch_detail bd on bd.property_id = v.property_id join core.organization o on o.id = v.organization_id where o.slug = 'los-taquitos-de-pm-demo';  -- habilitado = false
```

Y en el navegador: `https://<dominio>/demo/los-taquitos-de-pm-demo` → debe verse el chat (si dice «Agente no disponible», falta la llave LLM) y, con
sesión de dueño, **Primeros pasos** debe listar los pendientes del dueño.

## 5. Cargar el volumen de demostración

```bash
# Dry-run: genera el volumen contra un mundo EN MEMORIA con el menú del seed, imprime el resumen y NO abre ninguna conexión
node scripts/seed-pm-demo/ejecutar.mjs seed-volumen --escala=moderado

# Aplicar
node scripts/seed-pm-demo/ejecutar.mjs seed-volumen --escala=moderado --apply --confirm-host=host
```

(`ejecutar.mjs` empaqueta el script con esbuild porque Node 22 en modo `--experimental-strip-types` no carga los repositorios; atajo:
`npm run demo:volumen -- --escala=moderado`.)

| Opción | Efecto |
| --- | --- |
| `--escala=ligero` | 30 días × ~12 pedidos/día (~400 pedidos). |
| `--escala=moderado` (**por omisión**) | 90 días × ~24 pedidos/día (~2,200 pedidos). |
| `--escala=completo` | 90 días × ~1,000 pedidos/día (**~90,000**, opción pesada; tarda y ocupa decenas de MB). |
| `--dias=N`, `--pedidos-por-dia=N`, `--semilla=N` | Ajustan la escala; misma semilla ⇒ mismos datos. |
| `--org-slug=<slug>` | Por omisión `los-taquitos-de-pm-demo`; **se niega** si la organización no está marcada como demo. |

Qué garantiza (probado en CI contra Postgres real, `scripts/verify-restaurantes-demo-volumen/`):

- Los pedidos se calculan con el **motor real de pedidos** (menú, precios, mínimo, alcohol, propina, horario y promoción del lunes), así que cada
  total es la suma de sus renglones menos el descuento del motor; nada se inserta sin pasar por ahí.
- Solo escribe teléfonos del rango reservado **`0001xxxxxx`** (no existe en México) y solo en una organización marcada como demo.
- **Idempotente**: repetirlo con las mismas opciones no duplica nada. Cada lote es su propia transacción: si se interrumpe, vuelva a lanzarlo.
- Horas en **America/Mérida**; el último día generado es **ayer**.

Verificación:

```sql
select count(*) from restaurantes.orders where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo');
select bd.slug, count(*) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo') group by 1 order by 1;   -- solo prol-montejo y pensiones
select count(*) from restaurantes.orders where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo') and customer_phone !~ '^0001[0-9]{6}$';   -- 0 (la demo aun no tiene sesiones del chat)
```

## 6. Operar la demo

- **Sesiones del chat**: cada visitante del chat usa un teléfono ficticio `0009xxxxxx`; sus pedidos aparecen en el panel como cualquier otro.
  Límites de costo: 20 mensajes/min por IP, **40 mensajes por sesión y día** y **600 por demo y día**; además aplican el presupuesto mensual y el
  *kill switch* del gateway de LLM.
- **Apagar el chat sin borrar nada**: `update restaurantes.demo_organization set activo = false where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo');`
  (volver a `true` lo enciende; el seed **no** lo reactiva).
- **Reinicio entre demos**: `node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=sesiones_widget --apply --confirm-host=host`.

## 7. Cómo BORRAR la demo

El script de limpieza llama a `restaurantes.demo_limpiar` (migración 037: `security definer`, `search_path` fijo, solo sesión de sistema/operador,
**se niega a operar sobre una organización que no esté marcada como demo**). Por omisión es *dry-run*: cuenta lo que borraría.

```bash
# 7.1 Qué se borraría (no borra nada)
node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=volumen

# 7.2 Solo el volumen de demostración (pedidos, clientes y conversaciones 0001…, con sus handoffs y contactos); deja menú, reglas y agente
node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=volumen --apply --confirm-host=host

# 7.3 Solo las sesiones del chat (0009…); --horas=24 borra solo las de más de 24 horas
node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=sesiones_widget --horas=24 --apply --confirm-host=host

# 7.4 TODA la organización demo (cascada: sucursales, menú, configuración, pedidos…)
node --experimental-strip-types scripts/seed-pm-demo/limpiar-demo.ts --modo=todo --apply --confirm-host=host
```

Comprobación tras 7.4: `select count(*) from core.organization where slug = 'los-taquitos-de-pm-demo';` → 0. La cuenta real de PM
(`los-taquitos-de-pm`) y cualquier otra organización **no se tocan** (probado en el verify con una organización ajena que usa el mismo rango de teléfonos).

Para revertir la migración 037 en sí (no recomendado salvo que no queden demos): `drop function restaurantes.demo_limpiar(uuid, text, integer); drop table restaurantes.demo_organization;`.

## 8. Qué verifica CI (y qué no)

- `scripts/verify-restaurantes-demo/` (20 escenarios): RLS y `GRANT` de la marca demo (lectura por sistema/staff propio; `anon` y otra
  organización no; **nadie** de la aplicación escribe la marca) y la limpieza (guarda `auth.uid()`, sin `EXECUTE` para roles de la app, modos
  inválidos, aislamiento entre organizaciones).
- `scripts/verify-restaurantes-seed-pm/` (29 escenarios): el seed real, su idempotencia, la configuración del agente, la carga `--demo` y que la
  promoción del lunes quede automática.
- `scripts/verify-restaurantes-demo-volumen/` (21 escenarios): el SQL real del volumen (coherencia, reglas duras, idempotencia, rechazos,
  cross-tenant, limpieza).
- **No** verifica el comportamiento del LLM (depende de la llave y del modelo): las reglas duras (mínimo, alcohol, múltiplos, propina, horario, queja/alergia)
  las aplica el servidor y están cubiertas por pruebas; la conversación libre la valida el guion `docs/DEMO-PM.md`.

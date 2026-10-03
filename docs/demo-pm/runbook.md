# Runbook: cargar la demo de PM en la base (idempotente, re-ejecutable y con limpieza)

Deja la **demo de Los Taquitos de PM sobre T7 García Lavín** en una base de Supabase con **un comando**: la organización demo con su menú real,
el agente de WhatsApp (perfil `taqueria_pm`) y la voz configurados, y **8 semanas de datos de volumen con el ritmo real de T7**.
Se presenta con `docs/demo-pm/guion.md`.

> **Este trabajo no ejecuta nada contra la base real.** Todos los comandos de abajo los corre una persona, a propósito, con el OK de quien
> administra el proyecto (Javier decide cuándo se carga en la base real).
> Regla de oro: **nada se aplica sin `--apply`**, y contra una base que no sea local además hace falta `--confirm-host=<host exacto>`.
> Sin esas banderas todo es *dry-run*.

## 0. Resumen en cuatro comandos

```bash
export SEED_DATABASE_URL='postgresql://usuario@host:5432/base'   # contraseña en PGPASSWORD o keychain; a propósito NO se lee DATABASE_URL

npm run demo:pm                                                   # 1. DRY-RUN: valida y muestra el plan; no abre ninguna conexión
npm run demo:pm -- --apply --confirm-host=host [--owner-email=correo-del-dueno@ejemplo.com]   # 2. CARGA (idempotente)
npm run demo:verificar -- --api-url=https://<api>                  # 3. VERIFICA (solo lectura): checklist con veredicto
npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=host                     # 4. entre demos: borra ensayos del chat
```

`npm run demo:pm -- --apply …` ejecuta, **en este orden** y deteniéndose en el primer fallo:

| Paso | Qué hace | Si se repite |
| --- | --- | --- |
| 1. `seed` | Siembra la organización `los-taquitos-de-pm-demo` marcada como demo: 7 sucursales (**T7 activa**), 279 productos con precio por sucursal, reglas, promoción, agente `taqueria_pm`, voz deshabilitada | *Upsert*: repara lo que el seed controla y **no pisa** lo que el dueño edite (tono, textos del agente, voz, widget apagado) |
| 2. `limpiar-volumen` | Borra **solo** lo ficticio del rango `0001xxxxxx` (pedidos, clientes, conversaciones, tomas, contactos) | Idempotente: sin nada que borrar no hace nada |
| 3. `volumen` | Genera con el **motor real de pedidos** el perfil `t7`: **139 pedidos en 56 días, solo T7**, 70 clientes (32 recurrentes con el 73 % de los pedidos), 79 % a domicilio, todo por WhatsApp, ticket mediano ≈ $643, entregas de 50 a 90 min | Determinista; el paso 2 lo borró antes, así que repetirlo otro día **no duplica ni desfasa** nada (el último día siempre es *ayer*) |
| 4. `limpiar-sesiones` | Borra las conversaciones, pedidos y tomas del chat público (rango `0009xxxxxx`) | Idempotente (`--conservar-sesiones` lo omite) |
| 5. `verificar` | Lee la base y emite el checklist (ver §3) | Solo lectura |

**Idempotente y re-ejecutable**: si un paso falla (migración faltante, host sin confirmar, red), los siguientes **no corren** y repetir el comando completo es seguro.
Cada lote del volumen es su propia transacción: una interrupción se reanuda repitiendo el comando.

## 1. Requisitos

1. **Migraciones aplicadas** en la base destino. El *preflight* de cada paso lista exactamente cuáles faltan y sale con código 3 **sin escribir nada**. Para la demo hacen falta
   las del esquema de restaurantes más `022`, `023`, `025`, `027`, `031`, `033`, `038_promociones_por_sucursal.sql` y **`037_demo_organization.sql`** (espejos en
   `supabase/migrations/`). Aplicarlas es una decisión aparte (`docs/DEPLOY.md`). La `039` (umbral de pedido grande y ráfagas) la usa el agente con degradación elegante si falta.
2. **Código desplegado**: el chat público `/demo/<slug>` y `/v1/restaurantes/demo/<slug>/…`.
3. **`SEED_DATABASE_URL`** con un usuario que pueda saltarse RLS y ejecutar `restaurantes.demo_limpiar`.
4. **Node 22+** y `npm ci` hecho.
5. Para que el **chat** responda: una llave de proveedor LLM en el servidor (`OPENROUTER_API_KEY` u otra soportada). Sin ella el chat dice
   «Agente no disponible: requiere OPENROUTER_API_KEY…» (**no hay respuestas simuladas**). Es un cambio de configuración aparte.
6. Para la **voz real** y el **WhatsApp real**: credenciales de proveedor y el número de T7; **no** forman parte de la demo (la voz queda deshabilitada y el chat usa el widget).

## 2. Qué crea (y qué NO)

| Se crea | Detalle |
| --- | --- |
| Organización **`los-taquitos-de-pm-demo`** | «Los Taquitos de PM (demo)». Slug distinto al de la cuenta real (`los-taquitos-de-pm`), así que nunca se mezclan. Marcada en `restaurantes.demo_organization`. |
| 7 sucursales | **T7 García Lavín activa (fase 1, decisión de Javier del 2-oct-2026, lista T1-2026)**, T1 y T3 activas con su catálogo impreso; T2 y T8 con catálogo provisional pero inactivas; T5 inactiva fuera de temporada; T4 inactiva y sin pedidos. |
| Menú | 279 productos, 25 categorías (237 del menú impreso + 40 fracciones de kilo + Extra Salsa y Extra Piña); 42 de alcohol marcados `no_domicilio`; catálogo y precio por sucursal. |
| Reglas | Horario 12:00–01:00, pedido mínimo a domicilio $200, propina solo con tarjeta, promoción `LUNES2X1PM` (automática, solo recoger, solo T2/T3/T4: nunca en T7). |
| Agente de WhatsApp | Perfil `taqueria_pm` con los datos del dueño (tono de *usted*, tiempos de T7: domicilio 60 a 75 min, pico 75 a 90; recoger 25 a 35, pico 45 a 60; salsas; promociones). Nombre del asistente vacío (el dueño no lo definió). |
| Voz | **Deshabilitada**, con comportamiento y saludo por sucursal cargados. |
| Volumen | Perfil `t7`: pedidos, clientes, conversaciones, tomas y contactos de demostración con teléfonos ficticios `0001xxxxxx` (rango que no existe en México). |

**No crea**: usuarios ni contraseñas (solo enlaza a un usuario de staff que **ya existe** con `--owner-email`), números de WhatsApp, credenciales ni tareas programadas.
**No toca** otra organización (si el slug demo existiera en otra vertical, aborta).

## 3. Cómo verificar la carga

`npm run demo:verificar [-- --api-url=https://<api>]` es **solo lectura** (transacción `read only`) y sale con código 1 si falla algún requisito:

| Punto | Requisito |
| --- | --- |
| `org-demo`, `widget-activo` | La organización existe, está marcada como demo y el widget está encendido |
| `t7-activa` | T7 García Lavín activa |
| `agente-pm` | Perfil `taqueria_pm` habilitado |
| `volumen-cargado`, `volumen-solo-t7`, `volumen-ritmo` | Hay volumen, **solo de T7**, con ≈ 139 pedidos |
| `recurrentes`, `whatsapp`, `domicilio`, `ticket`, `tiempos` | 65–80 % de pedidos de recurrentes (real: 73 %), todo por WhatsApp, 70–88 % a domicilio, ticket mediano $500–$800 (real: $643), entrega mediana de 58 a 72 min (real: 65) |
| `voz` (aviso) | Dice que la voz está **deshabilitada a propósito** (los KPIs de voz salen en cero) |
| `sesiones-widget` (aviso) | Avisa si quedan ensayos del chat |
| widget (con `--api-url`) | Consulta `GET /v1/restaurantes/demo/<slug>/estado`: «disponible» o el motivo honesto (p. ej. «requiere OPENROUTER_API_KEY») |

Y en el navegador: `https://<dominio>/demo/los-taquitos-de-pm-demo` debe abrir el chat **ya en T7 García Lavín**; con sesión de dueño, **Primeros pasos** lista los pendientes del dueño.

Consultas a mano (opcional), con `psql "$SEED_DATABASE_URL"`:

```sql
select o.slug, d.activo from core.organization o join restaurantes.demo_organization d on d.organization_id = o.id where o.slug = 'los-taquitos-de-pm-demo';
select bd.slug, p.status from restaurantes.branch_detail bd join core.property p on p.id = bd.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm-demo' order by bd.display_order;   -- garcia-lavin, prol-montejo y pensiones active
select bd.slug, count(*) from restaurantes.orders o join restaurantes.branch_detail bd on bd.property_id = o.property_id where o.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo') group by 1;   -- solo garcia-lavin: 139
```

## 4. Opciones

| Opción | Efecto |
| --- | --- |
| `--dias=N` | Ventana del volumen (56 por omisión = las 8 semanas de la muestra real); escala los pedidos (máximo 365). Los umbrales de `demo:pm --verificar` están calibrados para los 56 días: con otro valor la carga termina bien pero la verificación puede marcar «Demo NO lista»; para presentar, déjelo en el valor por omisión |
| `--owner-email=…` | Enlaza como *owner* a un usuario de staff existente |
| `--conservar-sesiones` | No borra los ensayos del chat |
| `--verificar` | Solo lectura (no se combina con `--apply`) |

Para otro volumen (genérico, varias sucursales, `--escala=ligero|moderado|completo`) sigue existiendo `npm run demo:volumen` (ver `scripts/seed-pm-demo/README.md`); **antes de cambiar de perfil
o escala limpie** con `npm run demo:limpiar -- --modo=volumen --apply --confirm-host=host` (el verificador marca «volumen-solo-t7» en falla si quedó mezclado).

## 5. Operar la demo

- **Sesiones del chat**: cada visitante usa un teléfono ficticio `0009xxxxxx`; sus pedidos aparecen en el panel como cualquier otro. Topes de costo: 20 mensajes/min por IP, **40 por sesión y día**, **600 por demo y día**,
  además del presupuesto mensual y el *kill switch* del gateway de LLM.
- **Apagar el chat sin borrar nada**: `update restaurantes.demo_organization set activo = false where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm-demo');`
  (volver a `true` lo enciende; el seed **no** lo reactiva).
- **Reinicio entre demos**: `npm run demo:limpiar -- --modo=sesiones_widget --apply --confirm-host=host` (`--horas=24` borra solo las de más de 24 horas).

## 6. Cómo BORRAR la demo

`npm run demo:limpiar` llama a `restaurantes.demo_limpiar` (migración 037: `security definer`, `search_path` fijo, solo sesión de sistema/operador, **se niega a operar sobre una organización que no esté marcada como demo**). Por omisión es *dry-run* (cuenta lo que borraría).

```bash
npm run demo:limpiar -- --modo=volumen                                                  # qué se borraría (no borra nada)
npm run demo:limpiar -- --modo=volumen --apply --confirm-host=host                      # solo el volumen (0001…); deja menú, reglas y agente
npm run demo:limpiar -- --modo=sesiones_widget --horas=24 --apply --confirm-host=host   # solo ensayos del chat (0009…)
npm run demo:limpiar -- --modo=todo --apply --confirm-host=host                         # TODA la organización demo (cascada)
```

Comprobación tras `--modo=todo`: `select count(*) from core.organization where slug = 'los-taquitos-de-pm-demo';` → 0. La cuenta real de PM y cualquier otra organización **no se tocan**
(probado en el verify con una organización ajena que usa el mismo rango de teléfonos).

## 7. Qué verifica CI (y qué no)

- `scripts/verify-restaurantes-demo-volumen/` (27 escenarios contra Postgres real, **incluye V18/V19**): el SQL real del volumen (coherencia, reglas duras, idempotencia, rechazos, cross-tenant, limpieza),
  el **perfil T7 en SQL real** (139 pedidos solo T7, idempotente) y la **consulta de verificación** contra lo sembrado.
- `scripts/verify-restaurantes-demo/` y `scripts/verify-restaurantes-seed-pm/`: la marca demo, su limpieza y el seed real con su idempotencia.
- Pruebas unitarias: el perfil de volumen (cifras reales de T7), el comando `demo:pm` (orden y salvaguardas), el evaluador del verificador y **las cifras del guion contra el motor de pedidos** (`demo-pm-guion.spec.ts`).
- **No** verifica el comportamiento del LLM (depende de la llave y del modelo): las reglas duras (mínimo, alcohol, múltiplos, propina, horario, alergia) las aplica el servidor y están cubiertas por pruebas;
  la conversación libre se valida con el guion, que marca qué es **[Servidor]** y qué **[Agente]**.

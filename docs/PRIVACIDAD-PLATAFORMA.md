# Privacidad de plataforma (PL-13 P1)

> **No es asesoría legal.** Los plazos y los días de retención de este documento son una referencia técnica
> conservadora (días de calendario) pensada para operar con la LFPDPPP vigente desde 2025. Cada responsable debe
> validar su aviso de privacidad, sus plazos y su política de retención con su asesor jurídico. Lo marcado como
> "valor por defecto" es un punto de partida, no una obligación legal.

## Qué entrega

Una capa de plataforma que **reutiliza** lo que ya existía en cada vertical (ARCO de restaurantes #229, citas #220,
hoteles #211/#212) sin duplicarlo ni cambiarlo:

| Pieza | Dónde vive | Quién la usa |
| --- | --- | --- |
| Vista unificada de solicitudes ARCO con plazos y estados | `core._arco_union()` (interna) + `core.org_list_arco_requests`, `core.platform_list_arco_requests` | owner/admin de la organización; superadmin |
| Políticas de retención por organización | `core.retention_class` (catálogo), `core.retention_policy` | owner/admin |
| Bloqueo previo a purga (retención legal) | `core.purge_hold` | owner/admin |
| Registro de purgas (qué, cuándo, cuántas filas, sin PII) | `core.purge_run_log` (append-only) | owner/admin (suyas); superadmin (todas) |
| Aviso de privacidad versionado + aceptación | `core.privacy_notice_version`, `core.privacy_notice_acceptance` (append-only) | owner/admin |
| Purga por retención | `core.system_run_retention_purge`, `core.system_list_purge_targets` (solo sistema) | endpoint interno |

Migración: `packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql` (espejo byte-idéntico
`supabase/migrations/20240101000238_0036_plataforma_arco_retencion_aviso.sql`). Verificación contra Postgres real:
`scripts/verify-plataforma-privacidad/` (la recoge el gate de CI).

## Solicitudes ARCO

La plataforma solo **lee** las tablas de los verticales (`citas.data_rights_requests`,
`restaurantes.data_rights_requests`, `hoteles.arco_request`) y las normaliza:

| Estado normalizado | Citas / Restaurantes | Hoteles |
| --- | --- | --- |
| `por_confirmar` | `pendiente_confirmacion` | — |
| `abierta` (recibida) | `recibida` | `recibida` |
| `en_proceso` | `en_proceso` | `en_revision`, `procedente` |
| `bloqueada` | `bloqueada` | — |
| `resuelta` | `resuelta` | `ejecutada` |
| `rechazada` | `rechazada` | `improcedente` |
| `cerrada` | `cancelada_titular`, `expirada` | — |

- **Plazo de referencia:** 20 días para responder y 15 más para ejecutar (días naturales). El plazo que se muestra
  depende del estado: solicitud sin atender → fecha de respuesta; en proceso o bloqueada → fecha de ejecución (o de
  respuesta si no existe). Una solicitud abierta con el plazo relevante en el pasado es `vencida`; a 5 días o menos,
  `por_vencer`.
- Las fechas de hoteles son columnas `date`; se leen como el inicio (UTC) del día límite, la referencia más temprana.
- **Minimización:** la vista no devuelve teléfono, correo, nombre ni detalle del titular. Para atender una solicitud
  (verificar identidad, responder, cambiar de estado) se usa el panel Privacidad del vertical.
- Despachos, licitaciones y rentas todavía no tienen tabla ARCO propia; cuando la tengan, se agrega un `union all` en
  `core._arco_union()`.

## Retención y purga

Valores por defecto (catálogo `core.retention_class`):

| Clase | Defecto | Rango | La purga la corre |
| --- | --- | --- | --- |
| `restaurantes_whatsapp_conversaciones` | 180 días | 30 a 1095 | plataforma |
| `restaurantes_voz_transcripciones` | 30 días | 0 a 365 (0 = no conservar) | plataforma |
| `hoteles_identidad_documento` | 30 días | 0 a 365 | el vertical (`hoteles.sweep_identity_retention`) |

Precedencia de los días efectivos: **política de la organización > configuración del vertical
(`restaurantes.privacy_config`) > defecto**. Una clase que corre el vertical solo documenta su defecto: la plataforma
no acepta una política que el vertical no aplicaría.

### Orden de una purga (`core.system_run_retention_purge`)

1. Solo sesión de sistema (`auth.uid() is null`); un usuario de staff, aun owner, recibe 42501.
2. **Bloqueo previo:** si hay un bloqueo activo para esa clase (o para todas), no se toca nada y se registra
   `bloqueada` con el motivo fijo `retencion_legal_activa`.
3. Se resuelven los días efectivos y el corte.
4. **Titulares protegidos:** nunca se purga a un titular con una solicitud ARCO abierta (`recibida`, `en_proceso`,
   `bloqueada`); esas filas se cuentan como `rows_protected`.
5. Se ejecuta (o se simula con `p_dry_run`) por lote acotado y se registra SIEMPRE el resultado en `purge_run_log`:
   clase, estado (`ok`, `simulacion`, `bloqueada`, `sin_ejecutor`), días, corte, filas afectadas, anonimizadas y
   protegidas. Sin PII.

La purga de restaurantes replica la regla de `restaurantes.system_purge_expired_privacy_data` (vacía mensajes de
WhatsApp; borra turnos de voz y anula el hash del teléfono) pero **por organización** y con los días de la plataforma.
Ambas pueden coexistir: la de restaurantes sigue siendo global y usa su propia configuración (`restaurantes.privacy_config`);
si una organización fija en la plataforma MÁS días que en esa configuración y la purga de restaurantes se programa, esta
última purgará antes. Hoy ninguna de las dos está programada en `vercel.json`.

### Endpoint interno (NO programado)

`GET|POST /internal/plataforma/privacidad-retencion` (secreto interno o `Authorization: Bearer` de cron):

- **Sin `ejecutar=1` solo simula** (cuenta y registra; no borra).
- `?ejecutar=1` purga de verdad.
- `?organizationId=<uuid>` una sola organización; `?despuesDe=<uuid>` continúa desde el cursor
  `siguienteDespuesDe`; `?limite=<n>` filas por unidad (1 a 5000, por defecto 500).
- Una transacción de sistema **por (organización, clase)**: un error en una unidad no revierte las demás ni deja la
  sesión abortada.
- **No está en `vercel.json`**: programarlo es una decisión de costo y de despliegue. Para correrlo a mano:

```bash
curl -s -H "x-atiende-internal-secret: $INTERNAL_SECRET" \
  "https://<api>/internal/plataforma/privacidad-retencion?organizationId=<uuid>"          # simulación
curl -s -H "x-atiende-internal-secret: $INTERNAL_SECRET" \
  "https://<api>/internal/plataforma/privacidad-retencion?organizationId=<uuid>&ejecutar=1"  # purga real
```

## Aviso de privacidad versionado

- `POST /v1/privacidad/avisos` publica una **versión nueva** (título, aviso simplificado, URL https del aviso
  integral). Se guarda la huella sha256 de lo publicado; los textos no se editan (append-only).
- Quien publica acepta la versión en el mismo acto; otro owner/admin la acepta con
  `POST /v1/privacidad/avisos/:version/aceptar` (solo la versión vigente, una vez por persona).
- La "aceptación" registrada es la del **responsable (el cliente)** de la versión del aviso que opera. La evidencia de
  entrega del aviso al **titular final** sigue en cada vertical (p. ej. `restaurantes.privacy_notice_deliveries`).

## Superficie

| Ruta | Quién | Notas |
| --- | --- | --- |
| `GET /superadmin/privacidad/{resumen,arco,purgas}` | superadmin (solo lectura) | `/superadmin/privacidad` en el panel |
| `GET /v1/privacidad/{resumen,arco}` | owner/admin | la organización sale del token |
| `PUT\|DELETE /v1/privacidad/retencion/:claseDato` | owner/admin | rango por clase validado en SQL |
| `POST /v1/privacidad/bloqueos`, `.../:id/liberar` | owner/admin | motivo de 10 a 300 caracteres |
| `POST /v1/privacidad/avisos`, `.../:version/aceptar` | owner/admin | ver arriba |
| `GET\|POST /internal/plataforma/privacidad-retencion` | sistema | no programado |

Pantalla por organización: panel de restaurantes → **Privacidad de la organización**
(`/restaurantes/:orgSlug/privacidad-organizacion`). El API es independiente del vertical; falta enlazarla en los
demás paneles.

## Compatibilidad con la base sin migrar

Mergear despliega el código al instante y la base real va por detrás. Todo el TypeScript nuevo captura 42883, 42P01 y
42703 con `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) y degrada: las lecturas responden
`disponible: false` con un mensaje honesto, las escrituras 503 y el endpoint interno `disponible: false` sin tocar nada.
Nunca un 500 ni una transacción abortada. Los tests usan `AbortAwareFakeSession`.

## Orden de despliegue

1. Aplicar `0036_plataforma_arco_retencion_aviso.sql` (o su espejo `20240101000238_...`) a la base. Requiere las
   migraciones citas 024, restaurantes 030, hoteles 032, db 0012 y 0034 ya aplicadas.
2. Mergear el código (puede ir antes: sin la migración todo responde "no disponible").
3. Probar con el endpoint interno **sin** `ejecutar=1` para una organización y revisar el registro de purgas.
4. Solo entonces, si se decide, programar el cron o ejecutar con `ejecutar=1`.

## Huecos conocidos

- Sin cron: la purga no corre sola (decisión de costo).
- Hoteles: solo se documenta su retención y se lee su ARCO; su purga sigue siendo `sweep_identity_retention`.
- Despachos, licitaciones y rentas no tienen ARCO propio todavía.
- Los cambios de política de retención guardan quién y cuándo (`updated_by/updated_at`), no un historial.
- La acción sobre una solicitud (responder, cambiar estado) sigue en el panel de cada vertical.

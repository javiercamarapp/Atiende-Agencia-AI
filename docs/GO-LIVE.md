# Go-live de una organización de restaurantes — orden y verificación

Cómo saber si una organización (p. ej. `los-taquitos-de-pm`) está lista para recibir clientes reales **sin revisar a mano cinco lugares**:
la vista "Listo para producción" y su CLI corren las mismas verificaciones (`apps/api/src/superadmin-preflight/verificaciones.ts`), solo
de lectura, sin escribir nada ni imprimir valores de variables (solo nombres y booleanos).

## Dónde verlo

- **Panel**: `/superadmin/organizaciones/<id>` → pestaña **Listo para producción**. Muestra el conteo de pendientes, el semáforo por área, cómo
  resolver cada punto (con enlace a la pantalla) y el botón **Volver a verificar**. Respaldo de la API: `GET /superadmin/organizaciones/:id/preflight`.
- **Terminal** (lo corre Javier, con una conexión de solo lectura que se pasa por variable de entorno; nunca va al repo):

  ```bash
  GO_LIVE_DATABASE_URL='postgresql://...' npm run verify:go-live -- \
    --org los-taquitos-de-pm --superadmin <uuid-del-superadmin> --env-file .env.production.local
  ```

  `--env-file` es el archivo de `vercel env pull` (el entorno de producción a verificar; sin él se usa el entorno del proceso y el reporte lo avisa).
  La lectura va en **una sola transacción `begin read only` que siempre termina en `rollback`**. Sale `0` si ninguna verificación está en
  `falta`, `1` si hay alguna, `2` por uso incorrecto y `3` si no se pudo leer (conexión, organización, o el usuario no es superadmin).

Estados: `ok` (en orden), `falta` (bloquea el go-live), `aviso` (no bloquea, conviene revisarlo; también es lo que sale cuando una fuente no
se pudo leer: nunca se lee como "en orden"), `no_aplica`.

## Orden de la lista y qué verificación cubre cada paso

Los números G-xx son los de la matriz de plataforma. Los pasos que dependen de terceros o de una persona se marcan "fuera del preflight".

| Paso | Qué hay que dejar hecho | Verificación (id) |
|---|---|---|
| G-03 | Crons corriendo: `CRON_SECRET` con el mismo valor que `INTERNAL_SECRET` y latido reciente de `whatsapp/dispatch`, `restaurantes/*` y `plataforma/privacidad-retencion` | `crons.secreto`, `crons.<ruta>` |
| G-05 | `APP_BASE_URL` (https, obligatoria en producción: sin ella la API no arranca) y `ALLOWED_ORIGINS` con el dominio real del panel | `entorno.app_base_url`, `entorno.allowed_origins` |
| G-06 | Correo: `RESEND_API_KEY` y `RESEND_FROM_EMAIL` (remitente de un dominio verificado en Resend; en producción no hay remitente por omisión) | `entorno.correo` |
| G-07 | Dueño con cuenta y alguien del equipo en cada sucursal activa | `equipo.owner`, `equipo.cobertura` |
| G-09 | `privacy_config` completa (responsable y URL https del aviso) y versión del aviso vigente | `privacidad.config`, `privacidad.version`, `datos.aviso_privacidad` |
| G-10 | Meta: las tres variables del webhook y el envío, y el número de WhatsApp registrado (general y por sucursal) | `entorno.meta`, `canal.general`, `canal.sucursales` |
| G-11 | Plantillas de estado de pedido aprobadas y declaradas en `WHATSAPP_APPROVED_TEMPLATES` | `canal.plantillas` |
| G-13 | Alertas salientes (`ALERTAS_EMAIL_DESTINATARIOS`, `ALERTAS_WEBHOOK_URL` o `SENTRY_DSN`) | `monitoreo.alertas` |
| G-14 | `SUPERADMIN_MFA_REQUIRED` y el superadmin que verifica con MFA activa; OpenRouter con llave | `entorno.mfa_requerida`, `equipo.mfa_superadmin`, `entorno.openrouter` |
| G-16 | Esta vista sin rojos; además el checklist del dueño (sucursales, menú, horarios, agente, aviso de privacidad, pedido de prueba) | `datos.*` (consume `buildOnboardingChecklist`, no lo duplica) |
| G-18 | Voz: credenciales (`GEMINI_API_KEY`, `VOICE_PREVIEW_TOKEN_SECRET`) solo si alguna sucursal activa la habilita; decisión de voz por sucursal | `voz.credenciales`, `voz.decision` |

Fuera del preflight (no hay forma de verificarlos desde la API): G-01/G-02 (PRs fusionados), G-04 (cierre del día, otra pieza), G-08 (permisos),
G-12 (estados de entrega de Meta), G-15 (respaldo), G-17 (pedido de prueba real de punta a punta con un teléfono de Javier), G-19, y que el
workflow `prod-health` tenga `PROD_BASE_URL` (variable del repositorio en GitHub, no del despliegue). Si la base de producción aún no tiene
las migraciones 0053 (equipo) o 0057 (datos del preflight), esas verificaciones salen como `aviso` "no disponible aún", no como `falta`.

## Valores por omisión que ya no existen

- `APP_BASE_URL`: en producción (`VERCEL_ENV=production`, o `NODE_ENV=production` sin `VERCEL_ENV`) es obligatoria y debe ser `https://`;
  sin ella la API no arranca con un mensaje claro. Fuera de producción: `https://$VERCEL_URL` y, si no hay, `http://localhost:5173`.
  Ojo: si el proyecto de Vercel no expone las System Environment Variables, `VERCEL_ENV` llega vacío y `NODE_ENV=production` hace que los despliegues Preview
  también cuenten como producción (y no arranquen sin `APP_BASE_URL`); activa «Automatically expose System Environment Variables» o define `APP_BASE_URL` también en Preview.
- `RESEND_FROM_EMAIL`: en producción, con `RESEND_API_KEY` pero sin remitente el correo queda **no configurado** (cada envío falla explícito),
  no se inventa un remitente. Fuera de producción: el remitente de pruebas de Resend (`onboarding@resend.dev`).

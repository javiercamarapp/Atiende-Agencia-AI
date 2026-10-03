# Runbook de incidentes (PL-18)

Qué hacer cuando algo falla en producción. Complementa `docs/ROLLBACK.md` (volver atrás un despliegue),
`docs/RESPALDO-Y-RESTAURACION.md` (datos) y `docs/runbooks/DR.md` (desastre). **Nada de aquí se ejecuta solo**: lo decide y lo hace
Javier (único operador hoy); el repo y su CI no tocan la base real ni Vercel.

> Regla de oro: en un incidente se **detiene el daño primero** (interruptor, pausa de merges, rollback) y se investiga después.
> Nunca pegues secretos, tokens ni datos personales en chats, issues o PRs (el repo es público).

## 1. Severidades

| Sev | Qué es | Ejemplos | Respuesta |
|---|---|---|---|
| **SEV1** | Caída total, pérdida o exposición de datos, cobro o envío masivo erróneo | `/health` caído, fuga de datos entre organizaciones, secreto expuesto, WhatsApp/correo enviando de más | Inmediata, detén el daño en minutos; postmortem obligatorio |
| **SEV2** | Una vertical o función crítica degradada sin pérdida de datos | Un cron lleva horas en `error`, agente de WhatsApp sin responder, login intermitente | Mismo día; postmortem corto |
| **SEV3** | Falla acotada con alternativa | Un reporte falla, una pantalla con error, un proveedor lento | En la siguiente ronda de trabajo; ticket |
| **SEV4** | Molestia cosmética o deuda | Texto, estilo, aviso redundante | Backlog |

Si dudas entre dos severidades, toma la mayor y baja después.

## 2. Quién decide

| Decisión | Quién |
|---|---|
| Declarar y cerrar el incidente, severidad | Javier |
| Rollback de código, pausar merges, apagar un cron o un agente (interruptor) | Javier |
| Rotar un secreto | Javier (ver `docs/runbooks/ROTACION-DE-LLAVES.md`) |
| Restaurar datos / aplicar o no una migración | Javier, nunca un agente automático |
| Investigar, proponer el arreglo y abrir el PR | Agente de código, con revisión de Javier antes de fusionar |

Los agentes de código **no** aplican migraciones a la base real, no tocan la configuración de Vercel y no fusionan PRs sin autorización explícita.

## 3. Detección

- `prod-health.yml` sondea `/health` cada 15 min (`.github/workflows/README.md`).
- `/superadmin/salud/crons`: latido y cadencia de cada cron; `/superadmin/salud` para el resto.
- Campana de superadmin y correo de alertas (`ALERTAS_*`, `SENTRY_DSN`; ver `docs/CREDENCIALES.md`).
- Vercel: estado del último despliegue y logs de funciones. Sentry, si está configurado.

## 4. Checklist de respuesta

1. **Anota** hora de inicio, síntoma, severidad y último merge a `main` (`git log -3 --merges origin/main`).
2. **Contén** (elige lo mínimo que detenga el daño):
   - Un cron o agente que se porta mal: superadmin → Interruptores (cron `<path>`, agente `<rol>`, o los globales `crons` / `llm`). Pausado responde 200 `skipped: kill_switch`.
   - Despliegue malo: `docs/ROLLBACK.md` (`scripts/rollback/rollback.sh`). Después pausa los merges: el rollback no bloquea despliegues futuros.
   - Secreto expuesto: rótalo (`ROTACION-DE-LLAVES.md`) **antes** de investigar el alcance.
   - Datos mal escritos: no ejecutes `UPDATE`/`DELETE` improvisados; congela con el interruptor y sigue `DR.md`.
3. **Comunica** (sección 5).
4. **Diagnostica** con evidencia: logs de Vercel, `core.cron_heartbeat` / bitácora de corridas, Sentry, el diff del último merge. Distingue "empezó con el despliegue" (rollback) de "falla un proveedor" (Supabase, Meta, Resend, OpenRouter: revisa su página de estado y no hagas rollback).
5. **Arregla hacia adelante** en un PR con prueba que reproduzca el fallo; si el rollback no basta, `git revert` del merge (commit nuevo, sin force-push).
6. **Verifica** tras el arreglo: `npm run smoke:post-deploy -- https://<dominio>`, `node --experimental-strip-types scripts/health-check/check.ts https://<dominio>`, y el siguiente ciclo de crons en verde.
7. **Cierra** reanudando lo pausado (interruptores) y escribe el postmortem (sección 6).

## 5. Comunicación

- **Interna**: anota la línea de tiempo en el wiki de Javier mientras ocurre (hora, acción, resultado).
- **Clientes** (SEV1 con impacto visible): aviso corto, en español, sin jerga: qué falló, qué datos tocó (o "ninguno"), qué se hizo y cuándo se normaliza. Sin detalles técnicos explotables.
- **Exposición de datos personales**: además de lo anterior, evalúa el aviso a los titulares y a la autoridad según corresponda (ver `docs/PRIVACIDAD-PLATAFORMA.md` y consulta legal); no lo decide un agente.
- **Repo público**: describe el fallo como disponibilidad o defensa en profundidad, sin receta de explotación, hasta que el arreglo esté desplegado.

## 6. Postmortem (sin culpas, máx. una página)

Plantilla, en el wiki y (si no revela nada sensible) como nota en `docs/`:

```
Título / fecha / severidad / duración
Impacto: quién y qué se afectó (datos, dinero, mensajes)
Línea de tiempo: detección, contención, arreglo, cierre
Causa raíz: la causa, no el síntoma (por qué no lo atrapó una prueba o el CI)
Qué salió bien / qué salió mal
Acciones: dueño y fecha; al menos una prueba o guarda nueva que impida la repetición
```

Revisa que cada acción tenga ticket. Un incidente sin prueba o guarda nueva no está cerrado.

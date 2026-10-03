# Runbook de recuperación ante desastres (PL-18)

Índice de decisión para un desastre (pérdida de la base, del proyecto de Supabase, del despliegue o de un secreto). El detalle
vive en dos documentos; este runbook dice **cuál usar y en qué orden**.

- Datos: [`docs/RESPALDO-Y-RESTAURACION.md`](../RESPALDO-Y-RESTAURACION.md) (respaldo lógico, drill de restauración, RPO/RTO propuestos de 24 h / 2 h).
- Código desplegado: [`docs/ROLLBACK.md`](../ROLLBACK.md) (`vercel rollback` vía `scripts/rollback/rollback.sh`; no revierte la base).
- Respuesta general: [`INCIDENTES.md`](INCIDENTES.md). Secretos: [`ROTACION-DE-LLAVES.md`](ROTACION-DE-LLAVES.md).

> Nada de este repo ni de su CI se conecta a la base real. Todo lo de abajo lo ejecuta Javier con su cuenta.

## Qué se perdió, qué usar

| Escenario | Primera acción | Documento |
|---|---|---|
| El último despliegue rompió la app, la base está bien | Rollback de código | `ROLLBACK.md` |
| Una migración o un script dejó datos mal | Congela (interruptores `crons` y `llm`), no improvises SQL; restaura a una base nueva y compara | `RESPALDO-Y-RESTAURACION.md` (restauración y verificación) |
| Se perdió o corrompió la base de Supabase | Provisiona un proyecto nuevo, restaura el último respaldo, repunta `DATABASE_URL` | `RESPALDO-Y-RESTAURACION.md` secciones de restauración y repunte |
| Se perdió una llave de cifrado (`HOTELES_IDENTITY_KEY`, `SUPERADMIN_MFA_ENCRYPTION_KEY`) | Recupera la copia del gestor de secretos; sin copia los datos cifrados son irrecuperables | `ROTACION-DE-LLAVES.md` |
| Secreto expuesto | Rotar | `ROTACION-DE-LLAVES.md` |
| Vercel o un proveedor caído | Espera/avisa; no hagas rollback si el fallo no empezó con un despliegue | `INCIDENTES.md` sección 4 |

## Orden de una recuperación completa de base

1. Declara SEV1 y congela: interruptores globales `crons` y `llm`; pausa los merges a `main`.
2. Identifica el último respaldo bueno y su huella (`RESPALDO-Y-RESTAURACION.md`); registra su `created_at` = el RPO real del incidente.
3. Restaura **a una base nueva**, nunca encima de la dañada; verifica la huella y los conteos.
4. Aplica las migraciones que falten **solo si Javier lo autoriza** (la base real suele ir detrás del código; el código debe tolerarlo).
5. Repunta `DATABASE_URL` en Vercel, redespliega, rota los secretos que pasaron por el entorno comprometido y corre `npm run smoke:post-deploy -- https://<dominio>`.
6. Reanuda interruptores de uno en uno (primero `crons`, luego `llm`) y vigila `/superadmin/salud/crons`.
7. Postmortem (`INCIDENTES.md` sección 6) con el RPO/RTO reales medidos.

## Qué NO está cubierto (ver sección 1 de `RESPALDO-Y-RESTAURACION.md`)

Variables de entorno de Vercel, DNS, archivos de Storage, roles y contraseñas de Postgres, y recuperación a un instante exacto (PITR):
mantén un inventario de variables (`docs/CREDENCIALES.md`) y confirma en el panel de Supabase qué respaldos y PITR incluye el plan.

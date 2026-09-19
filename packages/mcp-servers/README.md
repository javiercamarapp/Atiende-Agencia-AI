# `packages/mcp-servers/`

Servidores MCP del monorepo. Hoy solo hay uno con código real:

- **`cfdi/`** — timbrado/cancelación de CFDI de hospedaje (dual-PAC Finkok/SW
  Sapien). Ver `cfdi/README.md`.

## Qué se retiró (19-sep-2026)

Hasta esta limpieza, esta carpeta también tenía 9 subcarpetas reservadas —
`billing/`, `channel-manager/`, `energy/`, `expediente/`, `locks/`, `pms/`,
`pos/`, `scheduling/`, `shared/` — cada una con un solo `README.md` que decía
"aún no portado/construido". Ninguna tenía `package.json` ni código: `npm`
nunca las registró como workspace real (no aparecían en `package-lock.json`),
y ningún flujo del producto las importaba (`@atiende/mcp-*` solo resuelve a
`mcp-cfdi` en todo el repo). Se retiraron porque su sola presencia en el árbol
sugería, a quien navegara GitHub, que existían 10 servidores MCP cuando solo 1
tiene código.

El diseño original de esas 9 (a qué vertical pertenecía cada una y de qué
repo origen se portaría) sigue documentado en `docs/REQUISITOS.md` §0 —
snapshot histórico congelado a propósito, no se reescribió con esta limpieza.
Si una vertical necesita alguna de vuelta, se reconstruye con código real y
pruebas cuando haya trabajo que la requiera, no como carpeta vacía de
adelanto: `packages/db/tests/workspace-source-guard.spec.ts` falla la suite
si un paquete de workspace (uno con `package.json`) vuelve a quedar sin
ningún archivo de código fuente.

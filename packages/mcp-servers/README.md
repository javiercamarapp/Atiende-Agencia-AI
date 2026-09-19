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
repo origen se portaría) **no** quedó documentado en otra parte del árbol —
`docs/REQUISITOS.md` §0 solo dice, en su línea 40, "Ningún servidor MCP
(`packages/mcp-servers/*`)"; no menciona ninguno de los 9 nombres. Ese
mapeo vivía únicamente en el `README.md` de cada carpeta y se pierde del
árbol con este retiro — queda recuperable solo por historial de git
(`git show b7366c5^:packages/mcp-servers/<carpeta>/README.md`, el commit
justo antes de este retiro). Para no perderlo del todo, queda aquí:

| Carpeta retirada | Vertical | Repo/origen a portar (según su README) |
|---|---|---|
| `billing/` | hoteles | `hoteles/packages/mcp-servers/billing` (distinto de `packages/billing` de plataforma) |
| `channel-manager/` | rentas | `rentas/packages/adapters` |
| `energy/` | hoteles | `hoteles/packages/mcp-servers/energy` |
| `expediente/` | licitaciones | `licitaciones/packages/expediente` |
| `locks/` | hoteles | `hoteles/packages/mcp-servers/locks` |
| `pms/` | hoteles | `hoteles/packages/mcp-servers/pms` |
| `pos/` | restaurantes | nuevo, generalizado de sus edge functions de POS (sin repo origen) |
| `scheduling/` | citas | nuevo (sin repo origen) |
| `shared/` | cross-vertical (whatsapp, outbound, payments, email) | `hoteles/packages/mcp-servers/shared` |

Si una vertical necesita alguna de vuelta, se reconstruye con código real y
pruebas cuando haya trabajo que la requiera, no como carpeta vacía de
adelanto: `packages/db/tests/workspace-source-guard.spec.ts` falla la suite
si un directorio bajo un patrón de workspace (`apps/*`, `packages/*`,
`packages/mcp-servers/*`) vuelve a quedar sin `package.json` propio y sin
ningún archivo de código fuente — el patrón exacto de estas 9 carpetas.

# SCADA SEGRA — Módulo de Energía

Sistema de monitoreo de planta (SCADA propio de Grupo SEGRA). Este primer módulo
adquiere datos del medidor de energía **WEG PFW03-M12** por Modbus, los almacena en
**SQLite** y los presenta en un **panel web** con la identidad del ERP SEGRA.

Diseñado para crecer: los próximos módulos (PLC, otros sensores) se integran como
nuevas fuentes en la misma base y nuevas secciones del panel.

---

## Arquitectura

```
  WEG PFW03-M12 ──(Modbus RTU)──► Conversor EBYTE NB114 ──(Modbus TCP)──►  logger.js
   (medidor)         RS-485          192.168.0.168:8887                       │
                                                                              ▼
                                                                     pfw03.db (SQLite)
                                                                              │
                                                          server.js (HTTP + API) ◄── lee
                                                                              │
                                                                       navegador
                                                                    (dashboard.html)
```

- **logger.js** — muestrea el medidor cada 1 s y guarda en la base. Incluye la
  **retención automática** (compresión de datos antiguos).
- **server.js** — servidor web sin dependencias: sirve el panel y expone la API
  (lee la base en solo-lectura).
- **dashboard.html** — panel SCADA (monitoreo, acumulados, reportes, configuración).

Están **desacoplados por la base de datos**: el logger puede correr solo, y el panel
lee lo que haya (incluido el histórico).

---

## Requisitos

- **Node.js ≥ 22** (usa el módulo integrado `node:sqlite`; **sin dependencias externas**,
  no requiere `npm install`).
- En Node 22/23 el flag `--experimental-sqlite` es obligatorio (ya incluido en los
  scripts de `package.json`). En Node ≥ 24 funciona igual.
- Red con acceso al conversor Modbus TCP (por defecto `192.168.0.168:8887`).

---

## Puesta en marcha

En dos terminales (o como servicios):

```bash
npm run logger      # 1) captura continua  → pfw03.db
npm run server      # 2) sirve el panel en http://localhost:8080
```

Luego abrir **http://localhost:8080** (o `http://<ip-del-servidor>:8080` desde la intranet).

Equivalente sin npm:

```bash
node --experimental-sqlite logger.js --unit 2 --interval 1000
node --experimental-sqlite server.js --http-port 8080
```

---

## Configuración

### Dispositivo / conversor (parámetros)
Se pasan por argumentos al **logger** (valores por defecto entre paréntesis):

| Argumento | Descripción | Def. |
|---|---|---|
| `--host` | IP del conversor Modbus TCP | `192.168.0.168` |
| `--port` | Puerto del gateway | `8887` |
| `--unit` | Unit ID / dirección esclavo RTU | `2` |
| `--interval` | Periodo de muestreo (ms) | `1000` |
| `--db` | Ruta de la base SQLite | `pfw03.db` |
| `--keep-days` | Días a resolución completa (1 s) | `10` |
| `--rollup-sec` | Resolución del histórico comprimido (s) | `30` |

**Parámetros serie del conversor** (fijados en el equipo EBYTE, ver `docs/ALL_para.json`):
`38400 8N1`, modo Modbus "Simple", TCP Server. El WEG PFW03 debe coincidir
(38400 8N1, esclavo 2). Registros: **Holding (fn 03)**, **float32 big-endian**.

### Servidor
| Argumento | Descripción | Def. |
|---|---|---|
| `--http-port` | Puerto del panel web | `8080` |
| `--db` | Ruta de la base SQLite | `pfw03.db` |

### Valor de energía
El **valor por kWh** (para calcular el costo de las mediciones) se edita desde la
pantalla **Configuración** del panel y se guarda en `config.json` (compartido por
todas las pantallas). Por defecto `$150` CLP/kWh.

---

## Estructura del proyecto

```
Segra/
├── dashboard.html      Panel SCADA (UI, gráficas, mediciones)
├── server.js           Servidor web + API (lee la base)
├── logger.js           Adquisición Modbus + retención de datos
├── config.json         Ajustes (valor $/kWh)
├── fabrica-db.js       Cliente MySQL/MariaDB puro-JS (fuente de producción, solo lectura)
├── db.config.json      Credenciales de la BD MariaDB (no versionado)
├── energia.db          Energía consolidada por lote (generada; no versionada)
├── package.json        Scripts y metadatos
├── pfw03.db            Base de datos SQLite (generada; no versionada)
├── tools/              Utilidades de diagnóstico / puesta a punto
│   ├── pfw03.js            Lector interactivo del PFW03 (consola)
│   ├── modbus-read.js      Cliente Modbus genérico (TCP / RTU-over-TCP)
│   ├── modbus-scan.js      Escáner de Unit IDs
│   ├── modbus-regscan.js   Escáner de registros válidos
│   └── ebyte-*.js          Acceso a la web de config del conversor EBYTE
└── docs/
    ├── ALL_para.json       Configuración completa del conversor (referencia)
    └── capturas/           Capturas de pantalla del panel
```

---

## Funcionalidades del panel

- **Menú:** Reportes · Energía (tiempo real) · Proceso (futuro PLC) · Configuración.
- **Tiempo real:** gráficas de Corriente, Potencia activa y Factor de potencia
  (con tooltip y resumen **Mín/Prom/Máx** del rango 5 m / 30 m / 1 h / 6 h) y tiles
  con semáforos de estado (tensión, frecuencia, THD, etc.).
- **Estado del medidor:** Activo/Inactivo según haya lecturas exitosas recientes.
- **Acumulados de energía** (kWh + valor $):
  - **Por turno** (continuo, 22:00 → 22:00, se reinicia solo cada día).
  - **Mensual** (día 1 → fin de mes, se reinicia solo).
  - **Manual** (con botón iniciar/detener, mide el periodo que se quiera).
- **Reportes:** consulta por fecha/hora con gráficas del periodo, resumen
  (energía, valor, potencia media/máx, corriente máx) y **exportación a CSV**.

---

## Modelo de datos y retención

Tabla `readings`, 1 fila por muestra. Columnas clave:
- `ts_unix_ms` (tiempo), `ok` (1 = lectura válida), `p`,`v`,`i`,`fp`… (variables),
  `res` (resolución en s), `secs` (segundos que representa la fila).

**Energía** = `Σ(P · secs)` → exacta, escalable en SQL y **a prueba de huecos**
(los periodos sin datos no se cuentan).

**Retención automática** (en el logger, diaria):
- **0–10 días:** 1 dato/segundo (máximo detalle).
- **> 10 días:** se promedia a **1 dato/30 s** y se borra el detalle de 1 s
  (la energía se conserva). Compresión ~30×.

Estimado de espacio: crudo acotado a ~1,3 GB (10 días) + ~155 MB/año de histórico
comprimido.

---

## API (HTTP)

| Endpoint | Descripción |
|---|---|
| `GET /` | Panel (dashboard.html) |
| `GET /api/latest` | Última lectura válida + `stale` |
| `GET /api/history?minutes=N` · `?from=&to=` | Serie temporal (i, p, fp) |
| `GET /api/energy?from=&to=` | Energía integrada del periodo (kWh, avgKw) |
| `GET /api/export?from=&to=` | CSV del periodo (todas las columnas) |
| `GET /api/config` · `POST` | Ajustes (valor $/kWh) |
| `GET /api/health` | Estado de la base |
| `GET /api/fabrica/ping` | Prueba de la fuente MariaDB de producción (estado + última muestra) |
| `GET /api/producciones?limit=N` | Producción en curso + últimas N (lote, inicio/fin, batches y **energía kWh**) |

---

## Fuente de datos MariaDB (producción)

Además del medidor Modbus, el panel puede leer la **base de producción MariaDB**
(`segra` / `segra_fabrica`) del servidor de planta. Se usa un **cliente MySQL escrito
en JavaScript puro** (`fabrica-db.js`): sin dependencias ni `npm install`, coherente
con el resto del proyecto (solo `net` + `node:crypto`, auth `mysql_native_password`).

- **Solo lectura**: la conexión usa un usuario con permiso `SELECT` únicamente.
- **Credenciales** en `db.config.json` (no versionado) o por variables de entorno
  `FABRICA_DB_HOST/PORT/USER/PASS`:

  ```json
  { "host": "192.168.0.12", "port": 3306, "user": "scada", "password": "…", "database": "" }
  ```

- **Prueba rápida** (CLI):

  ```bash
  node fabrica-db.js                       # autotest: conecta y muestra última muestra
  node fabrica-db.js --sql "SELECT NOW()"  # consulta ad-hoc
  ```

- **Prueba por API**: `GET /api/fabrica/ping` → `{ ok, ms, server, ultimaMuestra }`.

> La tabla viva es `segra_fabrica.data_pelleteras` (pelleteras CPM/KAHL: temperatura,
> amperaje, frecuencia de alimentador, vapor). Base para la futura sección **Proceso**.

---

## Herramientas de diagnóstico (`tools/`)

```bash
node tools/pfw03.js --unit 2 --interval 1000   # lectura por consola del PFW03
node tools/modbus-read.js --mode tcp --fn 3 --addr 0 --count 10 --unit 2
node tools/modbus-scan.js --from 1 --to 247     # descubrir esclavos
node tools/modbus-regscan.js --fn 3 --from 0 --to 300
```

---

## Despliegue a un servidor externo

Ver **[docs/DEPLOY.md](docs/DEPLOY.md)**.

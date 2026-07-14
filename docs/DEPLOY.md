# Despliegue a un servidor externo

El módulo es **Node puro, sin dependencias** (usa `node:sqlite`), así que desplegar
es básicamente **copiar los archivos** y arrancar dos procesos. No hay `npm install`
ni `node_modules`.

Archivos a llevar al servidor (el resto se genera solo):

```
dashboard.html  server.js  logger.js  config.json  package.json  README.md  logo.jpeg  tools/  docs/
```

> **Importante:** `logo.jpeg` es el logo de la cabecera del panel. Si no se copia, el
> logo saldrá roto en el servidor.

**No copiar:** `pfw03.db*` (se crea en el servidor) ni `*.out`/`*.log`. Ya están en
`.gitignore` y excluidos del paquete.

---

## Opción A — Git (recomendada, permite actualizar fácil)

En este equipo de desarrollo el repo ya está inicializado. Para enviarlo:

```bash
# 1) Enlazar un remoto (GitHub / GitLab / Bitbucket / Git propio del servidor)
git remote add origin <URL-del-remoto>
git push -u origin main
```

En el **servidor**:

```bash
git clone <URL-del-remoto> scada-segra && cd scada-segra
node --experimental-sqlite logger.js &
node --experimental-sqlite server.js &
```

Para actualizar luego: `git pull` en el servidor y reiniciar los procesos.

---

## Opción B — Copia directa (sin Git)

**Empaquetar** (PowerShell, en este equipo):

```powershell
$src = "c:\Programas Claude\Segra"
Compress-Archive -Path "$src\dashboard.html","$src\server.js","$src\logger.js",
  "$src\config.json","$src\package.json","$src\README.md","$src\logo.jpeg","$src\tools","$src\docs" `
  -DestinationPath "$src\scada-segra.zip" -Force
```

**Enviar** (elige uno):
- `scp scada-segra.zip usuario@servidor:/opt/` (Linux/SSH)
- Copiar el `.zip` por red / USB (Windows)

**En el servidor:** descomprimir y arrancar los dos procesos (ver abajo).

---

## Ejecutar como servicio (para producción 24/7)

### Linux — systemd
Crear `/etc/systemd/system/scada-logger.service`:

```ini
[Unit]
Description=SCADA SEGRA - Logger de energia
After=network.target

[Service]
WorkingDirectory=/opt/scada-segra
ExecStart=/usr/bin/node --experimental-sqlite logger.js
Restart=always
RestartSec=5
User=scada

[Install]
WantedBy=multi-user.target
```

Y otro `scada-server.service` igual pero con `ExecStart=... server.js`. Luego:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scada-logger scada-server
```

### Multiplataforma — pm2

```bash
npm i -g pm2
pm2 start "node --experimental-sqlite logger.js" --name scada-logger
pm2 start "node --experimental-sqlite server.js" --name scada-server
pm2 save && pm2 startup     # arranque automático al reiniciar
```

### Windows — servicio
Usar **NSSM** (`nssm install scada-logger "C:\Program Files\nodejs\node.exe" "--experimental-sqlite logger.js"`)
o el **Programador de tareas** (al iniciar el sistema).

---

## Checklist post-despliegue

- [ ] Node ≥ 22 instalado en el servidor (`node -v`).
- [ ] Ajustar la IP/puerto del conversor si cambia: `logger.js --host <ip> --port <p>`.
- [ ] Abrir el puerto del panel (`8080`) en el firewall si se accede desde la red.
- [ ] Verificar acceso al conversor Modbus desde el servidor (`Test-NetConnection <ip> -Port 8887`).
- [ ] Confirmar el valor $/kWh en la pantalla **Configuración**.
- [ ] (Opcional) Servir el panel por HTTPS detrás de un reverse proxy (nginx/IIS).

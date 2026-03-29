# ElatoAI - Claude Code Configuration

## Firmware

The project has two firmware versions:
- `firmware-idf/` - **Primary** (ESP-IDF 5.5.2, with wake word support)
- `firmware-arduino/` - Legacy (PlatformIO/Arduino)

### Default Flash Command (ESP-IDF)

When asked to flash/upload firmware, use:

```bash
cd firmware-idf && source ~/esp/esp-idf/export.sh && idf.py flash monitor
```

First-time setup requires `./build_elato.sh` to configure board (select `bread-compact-wifi` + `SSD1306 128*32`).

### Arduino Version (Legacy)

Only use if explicitly requested:

```bash
cd firmware-arduino && pio run -t upload
```

## Servers

- **Deno server**: `cd server-deno && deno run -A --env-file=.env main.ts`
- **Next.js frontend**: `cd frontend-nextjs && npm run dev`

## Language

Prefer Chinese (中文) for communication.

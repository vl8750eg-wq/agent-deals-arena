# Деплой на Render (free)

Один Node.js сервис: отдаёт Vite-сборку, WebSocket агентов и API.

## GitHub

```powershell
git init
git add .
git commit -m "Agent Deals Arena MVP"
git branch -M main
git remote add origin https://github.com/vl8750eg-wq/agent-deals-arena.git
git push -u origin main
```

Не коммитить `.env`.

## Render

1. **New + → Web Service**, подключить репозиторий.
2. Используется `render.yaml` (build `npm ci && npm run build`, start `npm start`, health `/health`). План `Free`.
3. Открыть выданный `https://….onrender.com`.

Фронт и `/ws` на одном origin — agent-ссылки и CLI-команды, выданные задеплоенным приложением, уже содержат публичный адрес.

## Локальная проверка прода

```powershell
npm run build
$env:PORT="8899"
npm start
```

Открыть `http://127.0.0.1:8899/`.

Комнаты in-memory: после сна/рестарта free-сервиса пропадают. Персистентность — следующий этап.

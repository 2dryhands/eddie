# HTML Preview — стандарт

Любая фича, генерирующая данные/отчёт, выдаёт HTML-превью. Это **не опционально** — Гоша не разраб, JSON/CSV глазами не читает.

## Обязательные элементы

### 1. Авто-open сразу после билда

```python
import subprocess, os
html_path = "data/<feature>/output/<run>/preview.html"
subprocess.run(["open", os.path.abspath(html_path)])
```

Не ждать, пока пользователь откроет сам.

### 2. Плашка «Что проверять в этом обновлении» — сверху, под заголовком

3-10 пунктов с тегами:

- 🆕 **НОВОЕ** — что появилось
- 🔧 **ИСПРАВЛЕНО** — что починили по прошлому фидбеку
- 👀 **ПРОВЕРИТЬ** — что глазами сейчас
- ℹ︎ **ИЗВЕСТНО** — ограничения / в TODO

Обновляется каждый билд. Старые пункты — в «ИЗВЕСТНО» или удалить, если неактуально.

### 3. Таймштамп в шапке + в `<title>`

`<title>Eddie — обновлено 14:32:01</title>` — чтобы Гоша видел, что вкладка живая.

### 4. Auto-refresh — запрещён (безусловно)

`<meta http-equiv="refresh">` **не ставить нигде и никогда** (глобальное решение 2026-07-07): сбрасывает state (галки, фильтры, скролл, тултипы) и мешает читать. Свежесть видна по таймштампу. Нужен ручной апдейт — кнопка «↻ Обновить» наверху.

## Минимальный шаблон

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Eddie — обновлено {{TIME}}</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; }
    .check-block { background: #fff8d9; border-left: 4px solid #d4a017; padding: 12px 16px; margin: 16px 0; }
    .check-block h3 { margin: 0 0 8px; }
    .check-block ul { margin: 0; padding-left: 20px; }
    .ts { color: #777; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Eddie — preview</h1>
  <div class="ts">обновлено {{TIME}}</div>

  <div class="check-block">
    <h3>Что проверять в этом обновлении</h3>
    <ul>
      <li>🆕 <b>НОВОЕ:</b> добавлена колонка X</li>
      <li>🔧 <b>ИСПРАВЛЕНО:</b> Y больше не дублируется</li>
      <li>👀 <b>ПРОВЕРИТЬ:</b> цифра Z в строке N — правдоподобна?</li>
      <li>ℹ︎ <b>ИЗВЕСТНО:</b> поле W пустое для записей без даты</li>
    </ul>
  </div>

  <!-- основной контент -->
</body>
</html>
```

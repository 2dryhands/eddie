# Superpowers — агентный поток

Эта папка — для глубокой работы с AI-агентами по Anthropic Superpowers Skills. Поток:

```
brainstorming → writing-plan → executing-plan → verifying → finishing
```

## Когда использовать

- Крупные фичи (≥3 шага, ≥3 файла, ≥1 рабочего дня)
- Архитектурные изменения
- Любая работа, где AI «не понимает что делать» — это сигнал, что не было brainstorming/spec.

## Когда НЕ использовать

- Мелкие фиксы и one-liners — для них хватит обычной спеки в `docs/specs/`.
- Одноразовые скрипты на полдня.

## Структура

```
superpowers/
  specs/        — design-спеки от brainstorming-стадии (что хотим спроектировать)
  plans/        — implementation plans от writing-plan-стадии (как пошагово реализуем)
  reports/      — отчёты после execution (опционально)
```

Шаблоны:
- [`specs/_template.md`](specs/_template.md)
- [`plans/_template.md`](plans/_template.md)

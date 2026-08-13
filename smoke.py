#!/usr/bin/env python3
"""
smoke.py — интеграционные прогоны «фича работает целиком» для проекта Eddie.

Это НЕ unit-тесты (не проверяем каждую функцию). Это набор дешёвых прогонов
«запустилось и выдало ожидаемое». Растёт по мере проекта: на каждую новую фичу
и каждый починенный баг — добавляй один check_*(). Так копится регрессионная сетка
без TDD-фундаментализма.

Правило (Golden Rule #8): AI обязан вставлять вывод этого файла в финальный отчёт.
Запуск:  python smoke.py
Выход:   код 0 если всё PASS, 1 если есть FAIL (удобно для CI / make check).
"""

import subprocess
import sys
import traceback
from pathlib import Path

# Каждый check — функция без аргументов. Падает (raise / assert) = FAIL.
# Возвращать ничего не нужно; дошли до конца без исключения = PASS.

CHECKS = []
# Заглушки-примеры помечаем, чтобы «голый» smoke не рапортовал фальшивый PASS.
STUB_NAMES = set()


def check(fn):
    """Декоратор — регистрирует функцию как smoke-прогон."""
    CHECKS.append(fn)
    return fn


def stub(fn):
    """Как @check, но помечает прогон заглушкой-примером (не считается настоящим)."""
    STUB_NAMES.add(fn.__name__)
    CHECKS.append(fn)
    return fn


# ─────────────────────────────────────────────────────────────────────────────
# ДЕФОЛТНЫЙ ЧЕК — работает в любом проекте из стартера, менять не обязательно.
# ─────────────────────────────────────────────────────────────────────────────

@check
def no_unfilled_placeholders():
    """В ключевых файлах не осталось битых плейсхолдеров стартера ({{...}})."""
    root = Path(__file__).parent
    bad = []
    for name in ("CLAUDE.md", "README.md", "docs/INDEX.md"):
        p = root / name
        if p.exists() and "{{" in p.read_text(encoding="utf-8", errors="ignore"):
            bad.append(name)
    assert not bad, f"незаполненные плейсхолдеры в: {', '.join(bad)}"


@check
def npm_test_suite_green():
    """Реальная регрессионная сетка проекта (tests/run-all.js) — юнит + e2e."""
    root = Path(__file__).parent
    result = subprocess.run(
        ["npm", "test"], cwd=root, capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, (
        f"npm test упал (код {result.returncode}):\n{result.stdout[-2000:]}\n{result.stderr[-2000:]}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# ПРИМЕРЫ (@stub). Замени на реальные прогоны — тогда сними пометку stub → check.
# ─────────────────────────────────────────────────────────────────────────────

@stub
def smoke_imports():
    """ЗАГЛУШКА: раскомментируй импорт и переключи @stub → @check."""
    # import scripts.main  # noqa
    pass


# Шаблоны под типовые проекты Гоши — раскомментируй нужное:
#
# @check
# def parser_returns_rows():
#     """Парсер на фикстуре выдаёт >= ожидаемого числа строк."""
#     rows = run_parser("tests/fixtures/sample.html")
#     assert len(rows) >= 10, f"ждал >=10 строк, получил {len(rows)}"
#
# @check
# def bot_replies_to_start():
#     """Бот на /start отвечает непустым текстом, а не падает."""
#     reply = handle_command("/start")
#     assert reply and "error" not in reply.lower(), f"плохой ответ: {reply!r}"
#
# @check
# def dashboard_html_builds():
#     """Дашборд собирается в HTML и содержит ключевой маркер."""
#     html = build_dashboard(sample_data())
#     assert "<table" in html, "в HTML нет таблицы — сборка сломана"


# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    real = [fn for fn in CHECKS if fn.__name__ not in STUB_NAMES]
    stubs = [fn for fn in CHECKS if fn.__name__ in STUB_NAMES]
    passed = failed = 0
    print(f"smoke: {len(real)} реальн. прогон(ов), {len(stubs)} заглушек\n")
    for fn in real:
        name = fn.__name__
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception as e:  # noqa: BLE001 — smoke ловит всё намеренно
            print(f"  FAIL  {name}: {e}")
            traceback.print_exc()
            failed += 1
    total = passed + failed

    # Голый стартер: реальных прогонов нет — это НЕ повод для зелёной галки.
    if total == 0:
        print("\nWARN: 0 реальных прогонов — это заглушка. Добавь свой @check "
              "(на первую же фичу), иначе smoke ничего не гарантирует.")
        return 1

    print(f"\n{'PASS' if failed == 0 else 'FAIL'}: {passed}/{total}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

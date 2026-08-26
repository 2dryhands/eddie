#!/usr/bin/env python3
"""verify.py — единый гейт проекта: одна команда, один ответ «да/нет».

    python3 verify.py            # quick: гигиена + компиляция + selftest'ы ИЗМЕНЁННЫХ скриптов + smoke.py
    python3 verify.py --staged   # то же, но только по индексу git — режим pre-commit хука
    python3 verify.py --full     # всё: все selftest'ы, pytest/unittest, npm test, smoke.py
    python3 verify.py --list     # что будет запущено, без запуска
    python3 verify.py --selftest # самопроверка самого гейта на временных репо

Выход: последняя строка `VERIFY PASS · …` (код 0) или `VERIFY FAIL · …` (код 1).
Эту строку агент вставляет в отчёт как доказательство (Golden Rule #8, evidence-before-done).
Pre-commit хук гоняет quick; перед «готово» и перед пушем — --full.

Что проверяет (автодетект, без конфига):
  H  гигиена: мусор в корне (png/jpg/bak/log/--*), незаполненные {{плейсхолдеры}}
  C  компиляция .py (изменённых в quick, всех в --full)
  S  скрипты с режимом --selftest → запуск каждого (таймаут VERIFY_TIMEOUT, по умолчанию 180 с)
  T  тесты: pytest (если стоит) или unittest по папкам tests/          [--full]
  N  npm/bun test, если в package.json есть scripts.test               [--full]
  M  smoke.py в корне
Делегирование: есть scripts/check.sh → --full гоняет его вместо S/T/N;
               есть scripts/quick-test.sh → quick гоняет его вместо S.
Опт-аут для скрипта, чей selftest требует сети/ключей: строка `# verify: skip` в файле.
Тяжёлый selftest (полный экспорт и т.п.): `# verify: timeout=900` в файле — свой потолок.
Python: берётся .venv/bin/python, если есть, иначе тот, которым запущен verify.py;
компиляция и selftest'ы идут им же (не тем, чем запущен verify.py).
Исключённые папки: .git .venv venv node_modules data shared _archive .worktrees __pycache__

Канонический экземпляр — sdlc-starter-kit/_template/verify.py; в проекты раскатывается
sync-verify.sh. Правки — там, не в копиях.
"""

from __future__ import annotations

import json
import os

import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

EXCLUDE_DIRS = {".git", ".venv", "venv", "node_modules", "data", "shared", "_archive",
                ".worktrees", "__pycache__", ".playwright-mcp", "Next-Move-Theory-Canon"}
JUNK_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bak", ".tmp", ".log"}
PLACEHOLDER_FILES = ("CLAUDE.md", "README.md", "AGENTS.md", "docs/INDEX.md")
TIMEOUT = int(os.environ.get("VERIFY_TIMEOUT", "180"))


# ───────────────────────── обнаружение ─────────────────────────

def python_exe(root: Path) -> str:
    venv = root / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def walk_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS
                             and not (Path(dirpath) / d).is_symlink())
        for f in sorted(filenames):
            yield Path(dirpath) / f


def git(root: Path, *args: str) -> str | None:
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def changed_files(root: Path, staged: bool = False) -> set[str] | None:
    """Относительные пути изменённых файлов (рабочее дерево + индекс + untracked). None — не git.
    staged=True — только то, что в индексе (режим pre-commit: чужие незакоммиченные правки
    в том же репо не должны ронять твой коммит)."""
    if git(root, "rev-parse", "--is-inside-work-tree") is None:
        return None
    out = set()
    sources = ((("diff", "--name-only", "--cached"),) if staged else
               (("diff", "--name-only", "HEAD"), ("diff", "--name-only", "--cached"),
                ("ls-files", "--others", "--exclude-standard")))
    for args in sources:
        txt = git(root, *args)
        if txt:
            out.update(l.strip() for l in txt.splitlines() if l.strip())
    return out


SELFTEST_FLAG = re.compile(r"""["']--selftest["']""")       # флаг как токен в коде, не упоминание в тексте
TIMEOUT_MARK = re.compile(r"#\s*verify:\s*timeout=(\d+)")


def has_selftest(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(SELFTEST_FLAG.search(text)) and "# verify: skip" not in text


def file_timeout(path: Path) -> int:
    """`# verify: timeout=900` в файле — свой потолок для тяжёлого selftest'а."""
    try:
        m = TIMEOUT_MARK.search(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        m = None
    return int(m.group(1)) if m else TIMEOUT


def selftest_cmd(root: Path, path: Path, py: str) -> list[str]:
    rel = path.relative_to(root)
    parts = list(rel.with_suffix("").parts)
    if len(parts) > 1 and all(p.isidentifier() for p in parts):
        return [py, "-m", ".".join(parts), "--selftest"]
    return [py, str(rel), "--selftest"]


def test_dirs(root: Path) -> list[Path]:
    return sorted({p.parent for p in walk_files(root)
                   if p.name.startswith("test_") and p.suffix == ".py" and p.parent.name == "tests"})


def module_available(py: str, mod: str) -> bool:
    try:
        return subprocess.run([py, "-c", f"import {mod}"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# ───────────────────────── проверки ─────────────────────────

class Check:
    def __init__(self, code: str, name: str, cmd=None, fn=None, timeout: int | None = None):
        self.code, self.name, self.cmd, self.fn = code, name, cmd, fn
        self.timeout = timeout


def hygiene_checks(root: Path) -> list[Check]:
    def root_junk():
        junk = [p.name for p in sorted(root.iterdir()) if p.is_file() and
                (p.suffix.lower() in JUNK_EXT or p.name.startswith("--") or ".bak." in p.name)]
        assert not junk, ("в корне мусор (перенеси в data/ или docs/, корень — не помойка): "
                          + ", ".join(junk[:8]) + ("…" if len(junk) > 8 else ""))

    def placeholders():
        bad = [n for n in PLACEHOLDER_FILES if (root / n).exists()
               and "{{PROJECT_" in (root / n).read_text(encoding="utf-8", errors="replace")]
        assert not bad, "незаполненные {{PROJECT_*}} плейсхолдеры в: " + ", ".join(bad)

    return [Check("H", "корень без мусора", fn=root_junk),
            Check("H", "плейсхолдеры стартера заполнены", fn=placeholders)]


def plan(root: Path, full: bool, staged: bool = False) -> list[Check]:
    py = python_exe(root)
    checks = hygiene_checks(root)
    changed = None if full else changed_files(root, staged=staged)
    py_files = [p for p in walk_files(root) if p.suffix == ".py"]
    if not full and changed is not None:
        py_files = [p for p in py_files if str(p.relative_to(root)) in changed]

    if py_files:
        def compile_all(files=py_files):
            # Компилируем интерпретатором ПРОЕКТА (.venv может быть 3.14, системный — 3.9:
            # f-string с бэкслэшем валиден в одном и SyntaxError в другом). Без байткода.
            src = ("import sys, ast\nbad = []\nfor f in sys.stdin.read().split('\\0'):\n"
                   "    if not f: continue\n"
                   "    try: ast.parse(open(f, 'rb').read(), f)\n"
                   "    except SyntaxError as e: bad.append(f'{f}:{e.lineno} {e.msg}')\n"
                   "    except OSError as e: bad.append(f'{f}: {e}')\n"
                   "print('\\n'.join(bad))\n")
            r = subprocess.run([py, "-c", src], input="\0".join(str(p) for p in files),
                               capture_output=True, text=True, timeout=TIMEOUT)
            assert r.returncode == 0, "компилятор упал: " + r.stderr.strip()[-300:]
            bad = [l.replace(str(root) + "/", "") for l in r.stdout.splitlines() if l.strip()]
            assert not bad, f"не компилируется {len(bad)}: " + "; ".join(bad[:3])
        checks.append(Check("C", f"компиляция {len(py_files)} .py", fn=compile_all))

    delegate = root / "scripts" / ("check.sh" if full else "quick-test.sh")
    if delegate.exists():
        checks.append(Check("D", f"делегирую scripts/{delegate.name}", cmd=["bash", str(delegate)]))
    else:
        for p in py_files:
            if has_selftest(p):
                checks.append(Check("S", f"{p.relative_to(root)} --selftest", cmd=selftest_cmd(root, p, py),
                                    timeout=file_timeout(p)))
        if full:
            dirs = test_dirs(root)
            if dirs:
                if module_available(py, "pytest"):
                    checks.append(Check("T", f"pytest ({len(dirs)} папок tests/)",
                                        cmd=[py, "-m", "pytest", "-q", *map(str, dirs)]))
                else:
                    for d in dirs:
                        checks.append(Check("T", f"unittest {d.relative_to(root)}",
                                            cmd=[py, "-m", "unittest", "discover", "-s", str(d)]))
            pkg = root / "package.json"
            if pkg.exists():
                try:
                    scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts") or {}
                except (OSError, ValueError):
                    scripts = {}
                if "test" in scripts:
                    runner = "bun" if (root / "bun.lock").exists() or (root / "bun.lockb").exists() else "npm"
                    checks.append(Check("N", f"{runner} test", cmd=[runner, "test"]))

    if (root / "smoke.py").exists():
        checks.append(Check("M", "smoke.py", cmd=[py, "smoke.py"]))
    return checks


def run_check(root: Path, c: Check) -> tuple[bool, float, str]:
    t0 = time.time()
    if c.fn:
        try:
            c.fn()
            return True, time.time() - t0, ""
        except Exception as e:  # noqa: BLE001 — любое падение = красный
            return False, time.time() - t0, str(e)
    env = {**os.environ, "VERIFY": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    limit = c.timeout or TIMEOUT
    try:
        r = subprocess.run(c.cmd, cwd=str(root), capture_output=True, text=True,
                           timeout=limit, env=env)
    except subprocess.TimeoutExpired:
        return False, time.time() - t0, (f"таймаут {limit} с — подними VERIFY_TIMEOUT, поставь в файле "
                                         "`# verify: timeout=N` или `# verify: skip`")
    except OSError as e:
        return False, time.time() - t0, str(e)
    out = (r.stdout + r.stderr).strip().splitlines()
    return r.returncode == 0, time.time() - t0, "\n".join(out[-6:])


def run(root: Path, full: bool, list_only: bool = False, quiet: bool = False,
        staged: bool = False) -> tuple[bool, list]:
    checks = plan(root, full, staged=staged)
    mode = "full" if full else ("staged" if staged else "quick")
    say = (lambda *a, **k: None) if quiet else print
    say(f"verify [{mode}] {root.name}: {len(checks)} проверок")
    if list_only:
        for c in checks:
            say(f"  {c.code}  {c.name}" + (f"  →  {' '.join(c.cmd)}" if c.cmd else ""))
        return True, []
    results = []
    t0 = time.time()
    for c in checks:
        ok, sec, tail = run_check(root, c)
        results.append((c, ok, sec, tail))
        say(f"  {'✅' if ok else '❌'} {c.code}  {c.name}  {sec:.1f}s")
        if not ok and tail:
            say("       " + tail.replace("\n", "\n       "))
    failed = [r for r in results if not r[1]]
    total = time.time() - t0
    if failed:
        say(f"\nVERIFY FAIL · {len(failed)} из {len(results)} красных · {total:.0f}s")
    else:
        say(f"\nVERIFY PASS · {len(results)} проверок · {total:.0f}s")
    return not failed, results


# ───────────────────────── самопроверка ─────────────────────────

def selftest() -> int:
    OK_SCRIPT = "import sys\nif '--selftest' in sys.argv:\n    print('ok'); sys.exit(0)\n"
    BAD_SCRIPT = "import sys\nif '--selftest' in sys.argv:\n    print('boom'); sys.exit(1)\n"
    SLOW_SCRIPT = "import sys, time\nif '--selftest' in sys.argv:\n    time.sleep(5)\n"

    def make_repo(files: dict[str, str], commit: bool = True) -> Path:
        root = Path(tempfile.mkdtemp(prefix="verify-selftest-"))
        for rel, text in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        if commit:
            subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=v", "-c", "user.email=v@x",
                            "commit", "-qm", "init"], check=True)
        return root

    cases = []

    def case(name, root, full, want_ok, want_codes=()):
        ok, results = run(root, full, quiet=True)
        got_fail = {c.code for c, r_ok, _, _ in results if not r_ok}
        ran = {c.name for c, *_ in results}
        problems = []
        if ok != want_ok:
            problems.append(f"ждал {'PASS' if want_ok else 'FAIL'}, получил {'PASS' if ok else 'FAIL'}")
        for code in want_codes:
            if code not in got_fail:
                problems.append(f"ждал красный {code}, красные: {got_fail or '—'}")
        cases.append((name, problems, ran))
        return ran

    # 1. чистое репо с зелёным selftest'ом
    case("1. чистое репо, selftest зелёный → PASS",
         make_repo({"scripts/ok.py": OK_SCRIPT}), True, True)
    # 2. красный selftest
    case("2. selftest красный → FAIL по S",
         make_repo({"scripts/bad.py": BAD_SCRIPT}), True, False, ("S",))
    # 3. мусор в корне
    case("3. png в корне → FAIL по H",
         make_repo({"scripts/ok.py": OK_SCRIPT, "shot.png": "x"}), True, False, ("H",))
    # 4. quick гоняет только изменённое: bad.py закоммичен и не тронут, ok.py правлен
    r4 = make_repo({"scripts/bad.py": BAD_SCRIPT, "scripts/ok.py": OK_SCRIPT})
    (r4 / "scripts" / "ok.py").write_text(OK_SCRIPT + "# touched\n", encoding="utf-8")
    ran4 = case("4. quick: только изменённый скрипт → PASS, bad.py не трогали", r4, False, True)
    if any("bad.py" in n for n in ran4):
        cases[-1][1].append("quick запустил неизменённый bad.py")
    # 5. опт-аут `# verify: skip`
    case("5. `# verify: skip` на красном → PASS",
         make_repo({"scripts/bad.py": "# verify: skip\n" + BAD_SCRIPT}), True, True)
    # 6. таймаут
    global TIMEOUT
    saved, TIMEOUT = TIMEOUT, 1
    case("6. selftest дольше VERIFY_TIMEOUT → FAIL по S",
         make_repo({"scripts/slow.py": SLOW_SCRIPT}), True, False, ("S",))
    TIMEOUT = saved
    # 7. синтаксическая ошибка
    case("7. битый .py → FAIL по C",
         make_repo({"scripts/broken.py": "def (:\n"}), True, False, ("C",))
    # 8. незаполненный плейсхолдер
    case("8. {{PROJECT_NAME}} в CLAUDE.md → FAIL по H",
         make_repo({"CLAUDE.md": "# {{PROJECT_NAME}}\n"}), True, False, ("H",))
    # 9. делегирование scripts/check.sh в --full
    ran9 = case("9. scripts/check.sh есть → --full делегирует ему",
                make_repo({"scripts/check.sh": "exit 0\n", "scripts/bad.py": BAD_SCRIPT}), True, True)
    if not any(n.startswith("делегирую") for n in ran9):
        cases[-1][1].append("делегирования не было")
    # 10. --staged (pre-commit): красный bad.py правлен, но не в индексе; в индексе только ok.py
    r10 = make_repo({"scripts/bad.py": OK_SCRIPT, "scripts/ok.py": OK_SCRIPT})
    (r10 / "scripts" / "bad.py").write_text(BAD_SCRIPT, encoding="utf-8")
    (r10 / "scripts" / "ok.py").write_text(OK_SCRIPT + "# staged\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(r10), "add", "scripts/ok.py"], check=True)
    ok10, res10 = run(r10, False, quiet=True, staged=True)
    ran10 = {c.name for c, *_ in res10}
    probs = []
    if not ok10:
        probs.append("ждал PASS, получил FAIL")
    if any("bad.py" in n for n in ran10):
        probs.append("--staged запустил незастейдженный bad.py")
    cases.append(("10. --staged: чужая красная правка вне индекса не роняет коммит", probs, ran10))
    # 11. упоминание «--selftest» в тексте/строке — не режим, скрипт не запускается
    ran11 = case("11. упоминание --selftest в строке без флага → не selftest-скрипт",
                 make_repo({"scripts/doc.py": 'ROWS = [("x", "🧪 other --selftest · golden")]\n'
                                              "import sys\nsys.exit(1)\n"}), True, True)
    if any("doc.py" in n for n in ran11):
        cases[-1][1].append("doc.py принят за selftest-скрипт")
    # 12. `# verify: timeout=N` в файле перебивает общий потолок
    saved, TIMEOUT = TIMEOUT, 1
    case("12. `# verify: timeout=20` держит медленный selftest при VERIFY_TIMEOUT=1 → PASS",
         make_repo({"scripts/slow.py": "# verify: timeout=20\n" +
                    "import sys, time\nif '--selftest' in sys.argv:\n    time.sleep(2)\n"}), True, True)
    TIMEOUT = saved

    print(f"Selftest verify.py ({len(cases)} сценариев):")
    failures = 0
    for name, problems, _ in cases:
        if problems:
            failures += 1
            print(f"  ❌ {name}: " + "; ".join(problems))
        else:
            print(f"  ✅ {name}")
    if failures:
        print(f"\n🔴 ПРОВАЛ: {failures} сценариев красные")
        return 1
    print(f"\n🟢 Все {len(cases)} сценариев зелёные.")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    root = Path(__file__).resolve().parent
    ok, _ = run(root, full="--full" in sys.argv, list_only="--list" in sys.argv,
                staged="--staged" in sys.argv)
    sys.exit(0 if ok else 1)

#!/usr/bin/env bash
# Собирает user-guide.md в .docx со всеми скриншотами.
#
#   ./docs/build-docx.sh [куда.docx]
#
# Зачем отдельный скрипт, а не один вызов pandoc: картинки в руководстве вставлены сырым
# HTML (<p align="center"><img …>), потому что markdown не умеет ни центрировать, ни ставить
# две в ряд. Сырой HTML pandoc в не-HTML вывод не переносит и молча выбрасывает — вышла бы
# дока без единого снимка. Поэтому блоки переписываются в markdown-картинки с явной шириной
# в сантиметрах под ширину полосы набора, а ряды из двух-трёх снимков остаются рядами.
#
# Файл .docx намеренно НЕ лежит в репозитории: одиннадцать мегабайт двоичного слепка, который
# устаревает с первой же правкой .md, плюс он поехал бы в публичное дерево мимо
# blue-strip-docs.py, унося туда обещания сквозного шифрования, которых в blue нет.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Desktop/Outcome-руководство-пользователя.docx}"
command -v pandoc >/dev/null || { echo "!! нужен pandoc: brew install pandoc" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$ROOT/docs/user-guide.md" "$TMP/guide.md" <<'PY'
import re, sys, pathlib

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = src.read_text()

PAGE_CM, GAP_CM = 16.0, 0.35          # полоса набора A4 при полях 2,5 см
IMG_RE = re.compile(r'<img\s+src="([^"]+)"\s+alt="([^"]*)"\s+width="(\d+)"\s*/?>')
BLOCK_RE = re.compile(r'<p align="center">(.*?)</p>', re.S)
count = 0

def block(m):
    global count
    imgs = IMG_RE.findall(m.group(1))
    if not imgs:
        return m.group(0)
    count += len(imgs)
    if len(imgs) == 1:
        s, alt, px = imgs[0]
        return f'![{alt}]({s}){{width={round(min(PAGE_CM, PAGE_CM * int(px) / 900), 2)}cm}}'
    each = round((PAGE_CM - GAP_CM * (len(imgs) - 1)) / len(imgs), 2)
    return ' '.join(f'![{alt}]({s}){{width={each}cm}}' for s, alt, _ in imgs)

text = BLOCK_RE.sub(block, text)

# Блоки со снимками идут в исходнике вплотную; в markdown это один абзац с мягкими
# переносами, и «две картинки + две + одна широкая» слипаются в кашу из пяти в строке.
out = []
for ln in text.split('\n'):
    if ln.startswith('!['):
        if out and out[-1].strip():
            out.append('')
        out += [ln, '']
    elif ln.strip() or (out and out[-1].strip()):
        out.append(ln)
text = '\n'.join(out)

text = re.sub(r'^- \[[^\]]+\]\(#[^)]+\)\n', '', text, flags=re.M)  # оглавление соберёт pandoc
text = re.sub(r'^---\n', '', text, flags=re.M)                     # линейки заменяют заголовки
text = re.sub(r'^# .*\n', '', text, count=1)                       # H1 уходит в метаданные

dst.write_text('---\ntitle: "Outcome — руководство пользователя"\n'
               'subtitle: "Веб-клиент и приложение для iOS"\n'
               'lang: ru-RU\ntoc-title: "Оглавление"\n---\n\n' + text.lstrip('\n'))
print(f"   картинок перенесено: {count}")
PY

# Эталонный документ нужен ровно ради размера листа: без явного sectPr его выбирает локаль
# Word, а ширина картинок посчитана под A4.
pandoc --print-default-data-file reference.docx > "$TMP/ref.docx"
( cd "$TMP" && mkdir ref && cd ref && unzip -q ../ref.docx \
  && python3 -c "
import pathlib
p = pathlib.Path('word/document.xml'); s = p.read_text()
p.write_text(s.replace('<w:sectPr>',
  '<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>'
  '<w:pgMar w:top=\"1417\" w:right=\"1417\" w:bottom=\"1417\" w:left=\"1417\" '
  'w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>', 1))" \
  && rm ../ref.docx && zip -q -r -X ../ref.docx . )

pandoc "$TMP/guide.md" -o "$OUT" \
  --from markdown-implicit_figures --toc --toc-depth=2 \
  --reference-doc="$TMP/ref.docx" --resource-path="$ROOT/docs" --metadata lang=ru-RU

echo "── готово: $OUT ($(du -h "$OUT" | cut -f1), картинок внутри: $(unzip -l "$OUT" | grep -c word/media/))"
echo "   Оглавление — поле Word: оно наполнится при открытии или по F9."

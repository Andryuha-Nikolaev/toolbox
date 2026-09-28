# toolbox

Локальный набор инструментов для работы с документами и изображениями.
Ставится один раз, дальше на него ссылаются правила и скиллы Claude Code.

Зачем: раньше пакеты ставились ad-hoc во временную папку на каждую задачу,
а бинари жили в pnpm-global по путям с хэшем — путь менялся при каждой
переустановке, и его приходилось искать заново. Здесь пути стабильны.

## Установка (уже сделана)

```powershell
cd C:\Dev\toolbox
pnpm install
```

`C:\Dev\toolbox\node_modules\.bin` добавлен в пользовательский PATH,
поэтому `sharp` доступен из любой папки.

## Что внутри

| Пакет                   | Зачем                            |
| ----------------------- | -------------------------------- |
| `xlsx` (SheetJS)        | чтение xlsx/xls/csv              |
| `exceljs`               | генерация xlsx                   |
| `mammoth`               | чтение docx                      |
| `turndown` + gfm-плагин | HTML → Markdown (таблицы держит) |
| `docx`                  | генерация docx                   |
| `pptxgenjs`             | генерация pptx (читать не умеет) |
| `fflate`                | распаковка pptx как ZIP          |
| `marked`                | парсинг Markdown                 |
| `sharp-cli`             | изображения — см. скилл `images` |
| `ag-psd`                | чтение PSD: слои, тексты, пиксели |

SheetJS взят с `cdn.sheetjs.com`, а не с npm: на npm застряла 0.18.5,
снятая с поддержки, с prototype-pollution и ReDoS. Обновлять оттуда же.

## Скрипты

Запускаются из любой папки — node резолвит зависимости от пути скрипта,
а не от cwd. Пути к файлам передавать абсолютные.

```powershell
node C:\Dev\toolbox\scripts\xlsx2json.mjs    <file.xlsx> [--list|--sheet N|--csv|--no-header|--formatted|--out F]
node C:\Dev\toolbox\scripts\docx2md.mjs      <file.docx> [--html|--media-dir DIR|--out F]
node C:\Dev\toolbox\scripts\pptx-extract.mjs <file.pptx> [--json|--media-dir DIR|--notes|--out F]
node C:\Dev\toolbox\scripts\md2docx.mjs      <file.md>   --out <file.docx> [--title T]
node C:\Dev\toolbox\scripts\psd-extract.mjs  <file.psd>  --out DIR [--png|--filter RE|--cutout RE|--hidden|--composite]
```

Каждый скрипт печатает подсказку при запуске без аргументов.
Результат идёт в stdout, диагностика — в stderr, так что вывод можно
перенаправлять в файл без мусора. Исключение — psd-extract: он пишет файлы
в `--out`.

Детали:

- **xlsx2json** — по умолчанию отдаёт типизированные значения (числа числами,
  даты ISO). `--formatted` даёт строки как их показывает Excel.
- **docx2md** — картинки по умолчанию выбрасываются, чтобы не раздувать вывод;
  `--media-dir` их извлекает и проставляет ссылки.
- **pptx-extract** — связь слайд↔картинка берётся из
  `ppt/slides/_rels/slideN.xml.rels`, по именам файлов в `ppt/media/`
  порядок слайдов НЕ угадывается.
- **md2docx** — базовый конвертер: заголовки, абзацы, жирный/курсив/код/ссылки,
  списки (настоящая нумерация Word), таблицы, цитаты, код-блоки, разделители.
  Нужно сложнее — писать разовый скрипт прямо на пакете `docx`.
- **psd-extract** — всегда пишет `tree.json` и `tree.txt`: дерево слоёв,
  bounds, видимость, blend mode, тексты и шрифты. PNG кодируется встроенным
  `node:zlib`, canvas не нужен; ресайз и WebP — дальше через `sharp`.
  - `--png` — сырые пиксели слоёв. Корректирующие слои (Curves, Selective
    Color…) к ним **не применяются**, цвета могут отличаться от макета.
  - `--cutout RE` — группа или слой целиком: цвет из итогового изображения
    PSD, альфа из слоёв. Цвета как в макете, но элементы, лежащие выше по
    слоям, запекаются внутрь, а по краям остаётся след фона.
  - Нужен PSD, сохранённый с «Maximize compatibility», иначе нет итогового
    изображения для `--composite` и `--cutout`.
  - В Git Bash регулярку не начинать с `/` — MSYS превратит её в путь.
  - Превью инструмента Read альфу не показывает; проверять через
    `sharp ... flatten "#2a6b4f"`.

## Генерация xlsx / pptx

Готовых скриптов нет намеренно: требования к формату каждый раз свои.
Писать разовый скрипт на `exceljs` / `pptxgenjs`, резолвя пакеты отсюда:

```js
import { createRequire } from 'node:module';
const require = createRequire('C:/Dev/toolbox/scripts/');
const ExcelJS = require('exceljs');
```

## Чего здесь нет

- **PDF** — генерация через HTML/CSS + Playwright, он подключён как MCP.
  Браузеры Playwright сюда не тянем: ~500 МБ.
- **ImageMagick** — не установлен. Что без него нельзя и как ставить —
  в скилле `images`.

## Оговорка про .prototools

Пин `node`/`pnpm` в этом репо действует только когда cwd находится внутри
`C:\Dev\toolbox` — то есть при `pnpm install` / `pnpm up`. При запуске
`node C:\Dev\toolbox\scripts\...` из папки другого проекта proto возьмёт
версию по cwd, из того проекта. Это страховка обслуживания репо, а не
гарантия среды исполнения.

## Обновление

```powershell
cd C:\Dev\toolbox
pnpm outdated
pnpm up
```

После обновления прогнать скрипты на тестовых файлах — API `docx` и
`pptxgenjs` ломались между мажорами.

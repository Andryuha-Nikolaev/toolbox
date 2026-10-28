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
uv sync
```

`C:\Dev\toolbox\node_modules\.bin` добавлен в пользовательский PATH,
поэтому `sharp` доступен из любой папки.

`uv` стоит через proto (`proto install uv --pin global`). Системного
Python нет: `uv sync` сам скачивает версию из `.python-version` и кладёт
окружение в `.venv`. В PATH Python не попадает — Python-скрипты идут
только через `uv run --project C:\Dev\toolbox`.

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
| `sharp`                 | API для разовых скриптов (composite, blend) |
| `ag-psd`                | чтение PSD: слои, тексты, пиксели |
| `subset-font`           | шрифты: сабсет и ttf/otf → woff2 |
| `fonttools` (Python)    | шрифты: правка глифов и таблиц   |
| `playwright`            | вёрстка в WebKit («как в Safari») и эмуляция мобилок |

SheetJS взят с `cdn.sheetjs.com`, а не с npm: на npm застряла 0.18.5,
снятая с поддержки, с prototype-pollution и ReDoS. Обновлять оттуда же.

Разовый скрипт вне тулбокса берёт пакеты отсюда так:

```js
import { createRequire } from "node:module";
const sharp = createRequire("C:/Dev/toolbox/")("sharp");
```

## Скрипты

Запускаются из любой папки — node резолвит зависимости от пути скрипта,
а не от cwd. Пути к файлам передавать абсолютные.

```powershell
node C:\Dev\toolbox\scripts\xlsx2json.mjs    <file.xlsx> [--list|--sheet N|--csv|--no-header|--formatted|--out F]
node C:\Dev\toolbox\scripts\docx2md.mjs      <file.docx> [--html|--media-dir DIR|--out F]
node C:\Dev\toolbox\scripts\pptx-extract.mjs <file.pptx> [--json|--media-dir DIR|--notes|--out F]
node C:\Dev\toolbox\scripts\md2docx.mjs      <file.md>   --out <file.docx> [--title T]
node C:\Dev\toolbox\scripts\psd-extract.mjs  <file.psd>  --out DIR [--png|--filter RE|--cutout RE|--hidden|--composite]
node C:\Dev\toolbox\scripts\ico.mjs          <image>     --out <file.ico> [--sizes 16,32,48|--png]
node C:\Dev\toolbox\scripts\ico.mjs          <file.ico>  --info
uv run --project C:\Dev\toolbox C:\Dev\toolbox\scripts\font-shift.py <font> --info [--chars LIST]
uv run --project C:\Dev\toolbox C:\Dev\toolbox\scripts\font-shift.py <font> --chars LIST --dy N --out F
uv run --project C:\Dev\toolbox C:\Dev\toolbox\scripts\font-shift.py <font> --diff <other>
```

Каждый скрипт печатает подсказку при запуске без аргументов.
Результат идёт в stdout, диагностика — в stderr, так что вывод можно
перенаправлять в файл без мусора. Исключения — psd-extract и ico: они
пишут файлы в `--out`.

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
- **ico** — sharp ICO не пишет, поэтому кодировщик свой, на sharp. По
  умолчанию 16, 32 и 48 — стандартный набор `favicon.ico`.
  - Вход — квадратная картинка любого формата, который читает sharp, SVG
    тоже: при ресайзе он рисуется сразу в нужном размере. Несколько файлов —
    каждый идёт в своём размере, без ресайза: под мелкие размеры,
    подправленные руками.
  - Записи — BMP 32bpp с альфой, как у RealFaviconGenerator. `--png` — PNG
    внутри, 256 всегда PNG. PNG-записи браузеры понимают, а
    `System.Drawing.Icon` из .NET Framework — нет: вместо картинки выдаёт
    мусор.
  - `--info` — что лежит в готовом ICO: размер из каталога и из самой
    картинки, формат, байты.

## Шрифты

### Сдвиг глифов — font-shift

Двигает глифы символов по вертикали: дефис, который стоит слишком
высоко, кавычки и т. п. Только TrueType-контуры (`glyf`), CFF — нет.

- `--chars` — `U+002D,U+00AD` или сами символы. Символа нет в шрифте —
  пропускается с предупреждением.
- `--dy` — в единицах шрифта (`--info` печатает upm), минус — вниз.
  Целевую высоту удобно брать с соседнего глифа: `--info --chars`
  показывает bbox.
- Составные глифы, собранные из сдвинутого, едут вместе с ним — скрипт
  их перечисляет. Сдвиг составного глифа двигает его компоненты.
- Сводные значения (bbox в `head`, `hhea`, `maxp`) не пересчитываются,
  чтобы файл отличался только сдвинутыми глифами; bbox в `head` только
  расширяется, если глиф за него вышел.
- `--diff` — что отличается между двумя файлами: контуры, `hmtx`,
  поля `head`/`hhea`/`maxp`/`OS/2`/`post`, остальные таблицы побайтово.
  Прогонять после каждой правки.
- Шрифт под OFL с Reserved Font Name (`--info`, name 0 / 13) — у
  изменённой версии внутреннее имя надо сменить. Скрипт этого не делает.

### Сабсет

Готового скрипта нет: набор начертаний и символов каждый раз свой.
Второй аргумент — строка символов, которые останутся в шрифте, а не
unicode-range.

```js
import { createRequire } from 'node:module';
const subsetFont = createRequire('C:/Dev/toolbox/')('subset-font');
const woff2 = await subsetFont(ttfBuffer, charsToKeep, { targetFormat: 'woff2' });
```

## Генерация xlsx / pptx

Готовых скриптов нет намеренно: требования к формату каждый раз свои.
Писать разовый скрипт на `exceljs` / `pptxgenjs`, резолвя пакеты отсюда:

```js
import { createRequire } from 'node:module';
const require = createRequire('C:/Dev/toolbox/scripts/');
const ExcelJS = require('exceljs');
```

## Браузеры

Из браузеров Playwright скачан только WebKit
(`pnpm exec playwright install webkit`, ~170 МБ). Им воспроизводим
дефекты вёрстки в Safari. Playwright MCP для этого не годится: он
работает через системный Chrome.

```js
import { createRequire } from "node:module";
const { webkit, devices } = createRequire("C:/Dev/toolbox/")("playwright");

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices["iPhone 13"] });
const page = await context.newPage();
await page.goto("http://localhost:3000");
await page.screenshot({ path: "shot.png", fullPage: true });
await browser.close();
```

- Это не настоящий Safari, а сборка WebKit под Windows: баги движка
  ловит, баги iOS — не всегда.
- `devices["iPhone 13"]` даёт ширину 390, DPR 3 и тач. User-Agent в нём
  подставной (iOS 15), версию движка печатает `browser.version()`.
- Десктопный Safari — `newContext()` без `devices`, по умолчанию окно
  1280×720.
- Chromium в скрипте — системный Chrome:
  `chromium.launch({ channel: "chrome" })`, мобилка — `devices["Pixel 7"]`.
- После `pnpm up` версия WebKit может смениться — тогда повторить
  `install webkit`.

## Чего здесь нет

- **PDF** — генерация через HTML/CSS + Playwright, он подключён как MCP.
- **Chromium и Firefox от Playwright** — не скачаны, см. «Браузеры».
- **ImageMagick** — не установлен. Что без него нельзя и как ставить —
  в скилле `images`.

## Оговорка про .prototools

Пин `node`/`pnpm`/`uv` в этом репо действует только когда cwd находится внутри
`C:\Dev\toolbox` — то есть при `pnpm install` / `pnpm up`. При запуске
`node C:\Dev\toolbox\scripts\...` из папки другого проекта proto возьмёт
версию по cwd, из того проекта. Это страховка обслуживания репо, а не
гарантия среды исполнения.

## Обновление

```powershell
cd C:\Dev\toolbox
pnpm outdated
pnpm up
uv lock --upgrade
uv sync
```

После обновления прогнать скрипты на тестовых файлах — API `docx` и
`pptxgenjs` ломались между мажорами.

import argparse
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

USAGE = """usage: uv run --project C:/Dev/toolbox C:/Dev/toolbox/scripts/font-shift.py <font> --info [--chars LIST]
       uv run --project C:/Dev/toolbox C:/Dev/toolbox/scripts/font-shift.py <font> --chars LIST --dy N --out <file>
       uv run --project C:/Dev/toolbox C:/Dev/toolbox/scripts/font-shift.py <font> --diff <other>

  <font>         ttf, otf, woff, woff2 with TrueType outlines (glyf)
  --chars LIST   U+002D,U+00AD or literal characters: -,a
  --dy N         vertical shift in font units, negative moves down
  --out <file>   output; the format follows the extension
  --info         font summary, license names; bbox of --chars glyphs
  --diff <other> glyphs and tables that differ between two fonts"""

FLAVORS = {".woff2": "woff2", ".woff": "woff", ".ttf": None, ".otf": None}
SKIP_TABLES = {"glyf", "loca", "hmtx", "GlyphOrder"}
FIELD_TABLES = {"head", "hhea", "maxp", "OS/2", "post"}
HEAD_VOLATILE = {"checkSumAdjustment", "modified"}


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def parse_chars(spec):
    cps = []
    for part in spec.split(","):
        if part.upper().startswith("U+") and len(part) > 2:
            cps.append(int(part[2:], 16))
        elif len(part) == 1:
            cps.append(ord(part))
        else:
            die(f"bad character: {part!r}")
    return cps


def open_font(file, **kwargs):
    font = TTFont(file, **kwargs)
    if "glyf" not in font:
        die(f"{file}: no glyf table, CFF outlines are not supported")
    return font


def glyph_names(font, cps):
    cmap = font.getBestCmap()
    names = {}
    for cp in cps:
        name = cmap.get(cp)
        if name is None:
            print(f"U+{cp:04X} not in font, skipped", file=sys.stderr)
        else:
            names[cp] = name
    return names


def composites_using(glyf, targets):
    return sorted(
        name
        for name in glyf.keys()
        if glyf[name].isComposite() and any(c.glyphName in targets for c in glyf[name].components)
    )


def plain(value):
    # Nested records like OS/2 panose have no __eq__
    return vars(value) if hasattr(value, "__dict__") else value


def bbox(glyph):
    if not glyph.numberOfContours:
        return "empty"
    return f"x {glyph.xMin}..{glyph.xMax}  y {glyph.yMin}..{glyph.yMax}"


def info(file, cps):
    font = open_font(file)
    glyf = font["glyf"]
    print(f"{file}: {font.flavor or 'sfnt'}, {font['head'].unitsPerEm} upm, {len(font.getGlyphOrder())} glyphs")
    for rec in font["name"].names:
        if rec.nameID in (0, 1, 4, 6, 13, 14):
            print(f"  name {rec.nameID}: {rec.toUnicode()}")
    if not cps:
        return
    names = glyph_names(font, cps)
    for cp, name in names.items():
        g = glyf[name]
        kind = "composite" if g.isComposite() else "simple"
        print(f"  U+{cp:04X} {name}: {kind}, {bbox(g)}")
    users = composites_using(glyf, set(names.values()))
    if users:
        print(f"  composites built from them: {', '.join(users)}")


def shift(file, cps, dy, out):
    ext = Path(out).suffix.lower()
    if ext not in FLAVORS:
        die(f"unknown output format: {ext}")
    # Keep the stored summary values (head bbox, hhea extents, maxp) as they
    # are, so the output differs from the input only in the shifted glyphs
    font = open_font(file, recalcBBoxes=False)
    glyf = font["glyf"]
    head = font["head"]
    names = set(glyph_names(font, cps).values())
    if not names:
        die("nothing to shift")
    for name in sorted(names):
        g = glyf[name]
        if g.isComposite():
            for c in g.components:
                c.y += dy
        elif g.numberOfContours:
            g.coordinates.translate((0, dy))
        g.recalcBounds(glyf)
        if g.numberOfContours:
            head.yMin, head.yMax = min(head.yMin, g.yMin), max(head.yMax, g.yMax)
        print(f"{name}: {bbox(g)}", file=sys.stderr)
    users = composites_using(glyf, names)
    if users:
        print(f"moved along with them: {', '.join(users)}", file=sys.stderr)
    font.flavor = FLAVORS[ext]
    font.save(out)


def diff(a_file, b_file):
    # Stored values as they are in the files, not recalculated on compile
    a, b = open_font(a_file, recalcBBoxes=False), open_font(b_file, recalcBBoxes=False)
    found = False

    def report(msg):
        nonlocal found
        found = True
        print(msg)

    a_order, b_order = a.getGlyphOrder(), b.getGlyphOrder()
    if a_order != b_order:
        report(f"glyph order: {len(a_order)} vs {len(b_order)} glyphs")
    ga, gb = a["glyf"], b["glyf"]
    for name in a_order:
        if name not in gb:
            continue
        pa, pb = ga[name].getCoordinates(ga), gb[name].getCoordinates(gb)
        comps = lambda g: [(c.glyphName, c.x, c.y) for c in getattr(g, "components", [])]
        if list(pa[0]) != list(pb[0]) or list(pa[1]) != list(pb[1]) or comps(ga[name]) != comps(gb[name]):
            report(f"glyph {name}: {bbox(ga[name])}  ->  {bbox(gb[name])}")
        if a["hmtx"][name] != b["hmtx"][name]:
            report(f"hmtx {name}: {a['hmtx'][name]} -> {b['hmtx'][name]}")
    for tag in sorted((set(a.keys()) | set(b.keys())) - SKIP_TABLES):
        if tag not in a or tag not in b:
            report(f"table {tag}: only in {'first' if tag in a else 'second'}")
        elif tag in FIELD_TABLES:
            ta, tb = a[tag], b[tag]
            for field in sorted(set(vars(ta)) | set(vars(tb))):
                if field.startswith("_") or field == "tableTag" or (tag == "head" and field in HEAD_VOLATILE):
                    continue
                va, vb = plain(getattr(ta, field, None)), plain(getattr(tb, field, None))
                if va != vb:
                    report(f"{tag}.{field}: {va} -> {vb}")
        elif a[tag].compile(a) != b[tag].compile(b):
            report(f"table {tag}: differs")
    if not found:
        print("no differences")


def main():
    if len(sys.argv) == 1:
        die(USAGE)
    p = argparse.ArgumentParser(usage=USAGE, add_help=False)
    p.add_argument("font")
    p.add_argument("--chars")
    p.add_argument("--dy", type=int)
    p.add_argument("--out")
    p.add_argument("--info", action="store_true")
    p.add_argument("--diff")
    args = p.parse_args()
    cps = parse_chars(args.chars) if args.chars else []

    if args.info:
        info(args.font, cps)
    elif args.diff:
        diff(args.font, args.diff)
    elif cps and args.dy is not None and args.out:
        shift(args.font, cps, args.dy, args.out)
    else:
        die(USAGE)


if __name__ == "__main__":
    main()

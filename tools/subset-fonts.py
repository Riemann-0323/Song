"""Subset the OFL fonts to the glyphs the PV uses (+ ASCII and full kana).

Download the sources from github.com/google/fonts (ofl/...) into one folder, then:
    python3 tools/subset-fonts.py <font-source-dir>
Requires: pip install fonttools brotli
"""
import pathlib, re, sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

root = pathlib.Path(__file__).resolve().parent.parent
src_dir = pathlib.Path(sys.argv[1])
out_dir = root / 'assets' / 'fonts'
out_dir.mkdir(parents=True, exist_ok=True)

chars = set(chr(c) for c in range(0x20, 0x7f))
chars |= set(chr(c) for c in range(0x3040, 0x30a0))   # hiragana
chars |= set(chr(c) for c in range(0x30a0, 0x3100))   # katakana
chars |= set(chr(c) for c in range(0xff01, 0xff5f))   # full-width ASCII
chars |= set('、。・「」『』…ー―〜！？　·×—─│●■□◆◇★☆♪')
for p in list(root.glob('src/**/*.js')) + [root / 'index.html']:
    chars |= set(ch for ch in p.read_text(encoding='utf-8') if ord(ch) > 0x7f)
text = ''.join(sorted(chars))
print(f'{len(chars)} code points')

# Subsets are OFL "Modified Versions", so they get new internal names (no Reserved Font Names).
FONTS = {
    'dela.woff2': ('DelaGothicOne-Regular.ttf', None, 'GT Dela'),
    'dot.woff2': ('DotGothic16-Regular.ttf', None, 'GT Dot'),
    'zen.woff2': ('ZenKakuGothicNew-Black.ttf', None, 'GT Zen'),
    'orbitron.woff2': ('Orbitron[wght].ttf', {'wght': 900}, 'GT Orbitron'),
    'mono.woff2': ('ShareTechMono-Regular.ttf', None, 'GT Mono'),
}
for out, (name, axes, family) in FONTS.items():
    font = TTFont(src_dir / name)
    if axes:
        font = instancer.instantiateVariableFont(font, axes)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    s = subset.Subsetter(opts)
    s.populate(text=text)
    s.subset(font)
    ps = family.replace(' ', '') + '-Subset'
    for rec in font['name'].names:
        if rec.nameID in (1, 16):
            rec.string = family
        elif rec.nameID in (4,):
            rec.string = family + ' Subset'
        elif rec.nameID in (6,):
            rec.string = ps
        elif rec.nameID in (3,):
            rec.string = ps + ';subset'
    font.flavor = 'woff2'
    font.save(out_dir / out)
    print(out, (out_dir / out).stat().st_size // 1024, 'KB')

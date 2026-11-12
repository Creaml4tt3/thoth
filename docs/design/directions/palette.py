"""Tonal palettes for the redesign directions (Material-style tones 0-100, tone = CIE L*).

A seed colour gives a hue and chroma in OKLCH; each tone is found by searching OKLCH lightness until the colour's
CIE L* equals the tone, clipping chroma into sRGB. Like Material 3, a tone gap of 50 or more gives about 4.5:1, 40 about 3:1.
Run it to print the directions' role tables with their WCAG ratios; `build.py` imports it.
"""
import math

def _lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def _gam(c): return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

def hex_rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

def rgb_hex(rgb): return '#' + ''.join(f'{round(max(0, min(1, c)) * 255):02X}' for c in rgb)

def rgb_oklch(rgb):
    r, g, b = (_lin(c) for c in rgb)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360

def oklch_rgb(L, C, H):
    a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    return lin

def in_gamut(lin): return all(-1e-4 <= c <= 1 + 1e-4 for c in lin)

def lum(rgb): r, g, b = (_lin(c) for c in rgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b

def lstar(y): return 116 * (y ** (1 / 3) if y > 216 / 24389 else (24389 / 27 * y + 16) / 116) - 16

def tone(seed, t, chroma=None):
    """The colour of `seed`'s hue at Material tone `t`; `chroma` overrides the seed's OKLCH chroma."""
    if t <= 0: return '#000000'
    if t >= 100: return '#FFFFFF'
    _, C, H = rgb_oklch(hex_rgb(seed))
    C = C if chroma is None else chroma
    lo, hi = 0.0, 1.0
    for _ in range(40):
        L = (lo + hi) / 2
        c = C
        while c > 0 and not in_gamut(oklch_rgb(L, c, H)): c -= 0.002
        rgb = tuple(_gam(max(0, x)) for x in oklch_rgb(L, max(c, 0), H))
        if lstar(lum(rgb)) < t: lo = L
        else: hi = L
    return rgb_hex(rgb)

def ratio(a, b):
    la, lb = sorted((lum(hex_rgb(a)), lum(hex_rgb(b))), reverse=True)
    return (la + 0.05) / (lb + 0.05)

TONES = (0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98, 100)
def ramp(seed, chroma=None): return {t: tone(seed, t, chroma) for t in TONES}

CAP = 0.07  # chroma ceiling for light containers: cyan and green at tone 90 are neon without it
ACCENT_NAMES = ('gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'red')  # ADR-0037 names stay

def scheme(d, dark):
    """Material roles for one theme. `d` is a direction dict from DIRECTIONS."""
    if dark: d = {**d, **d.get('dark', {})}  # a direction may swap its dark-mode neutrals (Papyrus Night: navy)
    P, S, T, N, NV = (ramp(d[k], d.get(k + '_c')) for k in ('primary', 'secondary', 'tertiary', 'neutral', 'neutral_v'))
    I, IV = (ramp(d['ink'], d.get('ink_c')), ramp(d['ink'], d.get('ink_v_c'))) if 'ink' in d else (N, NV)  # text ramp, when it differs from the surfaces
    E = ramp('#C4302B')
    if not dark:
        r = dict(primary=tone(d['primary'], d.get('p_tone', 40), d.get('primary_c')), on_primary=P[100], primary_container=P[90], on_primary_container=P[10],
                 secondary=S[40], on_secondary=S[100], secondary_container=tone(d['secondary'], 90, CAP), on_secondary_container=S[10],
                 tertiary=T[40], on_tertiary=T[100], tertiary_container=tone(d['tertiary'], 90, CAP), on_tertiary_container=T[10],
                 background=N[99] if 99 in N else N[98], surface=d.get('surface_l', N[98]), surface_dim=N[95] if 'sidebar_l' not in d else d['sidebar_l'],
                 surface_container=NV[95], on_surface=N[10], on_surface_variant=NV[30], outline=NV[50], outline_variant=NV[90],
                 error=E[40], on_error=E[100], error_container=E[90], on_error_container=E[10])
        r['surface'] = d.get('surface_l', '#FFFFFF')
    else:
        r = dict(primary=P[d.get('p_tone_dark', 70)], on_primary=P[10], primary_container=P[30], on_primary_container=P[90],
                 secondary=S[80], on_secondary=S[20], secondary_container=S[30], on_secondary_container=S[90],
                 tertiary=T[80], on_tertiary=T[20], tertiary_container=T[30], on_tertiary_container=T[90],
                 background=N[d.get('bg_dark_tone', 6)] if d.get('bg_dark_tone', 6) in N else tone(d['neutral'], d.get('bg_dark_tone', 6), d.get('neutral_c')),
                 on_surface=I[90], on_surface_variant=IV[80], outline=NV[60], outline_variant=NV[30],
                 error=E[80], on_error=E[20], error_container=E[30], on_error_container=E[90])
        r['surface'] = d.get('surface_dark') or tone(d['neutral'], d.get('surface_dark_tone', 8), d.get('neutral_c'))  # an exact page colour wins
        r['surface_dim'] = tone(d['neutral'], d.get('sidebar_dark_tone', 11), d.get('neutral_c'))
        r['surface_container'] = tone(d['neutral_v'], d.get('container_dark_tone', 16), d.get('neutral_v_c'))
        r['background'] = r['surface']
    acc = {}
    for name in ACCENT_NAMES:
        seed, c = d['accents'][name]
        A = ramp(seed, c)
        acc[name] = dict(fg=A[80] if dark else A[40], soft=A[30] if dark else tone(seed, 90, min(CAP, rgb_oklch(hex_rgb(seed))[1] if c is None else c)), on_soft=A[90] if dark else A[10],
                         dot=A[70] if dark else A[50])
    r['accents'] = acc
    sem = {}
    for name, seed in (('success', '#1E8A4C'), ('warning', '#B07800'), ('info', d['secondary'])):
        A = ramp(seed)
        sem[name] = dict(fg=A[80] if dark else A[40], soft=A[30] if dark else tone(seed, 90, CAP), on_soft=A[90] if dark else A[10])
    r['semantic'] = sem
    return r

def checks(r):
    """(label, ratio, minimum) for every text/background pair the mockups use."""
    out = []
    def c(label, fg, bg, need): out.append((label, ratio(fg, bg), need))
    for k in ('primary', 'secondary', 'tertiary', 'error'):
        c(f'on-{k} / {k}', r['on_' + k], r[k], 4.5)
        c(f'on-{k}-container / {k}-container', r[f'on_{k}_container'], r[f'{k}_container'], 4.5)
    for s in ('surface', 'surface_dim', 'surface_container'):
        c(f'on-surface / {s}', r['on_surface'], r[s], 4.5)
        c(f'on-surface-variant / {s}', r['on_surface_variant'], r[s], 4.5)
        c(f'primary text / {s}', r['primary'], r[s], 4.5)
        c(f'secondary text / {s}', r['secondary'], r[s], 4.5)
        c(f'outline (focus, borders) / {s}', r['outline'], r[s], 3)
        for n, a in r['accents'].items():
            c(f'{n} text / {s}', a['fg'], r[s], 4.5)
            c(f'{n} dot / {s}', a['dot'], r[s], 3)
        for n, a in r['semantic'].items(): c(f'{n} text / {s}', a['fg'], r[s], 4.5)
    for n, a in list(r['accents'].items()) + list(r['semantic'].items()):
        c(f'{n} chip text / {n} chip', a['on_soft'], a['soft'], 4.5)
    return out

DIRECTIONS = {
    'lapis': dict(
        p_tone=46,
        name='Lapis & Moon', primary='#E8590C', secondary='#2F4BC9', tertiary='#0E9AA0',
        neutral='#3A3F5C', neutral_c=0.012, neutral_v='#3A3F5C', neutral_v_c=0.03,
        surface_l='#FFFFFF', sidebar_l='#F4F5FA', bg_dark_tone=6, surface_dark_tone=7, sidebar_dark_tone=10,
        accents=dict(gray=('#6B6F85', 0.02), brown=('#9A5B34', None), orange=('#E8590C', None), yellow=('#D9A400', None),
                     green=('#2E9A57', None), blue=('#2F4BC9', None), purple=('#8A3FD1', None), red=('#D6334A', None))),
    'faience': dict(
        p_tone=44,
        name='Faience', primary='#F0620F', secondary='#00A3A3', tertiary='#E0367A',
        neutral='#2F4747', neutral_c=0.008, neutral_v='#2F4747', neutral_v_c=0.025,
        surface_l='#FFFFFF', sidebar_l=tone('#00A3A3', 94, 0.035), bg_dark_tone=8, surface_dark_tone=9, sidebar_dark_tone=13,
        accents=dict(gray=('#647575', 0.018), brown=('#A0612E', None), orange=('#F0620F', None), yellow=('#E8B400', None),
                     green=('#3FAE3A', None), blue=('#1E7FE0', None), purple=('#7A4DE8', None), red=('#E5304B', None))),
    'dusk': dict(
        p_tone=46,
        name='Moonrise Dusk', primary='#E8590C', secondary='#7B3FE4', tertiary='#E0367A',
        neutral='#2E2638', neutral_c=0.014, neutral_v='#2E2638', neutral_v_c=0.03,
        surface_l='#FFFFFF', sidebar_l=tone('#7B3FE4', 95, 0.025), bg_dark_tone=4, surface_dark_tone=5, sidebar_dark_tone=9,
        accents=dict(gray=('#716A7C', 0.02), brown=('#9C5A3C', None), orange=('#E8590C', None), yellow=('#D99A00', None),
                     green=('#2F9E6A', None), blue=('#3070E0', None), purple=('#7B3FE4', None), red=('#E0365A', None))),
    'papyrus': dict(
        p_tone=44,
        name='Papyrus', primary='#E8590C', secondary='#3B5F8A', secondary_c=0.075, tertiary='#6F8A3C',
        neutral='#5A5040', neutral_c=0.014, neutral_v='#5A5040', neutral_v_c=0.024,
        surface_l=tone('#5A5040', 98.5, 0.012), sidebar_l=tone('#5A5040', 95, 0.02), bg_dark_tone=6, surface_dark_tone=7, sidebar_dark_tone=10,
        accents=dict(gray=('#6E6A62', 0.012), brown=('#8A5A3A', None), orange=('#E8590C', None), yellow=('#C9961E', 0.11),
                     green=('#6F8A3C', 0.10), blue=('#3B5F8A', 0.08), purple=('#7A4F7F', 0.08), red=('#B8452F', 0.12))),
    'earth': dict(
        p_tone=42,
        name='Ochre & Malachite', primary='#E8590C', secondary='#2F7D62', secondary_c=0.08, tertiary='#B8862B', tertiary_c=0.11,
        neutral='#6B5236', neutral_c=0.022, neutral_v='#6B5236', neutral_v_c=0.034,
        surface_l=tone('#6B5236', 97, 0.016), sidebar_l=tone('#6B5236', 93, 0.026), bg_dark_tone=7, surface_dark_tone=8, sidebar_dark_tone=11,
        accents=dict(gray=('#6F675C', 0.015), brown=('#8B5434', None), orange=('#E8590C', None), yellow=('#C08A1E', 0.12),
                     green=('#2F7D62', 0.09), blue=('#2F6390', 0.09), purple=('#7B4A6E', 0.09), red=('#B03A2E', 0.13))),
}

# D with a navy night instead of a brown one: same light theme; dark surfaces from Riviera-like navy, papyrus ink as text.
DIRECTIONS['navy'] = {**DIRECTIONS['papyrus'], 'name': 'Papyrus Night',
                      'dark': dict(neutral='#183451', neutral_c=0.045, neutral_v='#183451', neutral_v_c=0.06,
                                   surface_dark_tone=9, sidebar_dark_tone=12, ink='#5A5040', ink_c=0.016, ink_v_c=0.022)}

# Papyrus Night, darker: a navy so deep it reads as near-black, with just enough blue to stay night sky.
DIRECTIONS['midnight'] = {**DIRECTIONS['navy'], 'name': 'Papyrus Midnight',
                          'dark': {**DIRECTIONS['navy']['dark'], 'neutral_c': 0.035, 'surface_dark_tone': 4,
                                   'sidebar_dark_tone': 7, 'container_dark_tone': 12}}

DIRECTIONS['midnight-sans'] = {**DIRECTIONS['midnight'], 'name': 'Papyrus Midnight (sans)'}

# Owner, 2026-11-12: "Dark Blue Black #00001C instead of Midnight". The page is exactly #00001C (OKLCH hue 264, an indigo
# black); the raised steps keep that hue, a little less chroma, so cards read as the same night and not as grey.
DIRECTIONS['blueblack'] = {**DIRECTIONS['midnight'], 'name': 'Papyrus Blue-Black',
                           'dark': {**DIRECTIONS['midnight']['dark'], 'neutral': '#00001C', 'neutral_c': 0.05, 'neutral_v': '#00001C',
                                    'neutral_v_c': 0.06, 'surface_dark': '#00001C', 'sidebar_dark_tone': 5, 'container_dark_tone': 11}}

if __name__ == '__main__':
    for key, d in DIRECTIONS.items():
        for dark in (False, True):
            fails = [x for x in checks(scheme(d, dark)) if x[1] < x[2]]
            print(d['name'], 'dark' if dark else 'light', 'FAILS:' if fails else 'all AA', *(f'\n  {l}: {v:.2f} < {m}' for l, v, m in fails))

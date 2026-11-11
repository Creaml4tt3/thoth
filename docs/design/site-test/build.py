"""Retheme the current marketing site (thoth-site's built dist/) as Papyrus Midnight, for testing only.

The site's whole palette is a dozen CSS variables plus a few literal colours, so one override stylesheet loaded after
site.css retheme it; the site repo is not touched. Run:  python3 build.py <thoth-site/dist> <out-dir>
It copies dist to out-dir, writes midnight.css, links it from every page, and checks every text pair for AA.
"""
import os, re, shutil, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'directions'))
from palette import ratio, tone, DIRECTIONS, scheme

d = DIRECTIONS['midnight']; D, L = scheme(d, True), scheme(d, False); dk = {**d, **d['dark']}
N = lambda t: tone(dk['neutral'], t, 0.04)
V = {  # the site's own variable names, Midnight values
    '--ground': D['surface'],            # #030F1D page
    '--tone-1': N(9), '--tone-2': N(14), '--tone-3': N(20),
    '--ink': D['on_surface'], '--paper': D['on_surface'], '--muted': D['on_surface_variant'],
    '--stone': tone(dk['neutral'], 60, 0.03),
    '--thoth-moon': '#E8590C', '--moon-hover': D['primary'], '--on-moon': D['surface'],
    '--thoth-moon-soft': 'rgb(232 89 12 / 0.24)', '--thoth-moon-ink': tone(d['primary'], 82),
    '--thoth-link': D['secondary'], '--thoth-border': 'rgb(255 255 255 / 0.08)',
    # The app's Paper fragments become Papyrus paper (light theme of the direction).
    '--ui-ink': L['on_surface'], '--ui-muted': L['on_surface_variant'], '--ui-tone': L['surface_dim'],
}
P = {'paper': L['surface'], 'sel': L['primary_container'], 'sel_ink': L['on_primary_container'], 'accent': L['primary'],
     'ok': tone('#1E8A4C', 40), 'ok_ink': tone('#1E8A4C', 30), 'ws': L['secondary_container'], 'ws_ink': L['on_secondary_container'],
     'priv': tone(d['neutral'], 92, 0.015), 'priv_ink': L['on_surface_variant']}

checks = []
for bg in ('--ground', '--tone-1', '--tone-2', '--tone-3'):
    for fg in ('--ink', '--muted'): checks.append((f'{fg} on {bg}', ratio(V[fg], V[bg]), 4.5))
    checks.append((f'moon on {bg} (large text, marks)', ratio(V['--thoth-moon'], V[bg]), 3))
    checks.append((f'link on {bg}', ratio(V['--thoth-link'], V[bg]), 4.5))
    checks.append((f'stone on {bg} (bullets, separators)', ratio(V['--stone'], V[bg]), 3))
checks += [('on-moon on moon (Download)', ratio(V['--on-moon'], V['--thoth-moon']), 4.5),
           ('on-moon on moon hover', ratio(V['--on-moon'], V['--moon-hover']), 4.5),
           ('ground on paper (light button)', ratio(V['--ground'], V['--paper']), 4.5),
           ('ui-ink on paper fragment', ratio(V['--ui-ink'], P['paper']), 4.5), ('ui-muted on paper fragment', ratio(V['--ui-muted'], P['paper']), 4.5),
           ('ui-ink on ui-tone', ratio(V['--ui-ink'], V['--ui-tone']), 4.5), ('selected row', ratio(P['sel_ink'], P['sel']), 4.5),
           ('chosen button', ratio('#FFFFFF', P['accent']), 4.5), ('ok text', ratio(P['ok_ink'], P['paper']), 4.5),
           ('workspace badge', ratio(P['ws_ink'], P['ws']), 4.5), ('private badge', ratio(P['priv_ink'], P['priv']), 4.5),
           ('md mark', ratio(P['sel_ink'], P['paper']), 4.5)]
fails = [c for c in checks if c[1] < c[2]]
assert not fails, fails

# html[data-theme][data-theme] beats tokens.css [data-theme="night"][data-theme], which redefines the moon and link.
css = ':root,html[data-theme][data-theme]{' + ';'.join(f'{k}:{v}' for k, v in V.items()) + '}\n' + f'''
/* Literal colours in site.css that belong to the old Night or Paper */
html{{background:var(--ground)}}
.btn-ghost:hover,.consent-button:hover{{background:var(--tone-3)}}
.nav-drawer-scrim{{background:rgb(3 15 29 / .72)}}
.badge-workspace,.field:nth-child(4) .ui-badge-workspace{{background:rgb(165 202 247 / .16)}}
.badge-private{{color:var(--muted)}}
.consent{{background:var(--tone-2)}}
.post-video video{{background:var(--tone-1)}}
.ui-code{{background:{N(3)}}}
.window,.ui,.ui-seg .is-on,.field-card{{background:{P['paper']}}}
.ui-tree-row.is-selected{{background:{P['sel']}}}
.md-mark{{color:{P['sel_ink']}}}
.ed-todo.is-done .ed-check,.ui-btn.is-chosen{{background:{P['accent']}}}
.window-saved::before{{background:{P['ok']}}}
.ui-ok{{background-color:{P['ok']}}}
.ui-foot{{color:{P['ok_ink']}}}
.ui-badge-private{{background:{P['priv']};color:{P['priv_ink']}}}
.ui-badge-workspace{{background:{P['ws']};color:{P['ws_ink']}}}
a,.link-button{{text-decoration-color:rgb(232 226 215 / .35)}}
'''

def main(src, out):
    if os.path.exists(out): shutil.rmtree(out)
    shutil.copytree(src, out)
    open(os.path.join(out, 'assets', 'midnight.css'), 'w').write(css)
    pages = 0
    for root, _, files in os.walk(out):
        for f in files:
            if f.endswith('.html'):
                p = os.path.join(root, f); s = open(p).read()
                s2 = re.sub(r'(<link rel="stylesheet" href="/assets/site-[^"]+\.css">)', r'\1<link rel="stylesheet" href="/assets/midnight.css">', s, count=1)
                if s2 != s: open(p, 'w').write(s2); pages += 1
    print(f'{pages} pages rethemed, {len(checks)} pairs pass AA; tightest:', min(checks, key=lambda c: c[1] / c[2]))

if __name__ == '__main__':
    main(*sys.argv[1:3])

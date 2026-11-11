"""Papyrus Midnight applied to the marketing site, in the manner the owner loves (x.ai/bot and notion.com):
centred bare hero with the mark as a glyph in the headline, a pill word, pill CTAs, a real app window with agent log
lines, depth from tonal steps rather than glows, a mascot-scale mark cropped by a card, and a bento.
python3 site.py -> midnight-site.html. Every text pair is checked; the build fails below AA."""
from palette import DIRECTIONS, scheme, ratio, tone
from build import mark, folder_icon, vars_for, CSS, FONTS, FOLDERS, STYLE

d, st = DIRECTIONS['midnight'], STYLE['midnight']
L, D = scheme(d, False), scheme(d, True)
dk = {**d, **d['dark']}
# Site surfaces: dark steps from the page (Grok: #0a0a0a -> #1a1a1a -> white 6%), light = papyrus paper and its sidebar tone.
SITE = {
    'dark': dict(page=D['surface'], raise1=tone(dk['neutral'], 9, 0.04), raise2=tone(dk['neutral'], 14, 0.045), ink=D['on_surface'],
                 ink2=D['on_surface_variant'], hair='rgb(255 255 255 / .07)', pillw=L['primary_container'], pillw_on=L['on_primary_container']),
    'light': dict(page=L['surface'], raise1=L['surface_dim'], raise2=tone(d['neutral'], 92.5, 0.02), ink=L['on_surface'],
                  ink2=L['on_surface_variant'], hair='rgb(60 45 20 / .10)', pillw=L['primary_container'], pillw_on=L['on_primary_container']),
}
checks = []
for m, s in SITE.items():
    R = D if m == 'dark' else L
    for bg in ('page', 'raise1', 'raise2'):
        checks += [(m, f'ink / {bg}', ratio(s['ink'], s[bg])), (m, f'ink2 / {bg}', ratio(s['ink2'], s[bg])), (m, f'moon text / {bg}', ratio(R['primary'], s[bg]))]
    checks += [(m, 'button text / moon', ratio(R['on_primary'], R['primary'])), (m, 'pill word', ratio(s['pillw_on'], s['pillw']))]
fails = [c for c in checks if c[2] < 4.5]
assert not fails, fails

def site_vars(m):
    s = SITE[m]
    return ';'.join(f'--{k}:{v}' for k, v in s.items())

tree = ''.join(f'<div class="row">{folder_icon(c)}<span>{n}</span></div>' for n, c in FOLDERS)
LOG = [('Reading', '12 pages tagged · 3 skipped, already tagged'), ('Journal', 'this week summarised in Weekly plan'),
       ('Launch notes', '1 change proposed · waiting for you')]
log = ''.join(f'<div class="log-l"><span class="ok" aria-hidden="true">✓</span><b>{a}</b> <span aria-hidden="true">→</span> {b}</div>' for a, b in LOG)
APP = f'''<div class="app" role="img" aria-label="The Thoth app: sidebar of folders, a page, and an agent's proposal waiting for review">
 <div class="app-bar"><i></i><i></i><i></i><span>Launch notes</span></div>
 <div class="app-body">
  <aside class="side"><div class="search">Search <kbd>⌘K</kbd></div><div class="sec">Private Space</div>{tree}<div class="row sel">{folder_icon("blue")}<span>Launch notes</span></div>
   <div class="sec">Agents</div><div class="row"><span class="agent-av" style="background:var(--orange-soft);color:var(--orange-on)">C</span><span>Claude Code</span></div>
   <div class="row"><span class="agent-av" style="background:var(--green-soft);color:var(--green-on)">C</span><span>Codex</span></div></aside>
  <main class="pane"><div class="doc"><h2 class="doc-title">Launch notes</h2>
   <div class="props"><span class="tag" style="background:var(--blue-soft);color:var(--blue-on)">#meeting</span><span class="tag" style="background:var(--yellow-soft);color:var(--yellow-on)">#draft</span><span class="meta">Edited 2 min ago</span></div>
   <div class="logbox">{log}</div>
   <div class="proposal"><div class="who"><span class="agent-av" style="color:var(--p)">{mark(20)}</span><b>Claude Code</b> proposes</div>
    <p><ins>+ Step 4: screenshots before and after, in both themes.</ins></p>
    <div class="acts"><button class="btn primary sm">Apply</button><button class="btn ghost sm">Discard</button></div></div></div></main>
 </div></div>'''

BENTO = [('Markdown in a folder', 'Every page is a .md file on your computer. Open it in anything.', 'orange'),
         ('Private until you share', 'Your Private Space stays local. A page reaches a workspace only when you move it.', 'blue'),
         ('Thai, first class', 'Search, fonts and the whole app work in Thai. <span lang="th">ภาษาไทยเต็มรูปแบบ</span>', 'green'),  # REVIEW: Thai string
         ('Open source', 'Apache-2.0. Run your own server, or try the free demo.', 'yellow')]
bento = ''.join(f'<div class="bc"><span class="bdot" style="background:var(--{c}-dot)" aria-hidden="true"></span><h3>{t}</h3><p>{x}</p></div>' for t, x, c in BENTO)

def frame(m):
    return f'''<div class="mock site {m}" data-mode="{m}">
 <nav class="nav"><span class="brand">{mark(22)}<b>Thoth</b></span><span class="links"><a>Download</a><a>Docs</a><a>Blog</a><a>Teams</a></span>
  <span class="nav-cta"><button class="btn quiet">Open the web app</button><button class="btn primary">Download</button></span></nav>
 <section class="hero2">
  <a class="announce"><b>Thoth 0.9.2</b> · Read the release notes <span aria-hidden="true">↗</span></a>
  <h1 class="h1">Meet <span class="glyph">{mark(0)}</span> Thoth</h1>
  <p class="lede2">Your notes are Markdown files in a folder on your computer. Your agents read them, propose changes, and wait for you to apply them.</p>
  <div class="ctas"><button class="btn primary lg">Download for macOS</button><button class="btn quiet lg">Open the web app</button></div>
  {APP}
 </section>
 <section class="big"><div class="big-copy"><h2 class="h2">Agents that <span class="pillword"><i aria-hidden="true"></i><span class="cycle">ask first</span></span></h2>
  <p>Claude Code, Codex and OpenCode work in your notes like teammates. Every change comes back as a proposal you can read, apply or discard.</p></div>
  <div class="big-mark" aria-hidden="true">{mark(0)}</div></section>
 <section class="bento">{bento}</section>
</div>'''

PAGE_CSS = r'''
.site{--display:'Newsreader','Noto Serif Thai',serif;background:var(--page);color:var(--ink);border-radius:20px;overflow:hidden;font:400 15px/1.55 var(--body)}
.site .btn{font-weight:500}
.site .btn.quiet{background:var(--raise2);color:var(--ink)}
.nav{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1px solid var(--hair);background:color-mix(in srgb,var(--page) 85%,transparent);backdrop-filter:blur(12px)}
.nav .brand{display:flex;align-items:center;gap:8px;font:600 17px var(--body);letter-spacing:-.03em}.nav .brand .mark{color:var(--p)}
.nav .links{display:flex;gap:18px;color:var(--ink2);font-size:14px}.nav-cta{display:flex;gap:8px}
@media(max-width:700px){.nav .links,.nav-cta .quiet{display:none}}
.hero2{text-align:center;padding:56px 20px 0;display:flex;flex-direction:column;align-items:center}
.announce{display:inline-flex;gap:6px;align-items:center;background:var(--raise1);border:1px solid var(--hair);border-radius:999px;padding:6px 14px;font-size:13px;color:var(--ink2)}
.announce b{color:var(--ink);font-weight:600}
.h1{font:500 clamp(44px,8vw,76px)/1 var(--display);letter-spacing:-.025em;margin:22px 0 0}
.glyph{display:inline-block;width:.8em;height:.8em;vertical-align:-.04em;margin:0 .02em;color:var(--p)}
.glyph .mark{width:100%;height:100%}
@media (prefers-reduced-motion:no-preference){.glyph{animation:rise .9s cubic-bezier(.2,.8,.2,1) both .1s}
 @keyframes rise{from{transform:translateY(.35em) scale(.85);opacity:0}to{transform:none;opacity:1}}}
.lede2{color:var(--ink2);font-size:18px;line-height:1.6;max-width:36em;margin:18px auto 24px}
.ctas{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.app{margin-top:40px;width:min(980px,100%);border-radius:18px 18px 0 0;overflow:hidden;background:var(--bg);border:1px solid var(--hair);border-bottom:0;text-align:left;
 box-shadow:0 1px 1px rgb(0 0 0/.03),0 4px 8px rgb(0 0 0/.03),0 16px 32px rgb(0 0 0/.04)}
.app-bar{display:flex;gap:6px;align-items:center;padding:10px 14px;background:var(--side);border-bottom:1px solid var(--olv);font-size:12.5px;color:var(--fg2)}
.app-bar i{width:10px;height:10px;border-radius:50%;background:var(--olv)}.app-bar span{margin-left:10px}
.app-body{display:grid;grid-template-columns:200px 1fr;min-height:340px}
@media(max-width:620px){.app-body{grid-template-columns:1fr}.app-body .side{display:none}}
.logbox{border:1px solid var(--olv);border-radius:12px;padding:10px 12px;margin:10px 0;background:var(--side);font-size:13px}
.log-l{padding:2px 0}.log-l .ok{color:var(--success);font-weight:700;margin-right:6px}
.big{position:relative;overflow:hidden;margin:56px 20px 0;border-radius:24px;background:var(--raise1);border:1px solid var(--hair);min-height:300px;display:flex;align-items:center}
.big-copy{position:relative;padding:40px;max-width:540px}
.h2{font:500 clamp(30px,4.6vw,44px)/1.1 var(--display);letter-spacing:-.02em;margin:0 0 14px}
.big p{color:var(--ink2);font-size:16px;margin:0}
.pillword{display:inline-flex;align-items:center;gap:.25em;background:var(--pillw);color:var(--pillw_on);border-radius:999px;padding:0 .35em 0 .25em;font-style:italic}
.pillword i{width:.32em;height:.32em;border-radius:50%;background:var(--p)}
.big-mark{position:absolute;right:-70px;bottom:-110px;width:360px;height:360px;color:var(--p)}
.big-mark .mark{width:100%;height:100%}
@media(max-width:700px){.big-mark{opacity:.18}}
.bento{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 20px 28px}
@media(max-width:620px){.bento{grid-template-columns:1fr}}
.bc{background:var(--raise1);border:1px solid var(--hair);border-radius:20px;padding:22px}
.bc h3{font:600 18px/1.25 var(--body);margin:10px 0 4px;letter-spacing:-.01em}.bc p{margin:0;color:var(--ink2)}
.bdot{display:block;width:28px;height:28px;border-radius:9px}
'''

CYCLE = '''<script>
document.querySelectorAll('.modes button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.modes button').forEach(x=>x.setAttribute('aria-pressed',x===b));document.querySelectorAll('.site').forEach(s=>s.hidden=s.dataset.mode!==b.dataset.m)}));
// The pill word cycles only when motion is allowed; otherwise it stays "ask first".
if(!matchMedia('(prefers-reduced-motion: reduce)').matches){const w=['ask first','tidy folders','draft pages','remember'];let i=0;setInterval(()=>{i=(i+1)%w.length;document.querySelectorAll('.cycle').forEach(c=>c.textContent=w[i])},2200)}
</script>'''

common = (f"--display:{st['display']};--body:{st['body']};--mono:'JetBrains Mono',monospace;--dw:{st['display_w']};--dt:{st['display_track']};"
          f"--rc:{st['r_card']}px;--rc2:{st['r_content'] + 2}px;--rs:{st['r_content'] - 2}px")
worst = min(checks, key=lambda c: c[2])
html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Papyrus Midnight site</title><link rel="stylesheet" href="{FONTS}"><style>{CSS}{PAGE_CSS}
.mock.light{{{vars_for(L)};{site_vars('light')}}} .mock.dark{{{vars_for(D)};{site_vars('dark')}}} .mock{{{common}}}</style></head><body><div class="dir">
<p class="lead"><b style="color:var(--foreground)">Papyrus Midnight, as a site.</b> The patterns from x.ai/bot and notion.com, made Thoth's own: the Moon Ibis as a glyph in the headline (Grok's "Meet ◐ Grok Bot"; DESIGN.md already asks for "Meet ◐ Thoth"), pill actions at weight 500, a real app window with agent log lines, depth from tonal steps instead of glows, the mark at mascot scale cropped by a card, a Notion pill word, and a bento. All {len(checks)} site pairs pass AA (tightest {worst[0]} {worst[1]} at {worst[2]:.2f}:1).</p>
<div class="modes" role="group" aria-label="Theme"><button aria-pressed="true" data-m="dark">Midnight</button><button aria-pressed="false" data-m="light">Paper</button></div>
{frame('dark')}{frame('light').replace('data-mode="light">', 'data-mode="light" hidden>', 1)}
</div>{CYCLE}</body></html>'''
open('midnight-site.html', 'w').write(html)
print('wrote midnight-site.html', len(checks), 'pairs, tightest', worst)

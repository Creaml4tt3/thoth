"""Builds one self-contained mockup page per direction (palette.py holds the colours and the contrast checks).

python3 build.py  ->  lapis.html, faience.html, dusk.html. Every text/background pair is checked; the build fails below AA.
"""
import html as h
from palette import DIRECTIONS, scheme, checks, tone, ratio, TONES, ramp

FONTS = ('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800'
         '&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Noto+Sans+Thai:wght@400;600&family=Noto+Serif+Thai:wght@500;600'
         '&family=Anuphan:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap')

STYLE = {
    'lapis': dict(
        tagline='Calm page, coloured frame. The page you write on stays white; colour lives in the frame around it: the sidebar, '
                'the space badges, folders, tags and agents. Lapis blue (the stone of Egyptian amulets) is the second colour, and it means "your team".',
        display="'Inter', 'Noto Sans Thai', sans-serif", display_w=650, display_track='-0.04em', thai='Noto Sans Thai',
        body="'Inter', 'Noto Sans Thai', sans-serif", r_content=8, r_card=14, ratio=1.25,
        roles='Moon orange = you and your agents (primary actions, focus, agent work). Lapis = the team (workspaces, shared pages, links). Teal = time (Today, the timeline, reminders).',
        hero_bg=('secondary', 8, 0.07), hero_bg2=('secondary', 14, 0.10), hero_dark=True, extra=''),
    'faience': dict(
        tagline='Glazed and playful. Named after the turquoise glazed ware of ancient Egypt: tinted surfaces, rounder shapes, '
                'colour tiles on every setting and feature, and a bolder display face. The most colourful of the three.',
        display="'Bricolage Grotesque', 'Anuphan', sans-serif", display_w=750, display_track='-0.035em', thai='Anuphan',
        body="'Inter', 'Anuphan', sans-serif", r_content=12, r_card=20, ratio=1.333,
        roles='Moon orange = you and your agents. Turquoise = the team and links. Rose = highlights, mentions and the moments worth celebrating.',
        hero_bg=('secondary', 96, 0.03), hero_bg2=('tertiary', 95, 0.03), hero_dark=False,
        extra='.side .row.sel{background:var(--sc);color:var(--on-sc)} .tag{border-radius:8px} .tile{border-radius:8px;width:22px;height:22px} .run{border-radius:16px} .tab.act{box-shadow:none;background:var(--pc);color:var(--on-pc);border-radius:999px} .tabs{padding:6px 8px;gap:4px} .tab{border-radius:999px} .callout{border-radius:16px} .doc-title{font-size:34px} .av{border-radius:12px}'),
    'dusk': dict(
        tagline='Moonrise. The night sky at the moment the moon comes up: violet night, an orange-to-rose moonrise for brand moments, '
                'and a serif display that recalls the scribe. Most cinematic; dark mode is the star.',
        display="'Newsreader', 'Noto Serif Thai', serif", display_w=500, display_track='-0.02em', thai='Noto Serif Thai (display), Noto Sans Thai (UI)',
        body="'Inter', 'Noto Sans Thai', sans-serif", r_content=8, r_card=16, ratio=1.25,
        roles='Moon orange = you and your agents. Violet = the team and links. Rose = highlights and mentions.',
        hero_bg=('secondary', 5, 0.06), hero_bg2=('tertiary', 10, 0.07), hero_dark=True,
        extra='.hub-side{background:linear-gradient(180deg,var(--side),var(--sc))} .hub-side .hub-h{color:var(--on-sc)} .doc-title{font-size:34px;font-style:italic} .proposal{border:0;background:linear-gradient(135deg,var(--pc),var(--tc));color:var(--on-pc)} .signin{background:linear-gradient(160deg,var(--sc),var(--tc))}'),
    'papyrus': dict(
        tagline='Paper tones. Warm papyrus paper and brown-black ink, like the current design but fuller: Moon orange for you and your agents, '
                'Egyptian blue for the team, papyrus green for time. Newsreader, the reading serif Thoth already ships, becomes the display face.',
        display="'Newsreader', 'Noto Serif Thai', serif", display_w=500, display_track='-0.02em', thai='Noto Serif Thai (display), Noto Sans Thai (UI)',
        body="'Inter', 'Noto Sans Thai', sans-serif", r_content=6, r_card=14, ratio=1.25,
        roles='Moon orange = you and your agents. Egyptian blue = the team, shared pages and links. Papyrus green = time (Today, the timeline).',
        hero_bg=('neutral', 97, 0.016), hero_bg2=('neutral', 93, 0.024), hero_dark=False,
        extra='.hero-papyrus::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(180deg,transparent 0 31px,rgb(110 85 50/.10) 31px 32px)} .doc-title{font-size:34px} .tab.act{box-shadow:inset 0 -2px 0 var(--p)}'),
    'earth': dict(
        tagline='Earth tones. The pigments of an Egyptian painter: sand and umber surfaces, malachite green and yellow ochre beside Moon orange. '
                'Warm in both themes; dark mode is umber soil, not black. Fraunces gives headlines a soft, hand-made weight.',
        display="'Fraunces', 'Noto Serif Thai', serif", display_w=650, display_track='-0.025em', thai='Noto Serif Thai (display), Noto Sans Thai (UI)',
        body="'Inter', 'Noto Sans Thai', sans-serif", r_content=10, r_card=18, ratio=1.25,
        roles='Moon orange = you and your agents. Malachite = the team, shared pages and links. Ochre = time and highlights.',
        hero_bg=('neutral', 10, 0.022), hero_bg2=('primary', 13, 0.045), hero_dark=True,
        extra='.side .row.sel{background:var(--sc);color:var(--on-sc)} .tab.act{box-shadow:none;background:var(--bg);border-radius:10px 10px 0 0} .run{border-radius:14px}'),
}

STYLE['navy'] = {**STYLE['papyrus'],
    'tagline': 'Papyrus Night. Direction D in daylight (paper, brown-black ink, Moon, Egyptian blue, papyrus green), but at night the page '
               'turns deep navy, like the sky the moon rises in, and the ink becomes warm papyrus cream. Orange on navy is the most-pinned pairing.',
    'hero_bg': ('secondary', 9, 0.05), 'hero_bg2': ('secondary', 16, 0.06), 'hero_dark': True}

STYLE['midnight'] = {**STYLE['navy'],
    'tagline': 'Papyrus Midnight. Direction D in daylight; at night the page is a navy so deep it reads as almost black, '
               'with only a hint of blue, like the sky long after sunset. Ink stays warm papyrus cream, and Moon orange glows.',
    'hero_bg': ('neutral', 3, 0.03), 'hero_bg2': ('neutral', 8, 0.04)}

# Sans only (owner, 2026-11-11: "try without serif fonts"): Inter for display too, set tight and medium-heavy like Notion and Grok.
STYLE['midnight-sans'] = {**STYLE['midnight'], 'display': "'Inter', 'Noto Sans Thai', sans-serif", 'display_w': 600,
    'display_track': '-0.035em', 'thai': 'Noto Sans Thai',
    'tagline': 'Papyrus Midnight, sans only. The same colours as Papyrus Midnight, with Inter for headlines as well as text: '
               'weight 600, tight tracking, the way Notion and Grok bot set theirs. Thai uses Noto Sans Thai throughout.'}

# Owner, 2026-11-12: #00001C for dark, sans headlines.
STYLE['blueblack'] = {**STYLE['midnight-sans'], 'hero_bg': ('neutral', 1, 0.05), 'hero_bg2': ('neutral', 7, 0.05),
    'tagline': 'Papyrus Blue-Black. Direction D in daylight; at night the page is #00001C, a blue so deep it is almost black, '
               'with an indigo cast where Midnight had a navy one. Ink stays warm papyrus cream; headlines are Inter 600.'}

STYLE['black'] = {**STYLE['midnight-sans'], 'hero_bg': ('neutral', 2, 0.004), 'hero_bg2': ('neutral', 7, 0.006),
    'tagline': 'Papyrus Black. Direction D in daylight; at night a soft ink black (#0E0C0B), with greys that keep a trace of papyrus warmth. '
               'Blue is only the secondary colour: links, workspace badges, your own messages. Moon orange leads; headlines are Inter 600.'}

_mask = [0]
def mark(size, cls=''):
    _mask[0] += 1; i = f'm{_mask[0]}'
    return (f'<svg class="mark {cls}" width="{size}" height="{size}" viewBox="0 0 512 512" aria-hidden="true"><defs><mask id="{i}">'
            '<circle cx="256" cy="256" r="224" fill="#fff"/><path d="M430.4 396.5 C428.9 354.3 390.7 304.0 360.1 276.3 C336.9 255.6 310.3 238.4 282.4 224.9 '
            'C275.6 221.6 268.9 218.3 261.9 215.5 C255.8 213.1 246.8 210.9 241.4 207.6 C235.6 204.0 229.6 194.5 224.4 189.4 C212.6 178.1 198.3 169.9 182.3 166.5 '
            'C141.0 157.8 101.4 183.0 87.4 222.0 C84.0 231.5 82.6 241.3 82.1 251.4 C80.8 277.6 91.8 303.3 105.0 325.3 C112.3 337.6 120.6 349.4 127.2 362.1 '
            'C137.1 381.0 142.3 405.1 132.1 425.0 C129.8 429.3 126.8 433.0 123.6 436.7 L118.9 443.1 A232 232 0 0 0 198.8 480.8 L200.8 473.1 C201.3 466.6 201.9 460.1 '
            '201.7 453.6 C200.5 425.6 190.0 397.9 176.0 373.9 C171.9 366.8 167.8 359.8 163.6 352.8 C151.8 333.7 138.3 313.2 140.8 289.7 C142.8 270.2 159.5 257.2 '
            '177.8 253.6 C188.5 251.5 200.0 252.0 210.8 252.8 C275.3 257.5 330.2 282.6 376.4 328.0 C403.0 354.2 406.5 372.3 430.4 396.5Z" fill="#000"/>'
            f'<path d="M195.4 210.3 A11.4 11.4 0 1 1 172.6 210.3 A11.4 11.4 0 1 1 195.4 210.3Z" fill="#fff"/></mask></defs>'
            f'<circle cx="256" cy="256" r="224" fill="currentColor" mask="url(#{i})"/></svg>')

def vars_for(r):
    v = {'p': r['primary'], 'on-p': r['on_primary'], 'pc': r['primary_container'], 'on-pc': r['on_primary_container'],
         's': r['secondary'], 'on-s': r['on_secondary'], 'sc': r['secondary_container'], 'on-sc': r['on_secondary_container'],
         't': r['tertiary'], 'on-t': r['on_tertiary'], 'tc': r['tertiary_container'], 'on-tc': r['on_tertiary_container'],
         'bg': r['surface'], 'side': r['surface_dim'], 'cont': r['surface_container'], 'fg': r['on_surface'], 'fg2': r['on_surface_variant'],
         'ol': r['outline'], 'olv': r['outline_variant'], 'err': r['error'], 'errc': r['error_container'], 'on-errc': r['on_error_container']}
    for n, a in list(r['accents'].items()) + list(r['semantic'].items()):
        v[f'{n}'] = a['fg']; v[f'{n}-soft'] = a['soft']; v[f'{n}-on'] = a['on_soft']
        if 'dot' in a: v[f'{n}-dot'] = a['dot']
    return ';'.join(f'--{k}:{c}' for k, c in v.items())

def swatch_row(name, seed, c=None):
    R = ramp(seed, c)
    cells = ''.join(f'<div class="sw" style="background:{R[t]};color:{"#fff" if t < 55 else "#111"}"><b>{t}</b><span>{R[t]}</span></div>' for t in TONES)
    return f'<div class="ramp"><div class="ramp-name">{name}</div><div class="sws">{cells}</div></div>'

def role_card(r, dark):
    rows = [('Primary', 'primary', 'on_primary'), ('Primary container', 'primary_container', 'on_primary_container'),
            ('Secondary', 'secondary', 'on_secondary'), ('Secondary container', 'secondary_container', 'on_secondary_container'),
            ('Tertiary', 'tertiary', 'on_tertiary'), ('Tertiary container', 'tertiary_container', 'on_tertiary_container'),
            ('Surface (page)', 'surface', 'on_surface'), ('Surface dim (sidebar)', 'surface_dim', 'on_surface'),
            ('Surface container', 'surface_container', 'on_surface_variant'), ('Error container', 'error_container', 'on_error_container')]
    out = ''.join(f'<div class="role" style="background:{r[b]};color:{r[f]}"><span>{n}</span><small>{r[b]} · on {r[f]} · {ratio(r[f], r[b]):.1f}:1</small></div>' for n, b, f in rows)
    acc = ''.join(f'<span class="chip" style="background:{a["soft"]};color:{a["on_soft"]}"><i style="background:{a["dot"]}"></i>{n}</span>' for n, a in r['accents'].items())
    sem = ''.join(f'<span class="chip" style="background:{a["soft"]};color:{a["on_soft"]}">{n}</span>' for n, a in r['semantic'].items())
    return f'<div class="roles" style="background:{r["surface"]}"><div class="roles-h" style="color:{r["on_surface"]}">{"Dark" if dark else "Light"}</div>{out}<div class="chips">{acc}</div><div class="chips">{sem}</div></div>'

FOLDERS = [('Journal', 'orange'), ('Projects', 'blue'), ('Reading', 'green'), ('Recipes', 'yellow'), ('Ideas', 'purple')]
TAGS = [('meeting', 'blue'), ('draft', 'yellow'), ('thai', 'red')]

def folder_icon(colour):
    return f'<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3.2l1.6 1.6H13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12z" fill="var(--{colour}-dot)"/></svg>'

def screens(key):
    tree = ''.join(f'<div class="row">{folder_icon(c)}<span>{n}</span></div>' for n, c in FOLDERS)
    tags = ''.join(f'<span class="tag" style="background:var(--{c}-soft);color:var(--{c}-on)">#{n}</span>' for n, c in TAGS)
    editor = f'''
<div class="win">
 <aside class="side">
  <div class="sw-space"><span class="av" style="background:var(--p);color:var(--on-p)">P</span><div><b>My notes</b><small class="badge b-local">Local</small></div></div>
  <div class="search">Search <kbd>⌘K</kbd></div>
  <div class="row on-today"><span class="ic" style="background:var(--tc);color:var(--on-tc)">☀</span><span>Today</span></div>
  <div class="row"><span class="ic" style="background:var(--cont);color:var(--fg2)">◷</span><span>Timeline</span></div>
  <div class="sec">Favourites</div>
  <div class="row"><span class="star" aria-hidden="true">★</span><span>Weekly plan</span></div>
  <div class="sec">Private Space</div>
  {tree}
  <div class="row sel">{folder_icon("blue")}<span>Launch notes</span></div>
  <div class="sec">Acme team <small class="badge b-ws">Workspace</small></div>
  <div class="row">{folder_icon("gray")}<span>Handbook</span></div>
 </aside>
 <main class="pane">
  <div class="tabs"><span class="tab act">Launch notes</span><span class="tab">Weekly plan</span><span class="tab">Today</span></div>
  <div class="doc">
   <div class="crumbs">Private Space / Projects / <b>Launch notes</b></div>
   <h1 class="doc-title">Launch notes</h1>
   <div class="props">{tags}<span class="meta">Edited 2 min ago</span></div>
   <p>The redesign ships in three steps: tokens first, then the app, then the site. Every colour keeps AA contrast.</p>
   <div class="callout"><span aria-hidden="true">💡</span><div><b>Tip</b> Type <code>/</code> for blocks, or <code>@</code> to link a page or a person.</div></div>
   <p lang="th"><!-- REVIEW --> บันทึกของคุณเป็นไฟล์ Markdown ในโฟลเดอร์บนเครื่องของคุณ</p>
   <div class="proposal"><div class="who"><span class="agent-av" style="background:var(--p);color:var(--on-p)">{mark(12)}</span><b>Claude Code</b> proposes</div>
    <p><ins>+ Step 4: screenshots before and after, in both themes.</ins></p>
    <div class="acts"><button class="btn primary">Apply</button><button class="btn ghost">Discard</button></div></div>
  </div>
 </main>
</div>'''
    agents = [('Claude Code', 'orange', 'Running', 'Summarise this week’s meeting notes'), ('Codex', 'green', 'Needs review', 'Tidy the Reading folder'),
              ('OpenCode', 'purple', 'Done', 'Draft the release post')]
    runs = ''.join(f'<div class="run"><span class="agent-av" style="background:var(--{c}-soft);color:var(--{c}-on)">{n[0]}</span><div><b>{t}</b><small>{n}</small></div>'
                   f'<span class="status st-{s.split()[0].lower()}">{"● " if s=="Running" else "◐ " if s=="Needs review" else "✓ "}{s}</span></div>' for n, c, s, t in agents)
    hub = f'''
<div class="win hub">
 <aside class="side hub-side">
  <div class="hub-h">{mark(18)} Agent Hub</div>
  <button class="btn primary wide">New task</button>
  <div class="sec">Runs</div>{runs}
 </aside>
 <main class="pane chat">
  <div class="msg me">Tidy the Reading folder: one page per book, tagged by status.</div>
  <div class="msg bot"><div class="who"><span class="agent-av" style="background:var(--green-soft);color:var(--green-on)">C</span><b>Codex</b> · 3 files changed</div>
   <div class="diff"><div class="d-file">Reading/Dune.md</div><div class="d-add">+ status: finished</div><div class="d-del">− tags: book, scifi, todo</div><div class="d-add">+ tags: book, scifi</div></div>
   <div class="acts"><button class="btn primary">Apply all</button><button class="btn tonal">Review each</button><button class="btn ghost">Discard</button></div></div>
  <div class="composer"><span class="ctx">@Reading</span><span class="ph">Ask an agent…</span><button class="btn primary sm" aria-label="Send">↑</button></div>
 </main>
</div>'''
    nav = [('General', 'gray'), ('Appearance', 'purple'), ('Agents', 'orange'), ('Connected apps', 'blue'), ('Servers', 'green'), ('Updates', 'yellow')]
    navs = ''.join(f'<div class="row{" sel" if n=="Appearance" else ""}"><span class="tile" style="background:var(--{c}-dot)" aria-hidden="true"></span><span>{n}</span></div>' for n, c in nav)
    colours = ''.join(f'<label class="cdot"><span style="background:var(--{n}-dot)"></span>{n}</label>' for n in ('orange', 'yellow', 'green', 'blue', 'purple', 'red'))
    settings = f'''
<div class="win">
 <aside class="side"><div class="hub-h">Settings</div>{navs}</aside>
 <main class="pane set">
  <h2>Appearance</h2>
  <div class="field"><div><b>Theme</b><small>System follows your computer.</small></div>
   <div class="seg" role="radiogroup"><span>Light</span><span>Dark</span><span class="on" aria-checked="true">System</span></div></div>
  <div class="field"><div><b>Reading font</b><small>For pages only; menus keep the UI font.</small></div><div class="seg"><span class="on">Sans</span><span>Serif</span></div></div>
  <div class="field"><div><b>Show the mascot</b><small>It reacts while agents work.</small></div><span class="switch on" role="switch" aria-checked="true"><i></i></span></div>
  <div class="field col"><div><b>Folder colours</b><small>Colours tint the icon; names keep the text colour.</small></div><div class="cdots">{colours}</div></div>
  <div class="field"><div><b>Keyboard focus</b><small>Every control shows a ring like this one.</small></div><button class="btn tonal focus">Focused button</button></div>
 </main>
</div>'''
    signin = f'''
<div class="signin">
 <div class="card">
  <div class="brand">{mark(28)}<b>Thoth</b></div>
  <h2>Sign in</h2>
  <p class="muted">Open your workspaces on the free demo server.</p>
  <button class="btn outline wide"><span class="g">G</span> Continue with Google</button>
  <button class="btn outline wide"><span class="g">⌥</span> Continue with GitHub</button>
  <div class="note"><b>Demo server</b> Accounts unused for 90 days are deleted. Keep anything important in your Private Space.</div>
  <div class="foot"><span>English ▾</span><a>Use your own server</a></div>
 </div>
</div>'''
    return editor, hub, settings, signin

def hero(key, d, st):
    dark = st['hero_dark']
    r = scheme(d, dark)
    which, t1, c1 = st['hero_bg']; w2, t2, c2 = st['hero_bg2']
    hd = {**d, **d.get('dark', {})} if dark else d
    b1, b2 = tone(hd[which], t1, c1), tone(hd[w2], t2, c2)
    fg = '#FFFFFF' if dark else r['on_surface']
    lede = tone(d['secondary'], 88, 0.03) if dark else r['on_surface_variant']
    glow = r['primary'] if dark else d['primary']
    checks_extra = [('hero headline / hero top', ratio(fg, b1), 4.5), ('hero headline / hero bottom', ratio(fg, b2), 4.5),
                    ('hero lede / hero top', ratio(lede, b1), 4.5), ('hero lede / hero bottom', ratio(lede, b2), 4.5)]
    btn_bg, btn_fg = (r['primary'], r['on_primary'])
    checks_extra.append(('hero primary button', ratio(btn_fg, btn_bg), 4.5))
    tree = ''.join(f'<div class="row">{folder_icon(c)}<span>{n}</span></div>' for n, c in FOLDERS[:4])
    APP_SHOT = (f'<div class="h-app"><div class="win mini"><aside class="side">{tree}<div class="row sel">{folder_icon("blue")}<span>Launch notes</span></div></aside>'
                f'<main class="pane"><div class="doc"><h2 class="doc-title">Launch notes</h2><p>Tokens first, then the app, then the site.</p>'
                f'<div class="proposal"><div class="who"><span class="agent-av" style="background:var(--p);color:var(--on-p)">{mark(12)}</span><b>Claude Code</b> proposes</div>'
                f'<p><ins>+ Step 4: screenshots in both themes.</ins></p><div class="acts"><button class="btn primary sm">Apply</button><button class="btn ghost sm">Discard</button></div></div></div></main></div></div>')
    moon = {
        'lapis': f'<div class="h-moon" style="background:radial-gradient(circle at 35% 35%, {tone(d["primary"],80)}, {d["primary"]} 55%, {tone(d["primary"],40)} 100%);box-shadow:0 0 120px 30px {d["primary"]}55"></div>',
        'faience': f'<div class="h-tiles">' + ''.join(f'<span style="background:{tone(s,c)}"></span>' for s, c in ((d['primary'], 62), (d['secondary'], 70), (d['tertiary'], 70), ('#E8B400', 82), (d['secondary'], 85), (d['primary'], 85))) + '</div>',
        'dusk': f'<div class="h-moon dusk" style="background:linear-gradient(180deg, {tone(d["primary"],75)}, {d["primary"]} 45%, {tone(d["tertiary"],50)} 100%);box-shadow:0 -10px 140px 40px {d["tertiary"]}55"></div>',
        'papyrus': APP_SHOT,
        'navy': APP_SHOT,
        'midnight': APP_SHOT,
        'midnight-sans': APP_SHOT,
        'blueblack': APP_SHOT,
        'black': APP_SHOT,
        'earth': APP_SHOT,
    }[key]
    html = f'''
<div class="hero hero-{key}" style="background:linear-gradient(170deg,{b1},{b2});color:{fg}">
 {moon}
 <div class="h-copy">
  <h1 class="h-title">{'Your notes.<br><em>Your files.</em>' if key in ('papyrus', 'earth', 'navy', 'midnight', 'midnight-sans', 'blueblack', 'black') else f'Your notes. {mark(0, "inline")} Your files.'}</h1>
  <p class="h-lede" style="color:{lede}">Thoth is an open-source notes app. Everything you write is a Markdown file in a folder on your computer, and a page reaches your team only when you share it.</p>
  <div class="h-acts"><button class="btn primary lg">Download for macOS</button><button class="btn lg" style="background:transparent;color:{fg};border:1.5px solid {fg}">Open the web app</button></div>
 </div>
</div>'''
    return html, checks_extra

CSS = r'''
.dir{font-family:var(--font-body)}
.dir h2.sec-h{font:600 20px/1.3 var(--font-body);margin:40px 0 6px;letter-spacing:-.01em}
.dir p.lead{color:var(--muted-foreground);margin:0 0 16px;max-width:68ch;line-height:1.55}
.ramp{display:grid;grid-template-columns:84px 1fr;gap:8px;align-items:center;margin:6px 0}
.ramp-name{font-size:12px;color:var(--muted-foreground)}
.sws{display:grid;grid-template-columns:repeat(13,1fr);border-radius:10px;overflow:hidden}
.sw{padding:6px 2px;min-height:44px;font-size:9px;display:flex;flex-direction:column;justify-content:space-between}
.sw b{font-size:11px}.sw span{opacity:.85;word-break:break-all}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:640px){.pair{grid-template-columns:1fr}}
.roles{border-radius:var(--radius);padding:12px;display:grid;gap:6px}
.roles-h{font-weight:600;font-size:13px}
.role{border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;font-size:13px;font-weight:600}
.role small{font-weight:400;font-size:11px;opacity:.9}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:500}
.chip i{width:8px;height:8px;border-radius:50%}
.typescale{display:grid;gap:4px}
.typescale div{display:grid;grid-template-columns:110px 1fr;gap:12px;align-items:baseline;border-bottom:1px solid var(--border);padding:6px 0}
.typescale small{color:var(--muted-foreground);font-size:11px}
.spacing{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.spacing div{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:var(--muted-foreground)}
.spacing span{display:block;background:var(--primary);border-radius:3px}
.modes{display:flex;gap:6px;margin:8px 0 12px}
.modes button{font:inherit;font-size:13px;padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--foreground);cursor:pointer}
.modes button[aria-pressed=true]{background:var(--foreground);color:var(--background)}
.modes button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.stage{display:grid;gap:16px}
.cap{font-size:13px;color:var(--muted-foreground);margin:4px 0 0}
/* mock surfaces: every colour below comes from the direction's variables */
.mock{color:var(--fg);font:400 13px/1.5 var(--body);border-radius:var(--rc);overflow:hidden}
.mock .mark{display:inline-block;vertical-align:middle}
.win{display:grid;grid-template-columns:minmax(150px,200px) 1fr;background:var(--bg);border:1px solid var(--olv);border-radius:var(--rc);overflow:hidden;min-height:380px}
@media (max-width:560px){.win{grid-template-columns:1fr}.win .side{display:none}}
.side{background:var(--side);padding:10px 8px;display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--olv)}
.row{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--rs);color:var(--fg)}
.row.sel{background:var(--pc);color:var(--on-pc);font-weight:600}
.sec{font-size:11.5px;color:var(--fg2);padding:10px 8px 2px;display:flex;align-items:center;gap:6px;font-weight:600}
.ic{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;font-size:11px}
.star{color:var(--yellow-dot);width:16px;text-align:center}
.sw-space{display:flex;gap:8px;align-items:center;padding:4px 6px 8px}
.sw-space b{display:block;font-size:13px}
.av{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font-weight:700}
.badge{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:999px}
.b-local{background:var(--gray-soft);color:var(--gray-on)}
.b-ws{background:var(--sc);color:var(--on-sc)}
.search{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--olv);background:var(--bg);border-radius:999px;padding:4px 10px;color:var(--fg2);margin:0 2px 6px}
kbd{font:11px var(--mono);color:var(--fg2)}
.pane{min-width:0;display:flex;flex-direction:column}
.tabs{display:flex;gap:2px;padding:6px 8px 0;background:var(--side);border-bottom:1px solid var(--olv)}
.tab{padding:6px 12px;border-radius:var(--rs) var(--rs) 0 0;color:var(--fg2);white-space:nowrap}
.tab.act{background:var(--bg);color:var(--fg);box-shadow:inset 0 2px 0 var(--p);font-weight:600}
.doc{padding:18px 28px;max-width:560px}
.crumbs{font-size:12px;color:var(--fg2)}
.doc-title{font:var(--dw) 30px/1.1 var(--display);letter-spacing:var(--dt);margin:6px 0 8px}
.props{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.tag{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
.meta{font-size:12px;color:var(--fg2)}
.doc p{margin:8px 0;font-size:14px;line-height:1.65}
.callout{display:flex;gap:8px;background:var(--tc);color:var(--on-tc);padding:10px 12px;border-radius:var(--rc2)}
.callout code,.mock code{font:12px var(--mono)}
.proposal{border:1.5px solid var(--p);background:var(--pc);color:var(--on-pc);border-radius:var(--rc2);padding:10px 12px;margin-top:10px}
.proposal ins{text-decoration:none;font-weight:600}
.who{display:flex;align-items:center;gap:6px;font-size:12.5px}
.agent-av{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-size:11px;font-weight:700;flex:none}
.acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.btn{font:600 13px/1 var(--body);padding:8px 14px;border-radius:999px;border:0;cursor:pointer}
.btn.primary{background:var(--p);color:var(--on-p)}
.btn.tonal{background:var(--sc);color:var(--on-sc)}
.btn.ghost{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px var(--ol)}
.btn.outline{background:var(--bg);color:var(--fg);box-shadow:inset 0 0 0 1px var(--ol)}
.btn.wide{width:100%;margin:4px 0}
.btn.sm{padding:6px 10px}
.btn.lg{padding:13px 22px;font-size:15px}
.btn.focus,.btn:focus-visible{outline:2px solid var(--p);outline-offset:2px}
.hub-side{gap:6px}
.hub-h{font:var(--dw) 16px/1 var(--display);display:flex;gap:8px;align-items:center;padding:6px 6px 10px;letter-spacing:var(--dt)}
.hub-h .mark{color:var(--p)}
.run{display:grid;grid-template-columns:22px 1fr;gap:4px 8px;padding:7px 8px;border-radius:var(--rs);background:var(--bg);border:1px solid var(--olv)}
.run b{font-size:12.5px;font-weight:600;display:block;line-height:1.3}.run small{color:var(--fg2);font-size:11.5px}
.run .status{grid-column:2;font-size:11.5px;font-weight:600}
.st-running{color:var(--orange)}.st-needs{color:var(--purple)}.st-done{color:var(--success)}
.chat{padding:14px;gap:10px;background:var(--bg)}
.msg{max-width:88%;padding:10px 12px;border-radius:var(--rc2)}
.msg.me{align-self:flex-end;background:var(--sc);color:var(--on-sc)}
.msg.bot{background:var(--cont);color:var(--fg)}
.diff{margin-top:8px;border-radius:8px;overflow:hidden;font:12px/1.7 var(--mono);border:1px solid var(--olv);background:var(--bg)}
.d-file{padding:3px 10px;color:var(--fg2);border-bottom:1px solid var(--olv)}
.d-add{padding:0 10px;background:var(--success-soft);color:var(--success-on)}
.d-del{padding:0 10px;background:var(--errc);color:var(--on-errc)}
.composer{margin-top:auto;display:flex;align-items:center;gap:8px;border:1.5px solid var(--ol);border-radius:var(--rc2);padding:8px 8px 8px 10px;background:var(--bg)}
.ctx{background:var(--sc);color:var(--on-sc);padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ph{flex:1;color:var(--fg2)}
.tile{width:18px;height:18px;border-radius:6px;flex:none}
.set{padding:18px 24px;gap:2px;max-width:560px}
.set h2{font:var(--dw) 22px/1.2 var(--display);letter-spacing:var(--dt);margin:0 0 8px}
.field{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 0;border-bottom:1px solid var(--olv)}
.field.col{flex-direction:column;align-items:flex-start}
.field b{display:block;font-weight:600}.field small{color:var(--fg2);font-size:12px}
.seg{display:flex;background:var(--cont);border-radius:999px;padding:3px;flex:none}
.seg span{padding:4px 11px;border-radius:999px;color:var(--fg2);font-weight:500}
.seg span.on{background:var(--bg);color:var(--fg);box-shadow:0 1px 2px rgb(0 0 0/.18);font-weight:600}
.switch{width:38px;height:22px;border-radius:999px;background:var(--p);position:relative;flex:none}
.switch i{position:absolute;right:3px;top:3px;width:16px;height:16px;border-radius:50%;background:var(--on-p)}
.cdots{display:flex;gap:12px;flex-wrap:wrap}
.cdot{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--fg)}
.cdot span{width:14px;height:14px;border-radius:50%}
.signin{background:linear-gradient(160deg,var(--side),var(--cont));padding:36px 16px;display:grid;place-items:center;border-radius:var(--rc);border:1px solid var(--olv)}
.signin .card{background:var(--bg);border-radius:var(--rc);padding:24px;width:min(340px,100%);box-shadow:0 1px 0 var(--olv),0 18px 40px -18px rgb(0 0 0/.35)}
.brand{display:flex;align-items:center;gap:8px;font:600 17px var(--body);letter-spacing:-.03em}
.brand .mark{color:var(--p)}
.signin h2{font:var(--dw) 26px/1.1 var(--display);letter-spacing:var(--dt);margin:18px 0 4px}
.muted{color:var(--fg2);margin:0 0 14px}
.g{display:inline-block;width:18px;font-weight:700}
.note{background:var(--warning-soft);color:var(--warning-on);border-radius:var(--rc2);padding:10px 12px;margin:10px 0;font-size:12.5px}
.note b{display:block}
.foot{display:flex;justify-content:space-between;font-size:12.5px;color:var(--fg2)}
.foot a{color:var(--s);text-decoration:underline;text-underline-offset:2px}
.hero{position:relative;overflow:hidden;border-radius:var(--rc);padding:56px 28px 48px;min-height:320px;display:flex;align-items:center}
.h-copy{position:relative;max-width:560px}
.h-title{font:var(--dw) clamp(38px,7vw,64px)/1.02 var(--display);letter-spacing:var(--dt);margin:0}
.h-title .mark.inline{width:.78em;height:.78em;vertical-align:-.06em;color:var(--hero-mark)}
.h-lede{font-size:16px;line-height:1.6;margin:16px 0 22px;max-width:46ch}
.h-acts{display:flex;gap:10px;flex-wrap:wrap}
.h-moon{position:absolute;width:300px;height:300px;border-radius:50%;right:-60px;top:-50px;opacity:.95}
.hero-dusk{padding-bottom:150px}
.h-moon.dusk{top:auto;bottom:-200px;right:-40px;width:320px;height:320px}
.hero-faience{padding-top:132px}
.h-tiles{position:absolute;left:28px;top:28px;display:grid;grid-template-columns:repeat(6,56px);gap:10px}
.h-tiles span{height:56px;border-radius:18px}
.h-tiles span:nth-child(2n){transform:translateY(14px)}
.hero-papyrus,.hero-earth,.hero-navy,.hero-midnight,.hero-midnight-sans,.hero-blueblack,.hero-black{flex-direction:column;align-items:stretch;padding-bottom:0;gap:32px}
.hero-papyrus .h-app,.hero-earth .h-app,.hero-navy .h-app,.hero-midnight .h-app,.hero-midnight-sans .h-app,.hero-blueblack .h-app,.hero-black .h-app{order:2}
.h-title em{font-style:italic;font-weight:calc(var(--dw) - 100)}
.h-app{position:relative;margin:0 0 0 auto;width:min(620px,100%);height:210px;overflow:hidden;border-radius:var(--rc) var(--rc) 0 0;box-shadow:0 -1px 0 rgb(0 0 0/.06),0 -20px 50px -20px rgb(60 40 10/.35)}
.h-app .win{min-height:300px;border-bottom:0;border-radius:var(--rc) var(--rc) 0 0;grid-template-columns:150px 1fr}
.h-app .doc{padding:16px 20px}.h-app .doc-title{font-size:24px;margin-top:0}
@media (max-width:560px){.h-app .win{grid-template-columns:1fr}}
@media (max-width:640px){.h-moon,.h-bigmark{opacity:.3}.h-tiles{grid-template-columns:repeat(4,44px)}.h-tiles span:nth-child(n+5){display:none}}
@media (prefers-reduced-motion:no-preference){.btn{transition:transform 120ms cubic-bezier(.2,.8,.2,1)}.btn:active{transform:scale(.97)}}
details{margin-top:10px}summary{cursor:pointer;color:var(--muted-foreground);font-size:13px}
table.cc{border-collapse:collapse;font-size:12px;width:100%;margin-top:8px}
table.cc td{padding:3px 6px;border-bottom:1px solid var(--border)}
table.cc td:nth-child(2),table.cc td:nth-child(3){text-align:right;font-variant-numeric:tabular-nums}
'''

def page(key):
    d, st = DIRECTIONS[key], STYLE[key]
    L, D = scheme(d, False), scheme(d, True)
    hero_html, hero_checks = hero(key, d, st)
    all_checks = [('light', *c) for c in checks(L)] + [('dark', *c) for c in checks(D)] + [('hero', *c) for c in hero_checks]
    fails = [c for c in all_checks if c[2] < c[3]]
    assert not fails, f'{key}: {fails}'
    if key == 'dusk':
        all_checks += [(m, 'proposal text / gradient end', ratio(R['on_primary_container'], R['tertiary_container']), 4.5) for m, R in (('light', L), ('dark', D))]
        assert all(c[2] >= c[3] for c in all_checks)
    worst = min(all_checks, key=lambda c: c[2] / c[3])
    base = 14
    scale = [('Display', round(base * st['ratio'] ** 7)), ('H1', round(base * st['ratio'] ** 5)), ('H2', round(base * st['ratio'] ** 4)),
             ('H3', round(base * st['ratio'] ** 2)), ('Body (page)', 16), ('UI', 14), ('Small', 12)]
    ts = ''.join(f'<div><small>{n} · {px}px</small><span style="font:{st["display_w"] if i < 4 else 400} {px}px/1.15 {st["display"] if i < 4 else st["body"]};letter-spacing:{st["display_track"] if i < 4 else "0"}">{"Thoth ทอธ" if i < 2 else "The scribe’s page · หน้าของอาลักษณ์"}</span></div>' for i, (n, px) in enumerate(scale))
    sp = ''.join(f'<div><span style="width:{s}px;height:{s}px;background:{d["primary"]}"></span>{s}</div>' for s in (4, 8, 12, 16, 24, 32, 48, 64))
    ed, hub, sett, sign = screens(key)
    vl, vd = vars_for(L), vars_for(D)
    common = f"--display:{st['display']};--body:{st['body']};--mono:'JetBrains Mono',monospace;--dw:{st['display_w']};--dt:{st['display_track']};--rc:{st['r_card']}px;--rc2:{st['r_content'] + 2}px;--rs:{st['r_content'] - 2}px;--hero-mark:{L['primary'] if not st['hero_dark'] else D['primary']}"
    cc_rows = ''.join(f'<tr><td>{m}: {h.escape(l)}</td><td>{v:.2f}</td><td>{n}</td></tr>' for m, l, v, n in all_checks)
    start = 'dark' if key in ('navy', 'midnight', 'midnight-sans', 'blueblack', 'black') else 'light'  # Papyrus Night only changes the dark theme, so it opens there
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{d["name"]} direction</title><link rel="stylesheet" href="{FONTS}"><style>{CSS}
.mock.light{{{vl}}} .mock.dark{{{vd}}} .mock{{{common}}} {' '.join('.mock ' + r.strip() + '}' for r in st['extra'].split('}') if r.strip())}</style></head>
<body><div class="dir" style="--font-body:{st['body']}">
<p class="lead"><b style="color:var(--foreground)">{d["name"]}.</b> {st["tagline"]}</p>
<p class="lead">{st["roles"]}</p>
<h2 class="sec-h">Tonal palettes</h2><p class="lead">Tones 0–100 as in Material: tone ≈ perceived lightness, so any pair 50 tones apart is about 4.5:1.</p>
{swatch_row("Primary · Moon", d["primary"])}{swatch_row("Secondary", d["secondary"])}{swatch_row("Tertiary", d["tertiary"])}{swatch_row("Neutral", d["neutral"], d.get("neutral_c"))}
<h2 class="sec-h">Roles, accents and semantic colours</h2><p class="lead">Accents keep the eight names folders and text colours already use (ADR-0037), so nothing stored changes.</p>
<div class="pair">{role_card(L, False)}{role_card(D, True)}</div>
<details><summary>All {len(all_checks)} contrast pairs pass AA (tightest: {worst[0]} {h.escape(worst[1])} at {worst[2]:.2f}:1, needs {worst[3]}:1)</summary><table class="cc">{cc_rows}</table></details>
<h2 class="sec-h">Type and spacing</h2><p class="lead">Display: {st["display"].split(",")[0]} · UI and page: Inter · Thai: {st["thai"]} · scale ratio {st["ratio"]} · radius {st["r_content"]}px in content, {st["r_card"]}px for cards, pills for actions · 4px grid.</p>
<div class="typescale">{ts}</div><div class="spacing" style="margin-top:12px">{sp}</div>
<h2 class="sec-h">Screens</h2>
<div class="modes" role="group" aria-label="Theme"><button aria-pressed="{str(start == 'light').lower()}" data-m="light">Light</button><button aria-pressed="{str(start == 'dark').lower()}" data-m="dark">Dark</button></div>
<div class="stage">
<div><div class="mock {start}">{ed}</div><p class="cap">Editor and sidebar: coloured folders and tags, Today in tertiary, an agent proposal in the primary container.</p></div>
<div><div class="mock {start}">{hub}</div><p class="cap">Agent Hub: each agent has its own accent; status has an icon and a word, never colour alone; the diff marks + and −.</p></div>
<div><div class="mock {start}">{sett}</div><p class="cap">Settings: colour tiles make sections easy to find; the focus ring shows on every control.</p></div>
<div><div class="mock {start}">{sign}</div><p class="cap">Web sign-in.</p></div>
<div><div class="mock {start}">{hero_html}</div><p class="cap">Site home hero (current copy). Decoration sits behind the text, which is checked against both ends of the background.</p></div>
</div></div>
<script>document.querySelectorAll('.modes button').forEach(b=>b.addEventListener('click',()=>{{document.querySelectorAll('.modes button').forEach(x=>x.setAttribute('aria-pressed',x===b));document.querySelectorAll('.stage .mock').forEach(m=>{{m.classList.toggle('dark',b.dataset.m==='dark');m.classList.toggle('light',b.dataset.m!=='dark')}})}}))</script>
</body></html>'''

if __name__ == '__main__':
    for key in DIRECTIONS:
        open(f'{key}.html', 'w').write(page(key)); print('wrote', key)

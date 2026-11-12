"""Layout and UX proposals (owner, 2026-11-12: "you can change web and app layout and UX/UI design too"), drawn in Papyrus Blue-Black.

python3 layout.py -> blueblack-layout.html. Colours come only from the direction's roles in palette.py, whose pairs build.py checks;
the two surfaces here are the page (ground) and surface_dim (the raised card), both already in those checks.
"""
from palette import DIRECTIONS, scheme
from build import mark, folder_icon, vars_for, CSS, FONTS, FOLDERS, STYLE

KEY = 'blueblack'
d, st = DIRECTIONS[KEY], STYLE[KEY]
L, D = scheme(d, False), scheme(d, True)
# Inset layout: the ground is the window, the page is a raised card. Light: papyrus sidebar tone as ground, paper as card.
# Dark: #00001C as ground, one step up as card. Both pairs (on-surface on surface / surface_dim) are in palette.checks.
GROUND = {'light': f"--ground:{L['surface_dim']};--card:{L['surface']}", 'dark': f"--ground:{D['surface']};--card:{D['surface_dim']}"}

tree = ''.join(f'<div class="row">{folder_icon(c)}<span>{n}</span></div>' for n, c in FOLDERS[:4])

def sidebar(sel='Launch notes'):
    return f'''<aside class="l-side" aria-label="Sidebar">
  <button class="space"><span class="av" style="background:var(--p);color:var(--on-p)">P</span><b>My notes</b><small class="badge b-local">Local</small><span class="chev" aria-hidden="true">⌄</span></button>
  <div class="quick"><button class="qbtn"><span aria-hidden="true">⌕</span>Search<kbd>⌘K</kbd></button><button class="qbtn icon" aria-label="New page">＋</button></div>
  <div class="row{' sel' if sel == 'Home' else ''}"><span class="ic" style="background:var(--cont);color:var(--fg2)">⌂</span><span>Home</span></div>
  <div class="row"><span class="ic" style="background:var(--tc);color:var(--on-tc)">☀</span><span>Today</span></div>
  <div class="row{' sel' if sel == 'Agents' else ''}"><span class="ic" style="background:var(--pc);color:var(--on-pc)">{mark(12)}</span><span>Agents</span><span class="count" aria-label="1 needs review">1</span></div>
  <div class="sec">Private Space <span class="plus" aria-hidden="true">＋</span></div>{tree}
  <div class="row{' sel' if sel == 'Launch notes' else ''}">{folder_icon("blue")}<span>Launch notes</span></div>
  <div class="sec">Acme team <small class="badge b-ws">Workspace</small></div>
  <div class="row">{folder_icon("gray")}<span>Handbook</span></div>
  <div class="live" role="status"><span class="pulse" aria-hidden="true"></span><span><b>Claude Code</b> is summarising Journal</span></div>
 </aside>'''

EDITOR = f'''<div class="lwin">
 {sidebar()}
 <div class="l-main">
  <div class="l-tabs"><span class="ltab act">Launch notes<i aria-hidden="true">×</i></span><span class="ltab">Weekly plan</span><span class="ltab">Today</span><span class="ltab new" aria-label="New tab">＋</span>
   <span class="l-tools"><button class="btn tonal sm">{mark(12)} Ask</button><button class="btn ghost sm">Share</button></span></div>
  <div class="l-body">
   <article class="l-card">
    <div class="crumbs">Private Space / Projects</div>
    <h1 class="doc-title">Launch notes</h1>
    <div class="props"><span class="tag" style="background:var(--blue-soft);color:var(--blue-on)">#meeting</span><span class="tag" style="background:var(--yellow-soft);color:var(--yellow-on)">#draft</span><span class="meta">Edited 2 min ago</span></div>
    <p>The redesign ships in three steps: tokens first, then the app, then the site.</p>
    <p class="hl">Every colour keeps AA contrast, in both themes. <span class="hl-tag">Proposed by Claude Code</span></p>
    <p lang="th"><!-- REVIEW --> บันทึกของคุณเป็นไฟล์ Markdown ในโฟลเดอร์บนเครื่องของคุณ</p>
    <div class="slash" aria-hidden="true"><span>/</span> Type to add a block</div>
   </article>
   <aside class="l-ask" aria-label="Agent panel">
    <div class="ask-h">{mark(16)}<b>Ask about this page</b><button class="x" aria-label="Close">×</button></div>
    <div class="msg me">Add a step for screenshots.</div>
    <div class="msg bot"><div class="who"><span class="agent-av" style="color:var(--p)">{mark(18)}</span><b>Claude Code</b></div>
     <p>One change, highlighted on the page.</p>
     <div class="diff"><div class="d-add">+ Step 4: screenshots before and after</div></div>
     <div class="acts"><button class="btn primary sm">Apply</button><button class="btn ghost sm">Discard</button></div></div>
    <div class="composer"><span class="ctx">@Launch notes</span><span class="ph">Ask…</span><button class="btn primary sm" aria-label="Send">↑</button></div>
   </aside>
  </div>
 </div>
</div>'''

RECENT = [('Launch notes', 'blue', '2 min'), ('Weekly plan', 'orange', '1 h'), ('Dune', 'green', 'Yesterday'), ('Pad thai', 'yellow', 'Mon')]
recent = ''.join(f'<div class="rcard"><span class="rbar" style="background:var(--{c}-dot)" aria-hidden="true"></span>{folder_icon(c)}<b>{n}</b><small>{w}</small></div>' for n, c, w in RECENT)
HOME = f'''<div class="lwin">
 {sidebar('Home')}
 <div class="l-main"><div class="l-body one"><div class="l-card home2">
  <div class="greet">{mark(36)}<h1 class="h-greet">Good evening</h1></div>
  <div class="bigask"><span class="ph">Search, or ask an agent about your notes…</span><span class="chips2"><span class="chip2">@Journal</span><span class="chip2">Summarise this week</span></span><button class="btn primary sm" aria-label="Send">↑</button></div>
  <h2 class="h-sec">Recent</h2><div class="rgrid">{recent}</div>
  <div class="two">
   <div class="panel"><h2 class="h-sec">Today</h2><div class="todo"><span class="box" aria-hidden="true"></span>Review the Reading tidy-up</div><div class="todo done"><span class="box on" aria-hidden="true">✓</span>Send weekly plan</div></div>
   <div class="panel"><h2 class="h-sec">Agent activity</h2><div class="act"><span class="st-needs">◐ Needs review</span> Codex · Tidy Reading</div><div class="act"><span class="st-running">● Running</span> Claude Code · Journal</div><div class="act"><span class="st-done">✓ Done</span> OpenCode · Release post</div></div>
  </div>
 </div></div></div>
</div>'''

RUNS = [('Claude Code', 'orange', 'Running', 'Summarise this week'), ('Codex', 'green', 'Needs review', 'Tidy the Reading folder'), ('OpenCode', 'purple', 'Done', 'Draft the release post')]
runs = ''.join(f'<div class="run{" on" if s == "Needs review" else ""}"><span class="agent-av" style="background:var(--{c}-soft);color:var(--{c}-on)">{n[0]}</span><div><b>{t}</b><small>{n}</small></div>'
               f'<span class="status st-{s.split()[0].lower()}">{"● " if s == "Running" else "◐ " if s == "Needs review" else "✓ "}{s}</span></div>' for n, c, s, t in RUNS)
FILES = [('Reading/Dune.md', '+2 −1'), ('Reading/Piranesi.md', '+1'), ('Reading/index.md', '+3 −3')]
files = ''.join(f'<div class="frow{" on" if i == 0 else ""}"><span class="fchk" aria-hidden="true">✓</span><span>{f}</span><small>{n}</small></div>' for i, (f, n) in enumerate(FILES))
HUB = f'''<div class="lwin">
 {sidebar('Agents')}
 <div class="l-main"><div class="l-body hub3">
  <div class="l-card runs"><div class="h-row"><h2 class="h-sec">Runs</h2><button class="btn primary sm">New task</button></div>{runs}</div>
  <div class="l-card convo"><div class="msg me">Tidy the Reading folder: one page per book, tagged by status.</div>
   <div class="msg bot"><div class="who"><span class="agent-av" style="background:var(--green-soft);color:var(--green-on)">C</span><b>Codex</b> · 3 files</div><p>Done. Two pages were already tagged; I left them alone.</p></div>
   <div class="composer"><span class="ph">Reply to Codex…</span><button class="btn primary sm" aria-label="Send">↑</button></div></div>
  <div class="l-card review"><h2 class="h-sec">Changes · 3 files</h2>{files}
   <div class="diff"><div class="d-file">Reading/Dune.md</div><div class="d-add">+ status: finished</div><div class="d-del">− tags: book, scifi, todo</div><div class="d-add">+ tags: book, scifi</div></div>
   <div class="acts stick"><button class="btn primary">Apply 3</button><button class="btn ghost">Discard</button></div></div>
 </div></div>
</div>'''

SIGNIN = f'''<div class="split">
 <div class="split-art" aria-hidden="true"><div class="split-mark">{mark(0)}</div><p class="split-q">Your notes.<br>Your files.</p></div>
 <div class="split-form"><div class="brand">{mark(24)}<b>Thoth</b></div>
  <h2 class="h-greet">Sign in</h2><p class="muted">Open your workspaces on the free demo server.</p>
  <button class="btn outline wide"><span class="g">G</span> Continue with Google</button>
  <button class="btn outline wide"><span class="g">⌥</span> Continue with GitHub</button>
  <div class="note"><b>Demo server</b> Accounts unused for 90 days are deleted.</div>
  <div class="foot"><span>English ▾</span><a>Use your own server</a></div></div>
</div>'''

PHONE = f'''<div class="phone"><div class="ph-top"><button class="icon-b" aria-label="Open sidebar">☰</button><b>Launch notes</b><button class="icon-b" aria-label="More">⋯</button></div>
 <div class="ph-card"><h1 class="doc-title">Launch notes</h1><div class="props"><span class="tag" style="background:var(--blue-soft);color:var(--blue-on)">#meeting</span></div>
  <p>Tokens first, then the app, then the site.</p><p class="hl">Every colour keeps AA contrast. <span class="hl-tag">Claude Code</span></p></div>
 <div class="ph-review"><span>{mark(14)} 1 change to review</span><button class="btn primary sm">Review</button></div>
 <nav class="ph-bar" aria-label="Main"><span class="on">⌂<small>Home</small></span><span>⌕<small>Search</small></span><span class="fab" aria-label="New page">＋</span><span>{mark(18)}<small>Agents</small></span><span>☰<small>Spaces</small></span></nav></div>'''

LCSS = r'''
.lwin{display:grid;grid-template-columns:232px 1fr;background:var(--ground);border-radius:var(--rc);overflow:hidden;min-height:470px;border:1px solid var(--olv)}
@media(max-width:760px){.lwin{grid-template-columns:1fr}.l-side{display:none}}
.l-side{padding:10px 8px;display:flex;flex-direction:column;gap:2px}
.space{display:flex;align-items:center;gap:8px;padding:6px;border:0;background:transparent;color:var(--fg);font:inherit;border-radius:var(--rs);text-align:left}
.space b{font-size:13.5px}.space .chev{margin-left:auto;color:var(--fg2)}
.quick{display:flex;gap:6px;margin:4px 2px 8px}
.qbtn{flex:1;display:flex;align-items:center;gap:6px;border:1px solid var(--olv);background:var(--card);color:var(--fg2);font:inherit;font-size:12.5px;padding:5px 9px;border-radius:999px}
.qbtn kbd{margin-left:auto}.qbtn.icon{flex:none;width:30px;justify-content:center;padding:5px 0;color:var(--fg)}
.qbtn:focus-visible,.space:focus-visible,.icon-b:focus-visible{outline:2px solid var(--p);outline-offset:2px}
.count{margin-left:auto;background:var(--p);color:var(--on-p);font-size:11px;font-weight:700;border-radius:999px;padding:0 7px}
.sec .plus{margin-left:auto;font-weight:400}
.live{margin-top:auto;display:flex;gap:8px;align-items:center;font-size:12px;color:var(--fg2);padding:8px;border-radius:var(--rs);background:var(--card)}
.live b{color:var(--fg)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--p);flex:none}
@media (prefers-reduced-motion:no-preference){.pulse{animation:pulse 1.8s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}}
.l-main{display:flex;flex-direction:column;min-width:0;padding:0 8px 8px 0}
@media(max-width:760px){.l-main{padding:8px}}
.l-tabs{display:flex;align-items:center;gap:2px;padding:8px 0 6px;font-size:12.5px}
.ltab{padding:5px 10px;border-radius:999px;color:var(--fg2);white-space:nowrap;display:flex;gap:8px;align-items:center}
.ltab.act{background:var(--card);color:var(--fg);font-weight:600;box-shadow:0 0 0 1px var(--olv)}
.ltab i{font-style:normal;color:var(--fg2)}
.l-tools{margin-left:auto;display:flex;gap:6px}.l-tools .mark{vertical-align:-2px;color:var(--on-sc)}
@media(max-width:560px){.ltab:not(.act){display:none}}
.l-body{flex:1;display:grid;grid-template-columns:1fr 300px;gap:8px;min-height:0}
.l-body.one{grid-template-columns:1fr}
@media(max-width:1000px){.l-body{grid-template-columns:1fr}.l-ask{display:none}}
.l-card{background:var(--card);border-radius:14px;padding:22px 32px;box-shadow:0 0 0 1px var(--olv);min-width:0}
.l-card p{font-size:14.5px;line-height:1.7;margin:8px 0;max-width:62ch}
.hl{background:linear-gradient(transparent 60%,var(--pc) 60%);color:var(--fg)}
.hl-tag{font-size:11px;font-weight:700;background:var(--pc);color:var(--on-pc);border-radius:999px;padding:1px 7px;margin-left:4px;white-space:nowrap}
.slash{margin-top:14px;color:var(--fg2);font-size:13px}.slash span{font:12px var(--mono);border:1px solid var(--olv);border-radius:5px;padding:0 5px;margin-right:6px}
.l-ask{background:var(--card);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;box-shadow:0 0 0 1px var(--olv)}
.ask-h{display:flex;gap:8px;align-items:center;font-size:13px}.ask-h .mark{color:var(--p)}
.x{margin-left:auto;background:none;border:0;color:var(--fg2);font-size:16px}
.l-ask .msg{max-width:100%;font-size:13px}.l-ask .msg p{margin:4px 0;font-size:13px}
.home2{padding:36px 40px}
.greet{display:flex;gap:12px;align-items:center}.greet .mark{color:var(--p)}
.h-greet{font:var(--dw) 30px/1.1 var(--display);letter-spacing:var(--dt);margin:0}
.bigask{margin:20px 0 26px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1.5px solid var(--ol);border-radius:18px;padding:14px 14px 14px 18px;background:var(--card)}
.bigask .ph{flex:1 1 220px;font-size:15px}
.chips2{display:flex;gap:6px;flex-wrap:wrap}.chip2{font-size:12px;font-weight:600;background:var(--sc);color:var(--on-sc);padding:3px 10px;border-radius:999px}
.h-sec{font:600 13px/1.2 var(--body);color:var(--fg2);margin:0 0 10px;letter-spacing:.01em}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:24px}
.rcard{position:relative;overflow:hidden;display:grid;gap:4px;padding:14px 14px 12px;border-radius:12px;background:var(--side);box-shadow:0 0 0 1px var(--olv)}
.rcard b{font-size:13.5px}.rcard small{color:var(--fg2);font-size:12px}
.rbar{position:absolute;inset:0 0 auto;height:4px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:640px){.two{grid-template-columns:1fr}}
.panel{background:var(--side);border-radius:12px;padding:14px;box-shadow:0 0 0 1px var(--olv)}
.todo,.act{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px}
.todo.done{color:var(--fg2);text-decoration:line-through}
.box{width:16px;height:16px;border-radius:5px;box-shadow:inset 0 0 0 1.5px var(--ol);display:grid;place-items:center;font-size:11px}
.box.on{background:var(--p);color:var(--on-p);box-shadow:none}
.act span{font-weight:600;font-size:12px;white-space:nowrap}
.hub3{grid-template-columns:240px 1fr 300px}
@media(max-width:1100px){.hub3{grid-template-columns:1fr}}
.l-card.runs,.l-card.review{padding:14px}.l-card.convo{padding:14px;display:flex;flex-direction:column;gap:10px}
.h-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.h-row .h-sec{margin:0}
.runs .run{margin-bottom:6px}.run.on{box-shadow:0 0 0 2px var(--p)}
.frow{display:grid;grid-template-columns:18px 1fr auto;gap:6px;align-items:center;font-size:12.5px;padding:5px 6px;border-radius:8px}
.frow.on{background:var(--sc);color:var(--on-sc)}.frow small{font:11px var(--mono)}
.fchk{width:16px;height:16px;border-radius:5px;background:var(--p);color:var(--on-p);display:grid;place-items:center;font-size:10px}
.stick{margin-top:12px}
.split{display:grid;grid-template-columns:1fr 1fr;min-height:440px;border-radius:var(--rc);overflow:hidden;border:1px solid var(--olv);background:var(--card)}
@media(max-width:700px){.split{grid-template-columns:1fr}.split-art{min-height:180px}}
.split-art{position:relative;overflow:hidden;background:var(--ground);padding:28px;display:flex;align-items:flex-end}
.split-mark{position:absolute;right:-90px;top:-70px;width:340px;height:340px;color:var(--p)}.split-mark .mark{width:100%;height:100%}
.split-q{position:relative;font:var(--dw) 34px/1.05 var(--display);letter-spacing:var(--dt);margin:0}
.split-form{padding:32px;display:flex;flex-direction:column;justify-content:center;max-width:380px}
.split-form .h-greet{margin:18px 0 4px}
.phone{width:320px;max-width:100%;margin:0 auto;height:600px;border-radius:36px;background:var(--ground);border:8px solid var(--side);box-shadow:0 0 0 1px var(--olv);display:flex;flex-direction:column;overflow:hidden;position:relative}
.ph-top{display:flex;align-items:center;justify-content:space-between;padding:10px 10px 6px;font-size:14px}
.icon-b{width:44px;height:44px;border:0;background:transparent;color:var(--fg);font-size:18px;border-radius:12px}
.ph-card{flex:1;margin:0 8px;background:var(--card);border-radius:18px;padding:16px;box-shadow:0 0 0 1px var(--olv)}
.ph-card p{font-size:15px;line-height:1.6}
.ph-review{margin:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--pc);color:var(--on-pc);border-radius:14px;padding:8px 8px 8px 12px;font-size:13px;font-weight:600}
.ph-review .mark{vertical-align:-2px}
.ph-bar{display:grid;grid-template-columns:repeat(5,1fr);align-items:center;padding:6px 6px 14px;background:var(--side);font-size:18px;text-align:center;color:var(--fg2)}
.ph-bar span{display:flex;flex-direction:column;align-items:center;gap:2px;min-height:44px;justify-content:center}.ph-bar small{font-size:10.5px;font-weight:600}
.ph-bar .on{color:var(--p)}.ph-bar .mark{color:inherit}
.ph-bar .fab{width:48px;height:48px;margin:0 auto;border-radius:16px;background:var(--p);color:var(--on-p);font-size:22px}
.ux{display:grid;gap:4px;margin:6px 0 0;padding-left:18px;color:var(--muted-foreground);font-size:13.5px;line-height:1.5;max-width:80ch}
.ux b{color:var(--foreground)}
'''

def section(title, body, points):
    return f'<h2 class="sec-h">{title}</h2><div class="mock {{m}}">{body}</div><ul class="ux">{"".join(f"<li>{p}</li>" for p in points)}</ul>'

SECTIONS = [
    ('1 · Editor: the page is a card on the night', EDITOR, [
        '<b>Inset layout.</b> The sidebar sits on the ground (#00001C at night, papyrus in daylight) and the page is a raised card with rounded corners, the way Notion Calendar, Arc and Linear frame content. Depth comes from one tonal step, not borders or glows.',
        '<b>Pill tabs</b> on the ground instead of a tab strip; the active tab is the only one with a card behind it.',
        '<b>Ask beside the page.</b> The agent opens as a side panel for this page, not only in a separate Hub. Its change shows <i>on the page</i> as a Moon highlight with a "Proposed by" label (words, not only colour) before you apply it.',
        '<b>Sidebar is shorter:</b> Search and New page become one pill row; Home, Today and Agents are pinned; a live line at the bottom says what an agent is doing right now.']),
    ('2 · Home: start with a question', HOME, [
        '<b>One big composer</b> (Grok bot, Notion AI home): search and asking an agent are the same box, with suggested chips.',
        '<b>Recent as cards</b> with the folder colour as a top bar, so colour helps you find a page; the name and icon still say which it is.',
        '<b>Today and Agent activity</b> side by side; each status has a symbol and a word.']),
    ('3 · Agent Hub: runs, conversation, changes', HUB, [
        '<b>Three columns:</b> runs on the left, the conversation in the middle, and a file-by-file review on the right with one "Apply 3" button. Today the review is inside the chat; here it is its own pane, so long diffs do not push the conversation away.',
        'The selected run gets a Moon ring; "Needs review" also shows as a count in the sidebar.']),
    ('4 · Web sign-in: split, with the mark at mascot scale', SIGNIN, [
        'Left half carries the brand (the Moon Ibis cropped by the edge, as Grok bot crops its face); right half is the form. On phones the art shrinks to a band above the form.']),
    ('5 · Web app on a phone', PHONE, [
        '<b>Bottom bar</b> with Home, Search, New page, Agents and Spaces: every target is at least 44px. The sidebar becomes the Spaces sheet.',
        'A pending agent change sits above the bar as one tap ("1 change to review"), so it is never missed on a small screen.']),
]

common = (f"--display:{st['display']};--body:{st['body']};--mono:'JetBrains Mono',monospace;--dw:{st['display_w']};--dt:{st['display_track']};"
          f"--rc:{st['r_card']}px;--rc2:{st['r_content'] + 2}px;--rs:{st['r_content'] - 2}px")
body = ''.join(section(t, b, p).replace('{m}', 'dark') for t, b, p in SECTIONS)
html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blue-Black layout</title><link rel="stylesheet" href="{FONTS}"><style>{CSS}{LCSS}
.mock.light{{{vars_for(L)};{GROUND['light']}}} .mock.dark{{{vars_for(D)};{GROUND['dark']}}} .mock{{{common}}}</style></head><body><div class="dir" style="--font-body:{st['body']}">
<p class="lead"><b style="color:var(--foreground)">Layout and UX, in Papyrus Blue-Black.</b> Five changes beyond colour, after Notion, Grok bot and the Awwwards apps. Proposals only: nothing here is in the app yet. Colours are the Blue-Black roles (all AA); sans headlines.</p>
<div class="modes" role="group" aria-label="Theme"><button aria-pressed="false" data-m="light">Light</button><button aria-pressed="true" data-m="dark">Dark</button></div>
<div class="stage">{body}</div></div>
<script>document.querySelectorAll('.modes button').forEach(b=>b.addEventListener('click',()=>{{document.querySelectorAll('.modes button').forEach(x=>x.setAttribute('aria-pressed',x===b));document.querySelectorAll('.stage .mock').forEach(m=>{{m.classList.toggle('dark',b.dataset.m==='dark');m.classList.toggle('light',b.dataset.m!=='dark')}})}}))</script>
</body></html>'''
open(f'{KEY}-layout.html', 'w').write(html)
print('wrote', f'{KEY}-layout.html')

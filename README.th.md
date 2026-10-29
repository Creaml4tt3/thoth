<p align="center">
  <img src="design/brand/app-icon-dark.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Thoth</h1>

<p align="center">
  จดโน้ตเป็นไฟล์ Markdown ในเครื่องคุณ แชร์เมื่อคุณต้องการ<br>
  <a href="https://thothnotes.com/th/">เว็บไซต์</a> ·
  <a href="https://thothnotes.com/th/#download">ดาวน์โหลด</a> ·
  <a href="https://thothnotes.com/app/">เว็บแอป</a> ·
  <a href="https://thothnotes.com/th/changelog/">ประวัติเวอร์ชัน</a> ·
  <a href="https://thothnotes.com/th/blog/">บล็อก</a>
</p>

<p align="center"><a href="README.md">English</a> · <b>ภาษาไทย</b></p>

<p align="center">
  <a href="https://github.com/Creaml4tt3/thoth/releases/latest"><img alt="เวอร์ชันล่าสุด" src="https://img.shields.io/github/v/release/Creaml4tt3/thoth?label=release"></a>
  <a href="LICENSE"><img alt="สัญญาอนุญาต Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="macOS, Windows, Linux" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey">
</p>

Thoth คือพื้นที่จดความรู้แบบโอเพนซอร์สที่ทำงานในเครื่องเป็นหลัก โน้ตของคุณเป็นไฟล์ Markdown ที่คุณเป็นเจ้าของ
เวิร์กสเปซสำหรับทำงานกับคนอื่นเป็นตัวเลือกเสริม รันบนเซิร์ฟเวอร์ที่ใครก็โฮสต์เองได้ และคุยกันด้วยโปรโตคอลแบบเปิด
ผู้ช่วย AI ใช้เครื่องมือบรรทัดคำสั่งที่คุณมีอยู่แล้ว และไม่มีอะไรถูกเขียนลงไฟล์จนกว่าคุณจะอนุมัติ

<p align="center">
  <a href="https://thothnotes.com/th/#video"><img src="docs/media/showcase-poster.jpg" width="820" alt="วิดีโอแนะนำ Thoth: หน้า Markdown ในโหมด Blocks พร้อมแถบด้านข้างของ Private Space คลิกเพื่อดูวิดีโอบน thothnotes.com"></a>
  <br>
  <sub>▶ <a href="https://thothnotes.com/th/#video">ดูวิดีโอแนะนำ 90 วินาที</a> (ภาษาไทยและอังกฤษ มีคำบรรยาย)</sub>
</p>

## ความสามารถ

- **โน้ตของคุณคือไฟล์** Private Space คือโฟลเดอร์ไฟล์ Markdown ในเครื่องของคุณ ใช้งานได้แม้ไม่มีอินเทอร์เน็ต
  ไม่ต้องสมัครบัญชี และเปิดอ่านด้วยโปรแกรมแก้ไขข้อความตัวไหนก็ได้ แม้วันหนึ่งคุณจะเลิกใช้ Thoth
- **Blocks และ Plain ในไฟล์เดียว** เขียนแบบบล็อกพร้อมเมนูทับ (/) และบล็อกพับได้ หรือสลับเป็น Plain เพื่อแก้ Markdown
  ตรง ๆ พร้อมพรีวิวทันที การสลับโหมดไม่ไปแตะข้อความที่คุณไม่ได้แก้
- **ย้ายโน้ตจาก Notion และ Obsidian** นำเข้าไฟล์ส่งออกจาก Notion หรือ vault ของ Obsidian ลิงก์ระหว่างหน้ายังอยู่ครบ
  และมีรายงานบอกว่าอะไรนำเข้าไม่ได้
- **เวิร์กสเปซสำหรับทำงานร่วมกัน** คัดลอกหรือย้ายหน้าและทั้งโฟลเดอร์เข้าเวิร์กสเปซเพื่อทำงานกับคนอื่น สมาชิกแต่ละคนเป็น
  เจ้าของ ผู้แก้ไข หรือผู้ดู และทุกหน้ามีประวัติเวอร์ชันก่อนหน้าเก็บไว้
- **ไม่มีการเขียนทับเงียบ ๆ** Thoth จะบันทึกก็ต่อเมื่อหน้านั้นยังเป็นฉบับเดียวกับที่คุณเปิดไว้ ถ้ามีคนหรือแอปอื่นแก้ไปก่อน
  คุณเลือกได้ว่าจะเก็บของเรา ของเขา หรือเก็บไว้ทั้งคู่
- **AI แก้ให้ แต่คุณตรวจก่อน** Agent Hub รัน Claude Code หรือ Codex ที่คุณติดตั้งเองกับหน้าที่คุณเลือก ทุกการแก้ไขที่เสนอมา
  จะแสดงเป็น diff และไม่มีอะไรถูกเขียนลงไฟล์จนกว่าคุณจะกด Apply
- **เชื่อมกับแอปอื่น** เซิร์ฟเวอร์ MCP แบบอ่านอย่างเดียวให้เครื่องมือ AI เช่น Claude Desktop หรือ Cursor ค้นและอ่านหน้าที่คุณ
  แชร์ได้ ปิดไว้จนกว่าคุณจะเปิดเอง
- **โปรโตคอลแบบเปิด** แอปกับเซิร์ฟเวอร์คุยกันผ่าน REST API ที่มีเอกสารครบ มีคำอธิบายแบบ OpenAPI และชุดทดสอบความ
  เข้ากันได้ ใครจะสร้างเซิร์ฟเวอร์หรือแอปของตัวเองก็ทำได้
- **ภาษาไทยและอังกฤษ** ทั้งในแอปและบนเว็บไซต์

## ติดตั้งแอปเดสก์ท็อป

ดาวน์โหลดเวอร์ชันล่าสุดได้ที่ **[thothnotes.com](https://thothnotes.com/th/#download)** หรือ
[GitHub releases](https://github.com/Creaml4tt3/thoth/releases/latest) แอปจะแจ้งเมื่อมีเวอร์ชันใหม่และอัปเดตตัวเองได้

| ระบบ | ไฟล์ |
| --- | --- |
| macOS 11 ขึ้นไป (Apple silicon และ Intel) | `Thoth_<version>_universal.dmg` |
| Windows x64 | `Thoth_<version>_x64-setup.exe` หรือ `Thoth_<version>_x64_en-US.msi` |
| Linux x64 | `Thoth_<version>_amd64.AppImage` หรือ `Thoth_<version>_amd64.deb` สำหรับ Debian และ Ubuntu |

ทุกเวอร์ชันมีไฟล์ `SHA256SUMS` ไว้ข้างตัวติดตั้งสำหรับตรวจไฟล์

ตัวติดตั้งยังไม่ได้เซ็นด้วยใบรับรองนักพัฒนาแบบเสียเงิน ตอนเปิดครั้งแรกจึงถูกถามหนึ่งครั้ง:

- **macOS** อาจแจ้งว่าตรวจสอบไม่ได้ว่าแอปนี้มีซอฟต์แวร์ที่เป็นอันตรายหรือไม่ ให้เปิด **System Settings → Privacy & Security**
  แล้วกด **Open Anyway**
- **Windows** SmartScreen อาจเตือนว่าไม่รู้จักผู้เผยแพร่ ให้กด **More info → Run anyway**
- **Linux AppImage** ทำให้ไฟล์รันได้ก่อน (`chmod +x Thoth_*.AppImage`) แล้วจึงเปิด

ถ้าจะใช้ผู้ช่วย AI ให้ติดตั้ง [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) หรือ
[Codex](https://github.com/openai/codex) เองแล้วลงชื่อเข้าใช้ Thoth จะหาเจอและรันให้

## ลองเว็บแอป

[เว็บแอป](https://thothnotes.com/app/) เปิดเวิร์กสเปซบน**เซิร์ฟเวอร์ทดลอง**ที่ใช้ฟรี ลงชื่อเข้าใช้ด้วย Google หรือ GitHub
เซิร์ฟเวอร์ทดลองมีข้อจำกัด (3 เวิร์กสเปซต่อบัญชี สมาชิก 10 คนและ 200 หน้าต่อเวิร์กสเปซ) บัญชีที่ไม่ได้ใช้ 90 วันจะถูกลบ
และอาจล้างข้อมูลได้ จึงควรเก็บของสำคัญไว้ใน Private Space แอปเดสก์ท็อปก็ใช้เซิร์ฟเวอร์ทดลองได้ (Settings → Servers)

## ตั้งเซิร์ฟเวอร์เอง

เป็นเซิร์ฟเวอร์ตัวเดียวกับที่รันเดโม แต่ไม่มีข้อจำกัด: คอนเทนเนอร์หนึ่งตัว (Node.js 24) กับ PostgreSQL 14 ขึ้นไป
อิมเมจสำหรับ `linux/amd64` และ `linux/arm64` อยู่ที่ `ghcr.io/creaml4tt3/thoth-server` ใช้ได้ทั้ง Docker และ Podman
และไม่ต้องโคลนโค้ด:

```sh
mkdir thoth && cd thoth
curl -fsSLO https://raw.githubusercontent.com/Creaml4tt3/thoth/main/compose.yaml
printf 'THOTH_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env   # เก็บไฟล์นี้ไว้ ฐานข้อมูลสร้างด้วยรหัสนี้
docker compose up -d                                   # หรือ podman compose up -d
docker compose exec server node src/cli.ts create-user --name "Ada"                 # พิมพ์ ID ผู้ใช้
docker compose exec server node src/cli.ts create-workspace --name "Team"           # พิมพ์ ID เวิร์กสเปซ
docker compose exec server node src/cli.ts add-member --workspace <workspace-id> --user <user-id> --role owner
docker compose exec server node src/cli.ts create-token --user <user-id> --out /data/ada.token
```

เซิร์ฟเวอร์ฟังอยู่ที่ `http://127.0.0.1:8080` ในแอปเดสก์ท็อป เปิด **Settings → Servers → Add server** ใส่ที่อยู่และโทเคน
(`docker compose cp server:/data/ada.token .`)

**มี PostgreSQL และระบบลงชื่อเข้าใช้อยู่แล้ว** (Keycloak, Authentik, Zitadel, Entra ID, Google, GitHub)? ใช้
[`compose.external.yaml`](compose.external.yaml) คู่กับไฟล์ `server.env` ที่คัดลอกจาก [`server.env.example`](server.env.example)
รันเฉพาะเซิร์ฟเวอร์ และทุกคนลงชื่อเข้าใช้ด้วยบัญชีของตัวเอง

**[คู่มือตั้งเซิร์ฟเวอร์เอง](docs/deploy/self-host.th.md)** อธิบายทั้งสองแบบทีละขั้น รวมถึง HTTPS (Caddy, nginx)
งานดูแลรายวัน การสำรองและกู้คืนข้อมูล การอัปเกรดและการล็อกเวอร์ชัน และเว็บแอปสำหรับเซิร์ฟเวอร์ของคุณ ค่าตั้งทั้งหมดอยู่ใน
[`apps/server/README.md`](apps/server/README.md) (ภาษาอังกฤษ)

## Build จากซอร์สโค้ด

ต้องมี Node 24 ขึ้นไป, [pnpm](https://pnpm.io) (`corepack enable`) และ Rust 1.90 ขึ้นไป พร้อม
[สิ่งที่ Tauri ต้องใช้](https://v2.tauri.app/start/prerequisites/) บนระบบของคุณ

```sh
git clone https://github.com/Creaml4tt3/thoth && cd thoth
pnpm install
pnpm --filter @thoth/desktop tauri dev     # รันแอปเดสก์ท็อป
pnpm --filter @thoth/desktop tauri build   # สร้างตัวติดตั้งสำหรับเครื่องนี้
```

การตรวจ:

```sh
pnpm check          # typecheck, ตรวจ schema และ OpenAPI, เทสต์ทั้งหมด
pnpm test           # เฉพาะเทสต์
pnpm e2e            # Playwright: UI จริงบน Rust host จริง (ต้องรัน npx playwright install chromium-headless-shell ก่อน)
pnpm test:server    # เซิร์ฟเวอร์กับ PostgreSQL ใน Podman
```

โครงสร้างของ repository และเอกสารการออกแบบ (ADR) เป็นภาษาอังกฤษ ดูได้ใน [README ภาษาอังกฤษ](README.md#repository-layout)
และ [docs/adr](docs/adr/README.md)

## ร่วมพัฒนา

ยินดีรับทุกการมีส่วนร่วม อ่าน [`CONTRIBUTING.md`](CONTRIBUTING.md) ก่อน: ทุกคอมมิตต้องมี DCO sign-off (`git commit -s`)
และการเปลี่ยนสิ่งที่ตัดสินใจไว้แล้วต้องมี ADR แจ้งปัญหาหรือเสนอไอเดียได้ที่
[GitHub issues](https://github.com/Creaml4tt3/thoth/issues) จะเขียนภาษาไทยก็ได้ หรือผ่านเมนู **Send feedback** ในแอป

ถ้าพบปัญหาด้านความปลอดภัย อย่าเปิด issue ให้อีเมลไปที่ **security@thothnotes.com** (ดู [`SECURITY.md`](SECURITY.md))

## สัญญาอนุญาต

[Apache-2.0](LICENSE) ดู [ADR-0011](docs/adr/0011-license-and-contribution-policy.md) สำหรับสัญญาอนุญาตและนโยบายการร่วมพัฒนา

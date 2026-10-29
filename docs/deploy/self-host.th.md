# ตั้งเซิร์ฟเวอร์ Thoth เอง

[English](self-host.md) · **ภาษาไทย**

เซิร์ฟเวอร์ Thoth เก็บเวิร์กสเปซที่แชร์กัน แอปเดสก์ท็อปใช้งานได้โดยไม่ต้องมีเซิร์ฟเวอร์ ต้องมีก็ต่อเมื่อจะทำงานกับคนอื่น
เซิร์ฟเวอร์คือคอนเทนเนอร์หนึ่งตัว (Node.js 24) กับฐานข้อมูล PostgreSQL 14 ขึ้นไป ค่าตั้งทั้งหมดอยู่ใน
[`apps/server/README.md`](../../apps/server/README.md) (ภาษาอังกฤษ)

ใช้ได้ทั้ง Docker และ Podman คำสั่งด้านล่างเขียนเป็น `docker compose` ถ้าใช้ Podman ให้พิมพ์ `podman compose` แทน

## เลือกแบบที่เหมาะกับคุณ

| คุณมี | ใช้ | การลงชื่อเข้าใช้ |
| --- | --- | --- |
| ยังไม่มีอะไร หรืออยากลองก่อน | [`compose.yaml`](../../compose.yaml): เซิร์ฟเวอร์พร้อม PostgreSQL ของตัวเอง | โทเคนจาก admin CLI หรือผู้ให้บริการด้านล่าง |
| PostgreSQL ของคุณเอง (แบบ managed หรือไม่ก็ได้) และผู้ให้บริการ OpenID Connect | [`compose.external.yaml`](../../compose.external.yaml): เฉพาะเซิร์ฟเวอร์ | ผู้ให้บริการของคุณ (Keycloak, Authentik, Zitadel, Entra ID...), Google หรือ GitHub |
| เครื่องที่มี Node.js และไม่ใช้คอนเทนเนอร์ | `node apps/server/src/main.ts` จากโค้ดที่โคลนมา | เหมือนข้างบน |

## อิมเมจ

`ghcr.io/creaml4tt3/thoth-server` สำหรับ `linux/amd64` และ `linux/arm64` ออกพร้อมทุกเวอร์ชัน:

| แท็ก | ตาม |
| --- | --- |
| `0.2.7` | เวอร์ชันนั้นเท่านั้น เหมาะกับใช้งานจริง เพราะคุณเลือกเองว่าจะขยับเมื่อไร |
| `0.2` | เวอร์ชันล่าสุดของ 0.2 |
| `latest` | เวอร์ชันล่าสุด ค่าเริ่มต้นในไฟล์ compose |

ตั้ง `THOTH_VERSION=0.2.7` (ใน shell หรือในไฟล์ `.env` ข้างไฟล์ compose) เพื่อล็อกเวอร์ชัน ถ้าโคลนโค้ดมา
`docker compose up --build -d` จะสร้างอิมเมจจากซอร์สแทน

## แบบที่ 1: เซิร์ฟเวอร์พร้อมฐานข้อมูล

ไม่ต้องโคลนโค้ด:

```sh
mkdir thoth && cd thoth
curl -fsSLO https://raw.githubusercontent.com/Creaml4tt3/thoth/main/compose.yaml
printf 'THOTH_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env   # เก็บไฟล์นี้ไว้ ฐานข้อมูลสร้างด้วยรหัสนี้
docker compose up -d
curl http://127.0.0.1:8080/api/v1/capabilities      # เซิร์ฟเวอร์ตอบ
```

จากนั้นสร้างผู้ใช้ เวิร์กสเปซ และโทเคน:

```sh
docker compose exec server node src/cli.ts create-user --name "Ada"                 # พิมพ์ ID ผู้ใช้
docker compose exec server node src/cli.ts create-workspace --name "Team"           # พิมพ์ ID เวิร์กสเปซ
docker compose exec server node src/cli.ts add-member --workspace <workspace-id> --user <user-id> --role owner
docker compose exec server node src/cli.ts create-token --user <user-id> --out /data/ada.token
docker compose cp server:/data/ada.token ./ada.token                                # ส่งให้ Ada แบบส่วนตัว
```

ในแอปเดสก์ท็อป: **Settings → Servers → Add server** ใส่ที่อยู่ของเซิร์ฟเวอร์และโทเคน ถ้าอยากให้ทุกคนลงชื่อเข้าใช้ด้วยบัญชี
แทนโทเคน ให้เพิ่มค่าการลงชื่อเข้าใช้จากแบบที่ 2 ลงใน `environment:` ของ service `server`

## แบบที่ 2: PostgreSQL และระบบลงชื่อเข้าใช้ของคุณ

```sh
mkdir thoth && cd thoth
curl -fsSLO https://raw.githubusercontent.com/Creaml4tt3/thoth/main/compose.external.yaml
curl -fsSL https://raw.githubusercontent.com/Creaml4tt3/thoth/main/server.env.example -o server.env
chmod 600 server.env      # มีรหัสผ่านฐานข้อมูลและ client secret
# แก้ server.env: DATABASE_URL, PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
docker compose -f compose.external.yaml up -d
```

- **ฐานข้อมูล** ตอนเริ่มครั้งแรก เซิร์ฟเวอร์จะสร้างตารางและรัน `CREATE EXTENSION pg_trgm` (ใช้กับการค้นหา)
  ผู้ใช้ใน `DATABASE_URL` จึงต้องมีสิทธิ์นี้ หรือให้ผู้ดูแลรันคำสั่งนี้ให้หนึ่งครั้ง ถ้าเป็นฐานข้อมูลแบบ managed ให้เติม `?sslmode=require`
- **ผู้ให้บริการลงชื่อเข้าใช้** สร้าง client แบบ confidential (authorization code flow) แล้วลงทะเบียน redirect URI
  `https://<PUBLIC_URL>/auth/callback/oidc` ส่วน Google และ GitHub ใช้ `/auth/callback/google` และ `/auth/callback/github`
  ที่อยู่ของ issuer ต้องเป็น `https`
- **บัญชี** ใครที่ผู้ให้บริการของคุณยอมให้ลงชื่อเข้าใช้ จะได้บัญชีอัตโนมัติ จากนั้นเจ้าของเวิร์กสเปซเพิ่มเขาเข้าเวิร์กสเปซ
  หรือส่งลิงก์เชิญจากในแอป
- **Connection pooler** (PgBouncer หรือโฮสต์ที่มี `-pooler`): ตั้ง `MIGRATE_ON_START=false` แล้ว migrate หนึ่งครั้งด้วย
  URL ตรง (`docker compose -f compose.external.yaml run --rm -e DATABASE_URL=<direct url> server node src/cli.ts migrate`)
  และตั้ง `DATABASE_POOL_MAX` ให้น้อย

ไม่ใช้คอนเทนเนอร์: ในโค้ดที่โคลนมา รัน `pnpm install --prod --filter @thoth/server...` ตั้งตัวแปรชุดเดียวกัน แล้วรัน
`node apps/server/src/main.ts`

## HTTPS

เซิร์ฟเวอร์ใช้ HTTP ธรรมดาที่ `127.0.0.1:8080` ให้วาง reverse proxy ไว้ข้างหน้า และตั้ง `TRUST_PROXY=true` เพื่อให้การจำกัด
ต่อ IP เห็นผู้ใช้จริง การอัปเดตสดใช้ server-sent events ซึ่งเซิร์ฟเวอร์ส่ง `X-Accel-Buffering: no` ให้ nginx อยู่แล้ว
ถ้าใช้ [Caddy](https://caddyserver.com) ซึ่งขอใบรับรองให้เอง:

```caddyfile
thoth.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

ถ้าใช้ nginx ให้ตั้ง `proxy_buffering off;` และ `proxy_read_timeout 1h;` สำหรับ `/api/v1/workspaces/*/events` (หรือทั้งเว็บ) ด้วย

## งานดูแลรายวัน

ลบเวอร์ชันเก่าของหน้า (เฉพาะเมื่อตั้ง `REVISION_RETENTION_DAYS`) ลบเวิร์กสเปซที่ถูกลบไปแล้วเกิน 30 วัน และล้างข้อมูลการลงชื่อเข้าใช้
และการจำกัดอัตราที่หมดอายุ ไม่มีอะไรรันให้อัตโนมัติ ให้ตั้งเวลารันทุกวัน เช่นด้วย cron:

```sh
15 3 * * *  cd /srv/thoth && docker compose exec -T server node src/cli.ts maintenance
```

## สำรองข้อมูล

ข้อมูลอยู่สองที่: ฐานข้อมูล และ volume `blobs` (ไฟล์แนบ ไม่ใช้ถ้าตั้ง `BLOB_STORE=postgres`)

```sh
# สำรอง (แบบที่ 1 ถ้าใช้ฐานข้อมูลของคุณเอง ใช้ระบบสำรองของผู้ให้บริการ หรือ pg_dump กับฐานข้อมูลนั้น)
docker compose exec -T postgres pg_dump -U thoth -Fc thoth > thoth-$(date +%F).dump
docker compose exec -T server tar -C /data -cz blobs > blobs-$(date +%F).tar.gz

# กู้คืนลงเครื่องที่ติดตั้งใหม่ ก่อนที่ใครจะเริ่มใช้
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U thoth -d thoth --clean --if-exists < thoth-2026-10-29.dump
docker compose up -d server
docker compose exec -T server tar -C /data -xz < blobs-2026-10-29.tar.gz
```

ไฟล์แนบเก็บตามค่าแฮชของเนื้อหา ดังนั้นถ้าสำรองไฟล์แนบหลังสำรองฐานข้อมูล จะได้ครบเสมอ

## อัปเกรด

อ่าน[ประวัติเวอร์ชัน](../../CHANGELOG.th.md) สำรองข้อมูล แล้วรัน:

```sh
docker compose pull && docker compose up -d     # แบบที่ 2 ให้เติม -f compose.external.yaml
```

เซิร์ฟเวอร์จะ migrate ฐานข้อมูลให้ตอนเริ่ม (ทุก migration จนถึงตอนนี้เป็นแบบเพิ่มอย่างเดียว) ถ้าตั้ง `MIGRATE_ON_START=false`
ให้รัน `node src/cli.ts migrate` ด้วย URL ตรงก่อน ถ้าล็อก `THOTH_VERSION` ไว้ เวอร์ชันจะขยับก็ต่อเมื่อคุณเปลี่ยนค่าเอง

## เว็บแอปสำหรับเซิร์ฟเวอร์ของคุณ

เว็บแอปบน thothnotes.com ใช้ได้กับเซิร์ฟเวอร์ทดลองเท่านั้น ถ้าจะมีเว็บแอปสำหรับเซิร์ฟเวอร์ของคุณ ให้ build ด้วยที่อยู่เซิร์ฟเวอร์
แล้วให้บริการ `apps/web/dist` ที่ `/app/` บนเว็บของคุณ:

```sh
VITE_DEFAULT_SERVER=https://thoth.example.org pnpm --filter @thoth/web build
```

จากนั้นตั้ง `WEB_REDIRECT_URIS=https://<เว็บของคุณ>/app/callback` และ `CORS_ORIGINS=https://<เว็บของคุณ>` บนเซิร์ฟเวอร์

## ความปลอดภัย

- `server.env` และ `.env` มีข้อมูลลับ ให้ตั้งเป็น `chmod 600` และอย่าใส่ใน git (repository นี้ไม่รวม `server.env` อยู่แล้ว)
- ไฟล์ compose เปิดเซิร์ฟเวอร์ไว้ที่ `127.0.0.1` เท่านั้น และไม่เปิด PostgreSQL ที่มากับมาออกไปข้างนอกเลย
- คอนเทนเนอร์รันด้วยผู้ใช้ `node` ที่ไม่มีสิทธิ์พิเศษ
- ถ้าพบปัญหาด้านความปลอดภัย ให้อีเมลไปที่ security@thothnotes.com ([`SECURITY.md`](../../SECURITY.md)) อย่าเปิด issue

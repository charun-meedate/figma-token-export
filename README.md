# figma-token-export

Claude Code Skill สำหรับ **ดึง design token จาก Figma มาเป็นโค้ด** — Flutter / Web / DTCG
เลือกปลายทางได้ต่อโปรเจกต์

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
        (MCP/REST)  (commit ไว้ใน repo)              (commit ไว้ใน repo)
```

`tokens.json` คือสัญญากลาง — commit ทั้งตัวมันและโค้ดที่ generate เพราะ diff ของ token
คือสิ่งที่ดีไซเนอร์กับ dev รีวิวร่วมกันได้ ส่วน diff ของโค้ดคือหลักฐานว่าการเปลี่ยนแปลงลงจริง

## อ่านไฟล์ไหนดี

| คุณคือ | อ่าน |
|---|---|
| อยากได้ token จาก Figma มาใช้ในโค้ด | [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) · [English](docs/GETTING-STARTED.en.md) |
| ต้องรันสคริปต์เอง / ตั้ง CI / แก้ skill | [docs/MAINTAINING.md](docs/MAINTAINING.md) · [English](docs/MAINTAINING.en.md) |

## ติดตั้งลงโปรเจกต์

```bash
git clone git@github.com:charun-meedate/figma-token-export.git ~/dev/figma-token-export
cd ~/dev/figma-token-export

./install.sh ~/dev/my-project           # copy เข้า .claude/skills/ ของโปรเจกต์
./install.sh ~/dev/my-project --link    # symlink แทน (อัปเดตตาม git pull อัตโนมัติ)
./install.sh --global                   # ลง ~/.claude/skills/ ใช้ได้ทุกโปรเจกต์
```

- **copy** — เหมาะกับโปรเจกต์ที่ commit `.claude/skills/` เข้า git ทุกคนในทีมได้เวอร์ชันเดียวกันแน่นอน
- **`--link`** — เหมาะกับเครื่องตัวเอง ได้ของใหม่ทันทีที่ `git pull` แต่คนอื่นใน repo ไม่ได้ไปด้วย
- **`--global`** — ใช้ได้ทุกโปรเจกต์บนเครื่องตัวเอง แต่ทีมไม่เห็น

เปิด Claude Code ในโปรเจกต์แล้วสั่งได้เลย skill จะถูกเรียกเอง:

> เอา design token จากไฟล์นี้มาใส่โปรเจกต์ให้หน่อย เป็น CSS + TypeScript
> https://www.figma.com/design/xxxx/DS?node-id=1643-43256

## โครงสร้าง

```
README.md                    ไฟล์นี้
install.sh                   ติดตั้ง skill เข้าโปรเจกต์
docs/                        เอกสารสำหรับคน — แยกตามคนใช้ / คนดูแล
skills/figma-token-export/   ตัว skill
├── SKILL.md                 ไฟล์ที่ Claude Code โหลด
├── figma-token-export.md    คู่มือฉบับเต็ม
├── references/              รายละเอียดแยกหัวข้อ โหลดเมื่อจำเป็น
├── evals/                   ชุดทดสอบพฤติกรรม 3 อัน
└── scripts/                 โค้ดจริง ไม่มี dependency (Node 18+)
```

## เช็คว่าเครื่องพร้อม

```bash
node skills/figma-token-export/scripts/selftest.mjs
```

รันทั้ง pipeline บนข้อมูลตัวอย่างในโฟลเดอร์ชั่วคราว ไม่แตะโปรเจกต์ไหน
ต้องขึ้น `all checks passed`

สถานะการทดสอบทั้งหมดบันทึกไว้ที่เดียว ใน
[docs/MAINTAINING.md → สถานะการทดสอบ](docs/MAINTAINING.md#สถานะการทดสอบ)

## ข้อจำกัดที่ต้องรู้

Plan ของทีมเป็น **Organization** ไม่ใช่ Enterprise — scope `file_variables:read`
เป็น Enterprise-only ดังนั้น `GET /v1/files/:key/variables` ใช้ไม่ได้ทั้งอ่านและเขียน
ทางที่ใช้ได้จริงอยู่ในตารางท้าย [docs/MAINTAINING.md](docs/MAINTAINING.md)

## แก้ skill

รัน `selftest.mjs` (สคริปต์ยังถูก) **และ** eval ใน `skills/figma-token-export/evals/`
(agent ยังเดินกระบวนการถูก) — คนละเรื่องกัน ทั้งสองอย่างต้องผ่าน

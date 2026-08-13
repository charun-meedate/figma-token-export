# figma-token-export

Claude Code Skill สำหรับ **ดึง design token จาก Figma มาเป็นโค้ด** — Flutter / Web / DTCG
เลือกปลายทางได้ต่อโปรเจกต์

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
        (MCP/REST)  (commit ไว้ใน repo)              (commit ไว้ใน repo)
```

`tokens.json` คือสัญญากลาง — commit ทั้งตัวมันและโค้ดที่ generate เพราะ diff ของ token
คือสิ่งที่ดีไซเนอร์กับ dev รีวิวร่วมกันได้ ส่วน diff ของโค้ดคือหลักฐานว่าการเปลี่ยนแปลงลงจริง

> ชื่อใน Figma ยังไม่ตรงมาตรฐาน? แก้ก่อน export — เพราะที่นี่ชื่อใน Figma กลายเป็นชื่อใน
> โค้ดตรง ๆ [figma-rename](https://github.com/charun-meedate/figma-rename) ทำหน้าที่นั้น
> แล้วส่งต่อมาที่ skill นี้

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

## Claude จะถามอะไรคุณ

**ก่อนดึงอะไรทั้งนั้น** Claude จะสำรวจก่อน — ไฟล์ Figma มีหน้าอะไรบ้าง ลิงก์ที่ให้มา
ชี้ไปโหนดที่มี token ผูกอยู่หรือเปล่า — แล้วถาม **2 ข้อ**

**ข้อ 1 — จะเอาลง target ไหน** ปกติเดาจากโปรเจกต์ได้เอง จะถามเมื่อไม่ชัด

| เลือก | ได้อะไร |
|---|---|
| **web** | `tokens.css` (ค่าจริงตอนรัน) + `tokens.ts` (typed mirror) + คลาสต่อ text style |
| **flutter** | `AppColors` · `AppSpacing` · `AppTypography` · `AppShadows` — `static const` ล้วน |
| **dtcg** | JSON มาตรฐาน W3C สำหรับ Style Dictionary, Tokens Studio หรือ import กลับเข้า Figma |

**ข้อ 2 — จะเอา mode ไหนบ้าง** — ข้อนี้ถามทุกครั้ง ไม่มีข้าม

| เลือก | ผลที่ตามมา |
|---|---|
| **light อย่างเดียว** | ดึงรอบเดียวจบ |
| **light + dark** | ต้องดึง **2 รอบ** และมีคนสลับ mode ใน Figma คั่นกลาง |
| **default ที่เปิดอยู่** | เร็วสุด แต่ผลขึ้นกับว่าตอนนั้นใครเปิด mode ไหนค้างไว้ |

> **ตอบข้อนี้ให้ชัดตั้งแต่แรก** Figma ส่งค่าให้ได้ทีละ mode เท่านั้น — **เพิ่ม dark ทีหลัง
> โดยไม่กลับไปที่ Figma ไม่ได้** ตอบผิดคือเสียเวลาหนึ่งรอบเต็ม

**ข้อ 3 — ถามเฉพาะตอนที่ลิงก์ใช้ไม่ได้:** ขอลิงก์แบบ *Copy link to selection* ที่เฟรม
เพราะ Figma ให้อ่าน variable เฉพาะที่ผูกอยู่ในโหนดที่ระบุ ลิงก์หน้าเปล่ามักไม่มีอะไรผูกอยู่

**หลังรอบแรก** ถ้าโปรเจกต์เป็นแอป Claude จะเสนอให้ตัดเหลือเฉพาะชั้น semantic
แทนที่จะยัด primitive ทั้งพันตัวที่ไม่ควรมีใครเรียกตรง ๆ — ตอบรับหรือปฏิเสธก็ได้

## จังหวะที่คนต้องลงมือเอง

Claude จะ**หยุดรอ** ตรงนี้ ไม่เดินต่อเอง

1. **สลับ mode ใน Figma** ระหว่างดึงรอบที่สอง — สคริปต์ทำแทนไม่ได้ Figma คืนค่าเฉพาะ
   คอลัมน์ที่เปิดอยู่
2. **ชื่อ token ที่ชนกัน** — สองชื่อใน Figma ที่แปลงเป็นชื่อในโค้ดแล้วซ้ำกัน ต้องให้ดีไซน์
   เปลี่ยนชื่อหนึ่งอัน แก้ที่ฝั่งโค้ดไม่ได้
3. **สองหน้าที่นิยาม token เดียวกันคนละค่า** — extraction บันทึกว่าขัดกันแล้วหยุด
   ไม่เลือกให้เอง คนในทีมดีไซน์เป็นเจ้าของคำตอบนั้น

## สิ่งที่ skill นี้จะไม่ทำ

- **ไม่เดา node id** ถ้าไม่มีลิงก์ จะขอ ไม่ใช่สุ่มลอง
- **ไม่ทิ้ง token เงียบ ๆ** อะไรที่จัดประเภทไม่ได้ไปอยู่ใน `other` แล้วถูกพิมพ์ออกมาให้เห็นทุกครั้ง
- **ไม่เชื่อม alias จากการเดา** ค่าที่ตรงกับ primitive หลายตัวจะไม่เชื่อมและรายงานว่าทำไม
- **ไม่ export effect ที่แปลงไม่ได้บางส่วน** shadow ที่มี layer blur ปนจะถูกปฏิเสธทั้งก้อน
  ดีกว่าได้เงาที่ดีไซเนอร์ไม่ได้วาด
- **ไม่แก้ไฟล์ที่ generate แล้ว** ถ้าค่าผิด ต้นตออยู่ที่ `tokens.json` หรือที่ generator

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

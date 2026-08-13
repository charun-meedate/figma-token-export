# คู่มือคนดูแล skill

> ภาษาไทย · [English](MAINTAINING.en.md)
> แค่อยากได้ token ไปใช้ ไม่ต้องอ่านไฟล์นี้ → [GETTING-STARTED.md](GETTING-STARTED.md)

ไฟล์นี้สำหรับคนที่ต้องรันสคริปต์เอง ตั้ง CI แก้บั๊ก หรือแก้ตัว skill
สมมติว่าคุณอ่าน `skills/figma-token-export/figma-token-export.md` (คู่มือหลัก) แล้ว

## สารบัญ

- [โครงสร้าง](#โครงสร้าง) — pipeline, ไฟล์อยู่ที่ไหน
- [รันสคริปต์เอง](#รันสคริปต์เอง) — `$S` และตารางคำสั่ง
- [หา node id](#หา-node-id-ตอนตั้งโปรเจกต์ใหม่) — ตอนตั้งโปรเจกต์ใหม่
- [config ขั้นต่ำ](#config-ขั้นต่ำ)
- [อ่านผล verify](#อ่านผล-verify) — `other`, `(unassigned)`, อัตรา alias
- [ตารางแก้ปัญหา](#ตารางแก้ปัญหา)
- [ข้อจำกัดที่ยืนยันแล้ว](#ข้อจำกัดที่ยืนยันแล้ว) — plan tier, REST, DTCG
- [สถานะการทดสอบ](#สถานะการทดสอบ) — **แหล่งเดียวของเรื่องนี้**
- [Shadow ทำงานยังไง](#shadow-ทำงานยังไง-v110)
- [ชื่อที่ชนกัน](#ชื่อที่ชนกัน)
- [แก้ตัว skill](#แก้ตัว-skill) — selftest, เพิ่มปลายทาง, เพิ่มกลุ่ม token
- [อ่านต่อ](#อ่านต่อ)

---

## โครงสร้าง

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
        (MCP/REST)  (commit ไว้)                     (commit ไว้)
```

`tokens.json` คือสัญญากลาง เปลี่ยนวิธีดึงได้โดยไม่ต้องแตะ generator
เพิ่มปลายทางใหม่ = เพิ่มไฟล์เดียวใน `scripts/lib/targets/`

**สคริปต์อยู่ใน skill ข้อมูลอยู่ในโปรเจกต์** — `tokens.config.json`,
`tokens/tokens.json`, `dumps/`, โค้ดที่ generate อยู่ในโปรเจกต์ทั้งหมด
และ resolve จากตำแหน่งของ `tokens.config.json` ไม่ใช่ cwd เลยรันจากไหนก็ได้ รวมถึง CI

```
skills/figma-token-export/
├── SKILL.md                     ไฟล์ที่ Claude Code โหลด (frontmatter + ชี้ไปคู่มือ)
├── figma-token-export.md        คู่มือฉบับเต็ม — เนื้อหาหลักอยู่ที่นี่
├── references/                  รายละเอียดแยกตามหัวข้อ (โหลดเมื่อจำเป็น)
└── scripts/                     โค้ดจริง ไม่มี dependency (Node 18+)
    ├── sync.mjs                 คำสั่งประจำวัน: extract → diff → verify → generate
    ├── normalize-mcp.mjs        MCP dump → tokens.json
    ├── fetch-rest.mjs           REST → tokens.json
    ├── verify.mjs               ตรวจ tokens.json + จับ identifier ชนกัน
    ├── generate.mjs             tokens.json → โค้ด (+ --check สำหรับ CI)
    ├── selftest.mjs             ทดสอบทั้ง pipeline
    ├── tokens.config.example.json
    └── lib/
```

---

## รันสคริปต์เอง

```bash
cd ~/dev/my-project
S=".claude/skills/figma-token-export/scripts"          # ติดตั้งเข้าโปรเจกต์
# S="$HOME/.claude/skills/figma-token-export/scripts"  # ติดตั้งแบบ --global

node "$S/verify.mjs"     # ยังไม่มี config จะ error — แต่ต้องไม่ใช่ "module not found"
```

`Cannot find module` = `$S` ผิด แก้ตรงนี้ก่อนอย่างอื่น นี่คือสาเหตุที่คนพลาดบ่อยที่สุด
เขียน path นี้ลง README ของโปรเจกต์ด้วย

| คำสั่ง | ทำอะไร |
|---|---|
| `node "$S/selftest.mjs"` | รันทั้ง pipeline บน fixture ในโฟลเดอร์ชั่วคราว (ดู [สถานะการทดสอบ](#สถานะการทดสอบ)) |
| `node "$S/normalize-mcp.mjs" dumps/*.json` | dump → `tokens.json` |
| `node "$S/verify.mjs"` | ตรวจก่อน generate + พิมพ์ namespace / layer / `other` |
| `node "$S/generate.mjs"` | `tokens.json` → โค้ด |
| `node "$S/generate.mjs" --check` | exit 1 ถ้าโค้ดที่ commit ไม่ตรงกับ tokens.json (**ใส่ใน CI**) |
| `node "$S/sync.mjs" dumps/*.json` | 4 ตัวบนรวมกัน + พิมพ์ diff (คำสั่งประจำวัน) |

`sync` รับประกัน 2 อย่าง: (1) verify fail แล้ว `tokens.json` ถูก restore
โค้ดไม่ถูกแตะ (2) ปฏิเสธ `--target`/`--layers`/`--modes` เพราะ rebuild
บาง target จะทำให้ target อื่นค้างเก่า

---

## หา node id (ตอนตั้งโปรเจกต์ใหม่)

`get_variable_defs` อ่านเฉพาะ variable ที่ผูกใน subtree ของโหนดที่ส่งไป
และ **ต้องเป็น id ของเฟรม ไม่ใช่ของหน้า** (ส่งหน้าไปจะได้
`You currently have nothing selected`)

MCP `get_metadata` list หน้าได้ไม่ครบกับบางไฟล์ (เจอเคสที่เห็นแค่หน้า cover)
**ใช้ REST แทน** — ต้องมี token scope `file_content:read` เท่านั้น:

```bash
set -a && . ./.env && set +a      # FIGMA_ACCESS_TOKEN, FIGMA_FILE_ID

# ทุกหน้าในไฟล์
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/$FIGMA_FILE_ID?depth=1" \
  | jq -r '.document.children[] | "\(.id)  \(.name)"'

# เฟรมบนหน้าหนึ่ง
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/$FIGMA_FILE_ID/nodes?ids=96954:6258&depth=1" \
  | jq -r '.nodes[].document.children[] | "\(.id)  \(.name)"'
```

```
0:1          🟩 color
96954:6258   🟩 spacing
     ↓
96967:499    Spacing-Overview        ← node id ที่ต้องใส่ใน config
```

เอา id ที่ได้ใส่ `figma.mcp.nodes` แล้ว dump ของแต่ละโหนดเซฟเป็น
`dumps/<ชื่อ>.json` แบบดิบ ๆ ไม่ต้องจัดรูปแบบ — **commit `dumps/` ด้วย**
มันคือสิ่งที่ทำให้รันซ้ำได้ผลเดิม

---

## config ขั้นต่ำ

```jsonc
{
  "figma": {
    "fileKey": "kQ8mR2xJ7vNbL4wYtZcHpA",        // ส่วนที่ตามหลัง /design/ ใน URL
    "mcp": { "nodes": ["96967:499", "0:1"] }
  },
  "tokensPath": "tokens/tokens.json",
  "targets": [{ "type": "web", "out": "src/tokens" }]
}
```

ตัวเลือกทั้งหมดอยู่ใน `scripts/tokens.config.example.json` พร้อมคำอธิบายในตัว
รอบแรกไม่ต้องยุ่งกับ `layers` / `aliasLinking` / `modeSelectors` — default คือ export ทุกอย่าง

---

## อ่านผล verify

**`other` ไม่ใช่ error** — คือของที่จัดประเภทไม่ได้ จึงไม่ export
ส่วนใหญ่จะเป็น `(consumed by a typography composite)` = ชิ้นส่วนของ text style
ที่ถูกรวมเข้า style แล้ว **ปกติ** แต่ถ้ามี token ที่ควรได้ไปโผล่ที่นี่
= ตัวแปลงอ่านไม่ออก ต้องแก้ที่ extractor ไม่ใช่มองข้าม

**`(unassigned)` ในส่วน layers ก็ไม่ใช่ error** — ไม่มี glob ไหนแมตช์
แต่ยัง export ปกติ จะหายไปเฉพาะเมื่อ target เลือก layer เจาะจง

**`aliasLinking`** ดูอัตราส่วน `linked / ambiguous / unmatched` ก่อนเปิด
ระบบดีไซน์ที่สะอาดจะได้ใกล้ 100% ถ้า ambiguous เยอะ = palette มีค่าซ้ำกันเอง
เชื่อมไปก็เป็นการเดา ให้ปิดไว้

---

## ตารางแก้ปัญหา

| ขึ้นข้อความว่า | สาเหตุ | แก้ |
|---|---|---|
| `Cannot find module .../verify.mjs` | `$S` ผิด | ดูหัวข้อ "รันสคริปต์เอง" |
| `You currently have nothing selected` | ส่ง id ของหน้า ไม่ใช่เฟรม | ดูหัวข้อ "หา node id" |
| `get_metadata` เห็นแค่หน้า cover | ข้อจำกัดของ MCP กับบางไฟล์ | list หน้าด้วย REST |
| `403` จาก REST `/variables` | `file_variables:read` เป็น Enterprise-only | ใช้ MCP ดึง variable |
| `Identifier collision in …` | ชื่อ token 2 อันยุบเป็นชื่อเดียว | ให้ดีไซน์เปลี่ยนชื่อ อย่าแก้ที่ generator |
| `the selection matched 0 tokens` | glob ใน `layers`/`include` ไม่ตรงของจริง | `verify.mjs` ดู namespace ที่มีอยู่ |
| `aliasLinking is strict and N …` | palette มีค่าซ้ำ เดาไม่ได้ | ปิด `strict` หรือปิด `aliasLinking` |
| `mode "dark" ... not in tokens.json` | ยังไม่เคยดึง mode นั้น | mode = การดึงแยกรอบ ดู `references/modes.md` |
| Effect ตัวไหนไป `other` | parser เจอ layer ที่ไม่ใช่ drop/inner shadow | ตั้งใจให้ปฏิเสธทั้ง token ดูหัวข้อ shadow |

`selftest.mjs` ผ่านแต่โปรเจกต์พัง = ปัญหาอยู่ที่ config หรือ dump ไม่ใช่ที่ skill

---

## ข้อจำกัดที่ยืนยันแล้ว

**Plan ของทีมเป็น Organization ไม่ใช่ Enterprise** — scope `file_variables:read`
เป็น Enterprise-only ดังนั้น `GET /v1/files/:key/variables` ใช้ไม่ได้ทั้งอ่านและเขียน

| ต้องการ | ใช้ |
|---|---|
| อ่าน Variables | MCP `get_variable_defs` |
| อ่าน published styles | REST `/v1/files/:key/styles` |
| list หน้า/เฟรม | REST `/v1/files/:key?depth=1` |
| เขียน Variables กลับเข้า Figma | native DTCG JSON import (target `dtcg`) |

**REST path ไม่ได้ shadow** — `fetch-rest.mjs` อ่านแค่ published FILL/TEXT style
ทีมที่ตั้ง CI ด้วย REST จะได้ 0 shadow แบบเงียบ ๆ

---

## สถานะการทดสอบ

**นี่คือที่เดียวที่บันทึกเรื่องนี้** อย่าคัดลอกตัวเลขไปไว้ที่อื่น — ก่อนหน้านี้มีสามที่
แล้วสองที่ค้างอยู่ที่ผลก่อน v1.1.0 จนบอกว่า Flutter ตรวจแล้วทั้งที่ยังไม่ได้ตรวจ

| อะไร | สถานะ |
|---|---|
| `selftest.mjs` | 134 assertion ผ่านหมด |
| Web (`tokens.ts`) | `tsc --strict` สะอาด บน token ชุด production 615 สี |
| Flutter | `dart analyze` → `No issues found` (ดูรายละเอียดข้างล่าง) |
| Tailwind v4 | ตรวจกับ design system production 225 token — **ตรง byte ทุกบรรทัด** |
| Tailwind v3 | ตรวจกับ `tailwind.config.js` production — utility 40/41 ตรง (ดูข้างล่าง) |
| DTCG | **ยังไม่เคยให้ tool ปลายทางอ่านจริง** |
| alias linking | 261/261 เชื่อมได้ ไม่มีกำกวม ไม่มี `var()` ลอย |

`selftest.mjs` รัน CLI จริงในโฟลเดอร์ชั่วคราวแล้ว assert กับ output จริง — colour
normalization, `Font(...)` / `Effect(...)`, identifier collision, การแบ่ง namespace,
layer selection, alias linking (รวม ambiguous / strict / dangling), modes,
sync rollback ตอน verify fail (tokens.json เหมือนเดิมเป๊ะ โค้ดไม่ถูกแตะ),
diff ที่เปลี่ยนเฉพาะ dark mode และ `--check` ทั้งตอนตรงและตอนถูกแก้มือ

**Flutter** — generate จาก token ชุด production (615 สี / 72 dimension /
51 text style / 4 shadow) แล้วรัน `dart analyze` ได้ `No issues found`
ครอบคลุมทั้งสองทางที่เพิ่มใน v1.1.0: `AppShadows` (`List<BoxShadow>`) และ
`AppTypographyScale` (คลาสที่ถูกเปลี่ยนชื่อเพราะชนกับ text style)

**Tailwind v4** — generate จาก design system production (225 semantic token) แล้ว
เทียบกับ `insure.css` ที่ทีมเขียนมือ: บล็อก `@theme inline` ตรง **225/225** และ
`:root` ตรงแบบ byte ทั้ง 225 บรรทัดเมื่อใช้ `colorFormat: "hex"` — เปลี่ยนมาใช้
pipeline ได้โดยหน้าจอไม่ขยับ ต่างแค่ 3 token ที่โปรเจกต์เพิ่มเองและไม่มีใน Figma

**Tailwind v3** — generate จาก token 42 ตัวของโปรเจกต์ production แล้ว `require()`
ไฟล์ `.cjs` เทียบกับ `theme.extend.colors` ที่เขียนมือ: utility **40 จาก 41 ตรง**
รวมทั้งค่าที่ชี้ (`var(--…)` ตัวเดียวกัน) — โดย 11 ตัวต่างกันแค่การสะกด
เพราะโปรเจกต์ใช้ `_` ในคีย์ (`primary-soft_light`) ส่วนที่ generate ใช้ `-`
การเปลี่ยนมาใช้จึงต้อง rename utility ในคอมโพเนนต์ (งานของ `figma-rename`)
อีก 1 ตัวไม่ตรงเพราะคีย์ในคอนฟิกสะกด `grey` แต่ตัวแปรที่ชี้สะกด `gray`

**DTCG** — ผลลัพธ์ตรงตาม spec และผ่าน assertion ใน selftest แต่ยังไม่มีใครเอาไป
ให้ Style Dictionary หรือ Tokens Studio อ่านจริง ทีมแรกที่ใช้ช่วยรายงานกลับด้วย

**ค้างไว้ (v4)** — บล็อก mode override เขียน root var ของ shadow ที่ไม่มี utility
ไหนอ่าน เพราะ `@theme` ถือ literal อยู่แล้ว ฝั่ง v3 ไม่มีปัญหานี้เพราะชี้ root var
ตรง ๆ ถ้าจะแก้ v4 ให้ใช้วิธีเดียวกัน ทำได้แต่ยังไม่จำเป็น

**ยังไม่มี eval ระดับพฤติกรรม agent** — `selftest.mjs` ทดสอบว่า*สคริปต์*ทำงานถูก
ไม่ได้ทดสอบว่า skill ถูกเรียกถูกจังหวะและเดินครบทุกขั้น เป็นคนละเรื่องกัน

---

## Shadow ทำงานยังไง (v1.1.0)

Figma ส่ง effect มาเป็นสตริง หลายชั้นคั่นด้วย `; `:

```
Effect(type: DROP_SHADOW, color: color/shadow/md/edge, offset: (0, shadow/edge/offset-y), radius: shadow/edge/radius, spread: 0); Effect(...)
```

กลายเป็น token กลุ่ม `shadow` ที่ `$value` เป็น **array ของ layer** ไม่ยุบเป็นชั้นเดียว
แต่ละ layer เก็บ `colorRef` ไว้ ผลลัพธ์จึงชี้กลับไปที่ token สีได้:

```css
--shadow-md: 0 0 1px 0 var(--color-shadow-md-edge), 0 8px 24px -4px var(--color-shadow-md-ambient);
```

**ปฏิเสธมากกว่าเดา:** stack ที่มี layer ที่ไม่ใช่ drop/inner shadow (เช่น
`LAYER_BLUR`) จะถูกโยนทั้ง token ลง `other` เพราะ export เฉพาะบางชั้น =
ได้ผลที่ดีไซเนอร์ไม่ได้วาด · ฝั่ง Flutter ข้าม inset shadow พร้อมคอมเมนต์
`// SKIPPED` เพราะ `BoxShadow` ไม่มี inset

ไวยากรณ์ `Effect(...)` เดามาจากตัวอย่าง 2 ไฟล์ ถ้าเจอ field แปลก ๆ มันจะไม่
export ค่าผิดออกมา แต่จะไปโผล่ใน `other` ให้เห็น

---

## ชื่อที่ชนกัน

ระบบดีไซน์ที่มีทั้ง `typography/font-size/*` (dimension) และ text style
จะอยากได้ชื่อ `typography` สองครั้ง — text style ได้ชื่อนั้นไป
ส่วน dimension scale กลายเป็น `typographyScale` (`AppTypographyScale` ใน Dart)
เป็น rename แบบ deterministic และเกิดเฉพาะตอนชนจริง

ชนแบบที่ suffix แก้ไม่ได้ ยังโยน error เหมือนเดิม — ตัวนี้ทำให้ error แคบลง ไม่ได้ซ่อน

---

## แก้ตัว skill

```bash
node skills/figma-token-export/scripts/selftest.mjs    # ต้องผ่านก่อนและหลังทุกครั้ง
```

ครอบคลุมอะไรบ้างดูที่ [สถานะการทดสอบ](#สถานะการทดสอบ)

**เพิ่มปลายทางใหม่:** เขียน `scripts/lib/targets/<name>.mjs` export
`generate<Name>(set, target) → [{ file, contents }]` แล้วลงทะเบียนใน
`generate.mjs` + `verify.mjs` รายละเอียดใน `references/tokens-schema.md`

**เพิ่มกลุ่ม token ใหม่:** แก้ `EXPORTED_GROUPS` ใน `scripts/lib/dtcg.mjs`
ที่เดียว — filter / modes / diff / verify เดินตามค่านี้หมด

อัปเดตเวอร์ชันใน `scripts/package.json` ด้วย มันถูกประทับใน header ของทุกไฟล์
ที่ generate เวลาผลลัพธ์ดูแปลก คำถามแรกคือ "เวอร์ชันไหนสร้าง"

---

## อ่านต่อ

| ไฟล์ | เรื่อง |
|---|---|
| `skills/figma-token-export/figma-token-export.md` | คู่มือหลัก อ่านให้ครบก่อนแก้อะไร |
| `references/extraction-mcp.md` | เลือกโหนดให้ครอบ token ครบ |
| `references/extraction-rest.md` | REST, scope, CI |
| `references/modes.md` | light/dark |
| `references/layers.md` | export เฉพาะบางชั้น + Figma collection |
| `references/alias-linking.md` | semantic → primitive |
| `references/tokens-schema.md` | สัญญาของ `tokens.json` + เพิ่มปลายทาง |
| `references/target-web.md` · `target-flutter.md` | รูปแบบผลลัพธ์ + ต่อกับ theme |

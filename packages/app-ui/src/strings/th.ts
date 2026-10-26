/** Thai UI text. Same keys as `en.ts`; written for Thai readers, not word for word. */
import type { Strings } from "./en.ts";

const count = (n: number) => n.toLocaleString("th-TH");

export const th: Strings = {
  lang: "th",
  name: "ไทย",

  editor: {
    status: { idle: "", dirty: "ยังไม่ได้บันทึก", saving: "กำลังบันทึก…", saved: "บันทึกแล้ว", error: "บันทึกไม่สำเร็จ" },
    modeGroup: "โหมดแก้ไข",
    modeSwitchTitle: "สลับโหมดแก้ไข (Ctrl/Cmd+Shift+E)",
    modes: {
      blocks: { label: "บล็อก", hint: "จัดรูปแบบเป็นบล็อก แบบ Notion" },
      plain: { label: "ข้อความล้วน", hint: "พิมพ์ Markdown และเห็นผลทันที แบบ Obsidian" },
    },
    breadcrumb: "ตำแหน่งของหน้า",
    retry: "ลองอีกครั้ง",
    copySaved: { before: "เก็บฉบับของคุณไว้เป็น ", after: " แล้ว" },
    openIt: "เปิดดู",
    changedAgain: {
      disk: "ไฟล์บนดิสก์เปลี่ยนอีกครั้ง ลองดูฉบับล่าสุดแล้วเลือกใหม่",
      server: "หน้านี้บนเซิร์ฟเวอร์เปลี่ยนอีกครั้ง ลองดูฉบับล่าสุดแล้วเลือกใหม่",
    },

    insertBlock: "แทรกบล็อก",
    noMatchingBlocks: "ไม่พบบล็อกที่ตรงกัน",
    blockMenu: "เมนูบล็อก",
    turnInto: "เปลี่ยนเป็น",
    duplicate: "ทำสำเนา",
    delete: "ลบ",
    moveUp: "เลื่อนขึ้น",
    moveDown: "เลื่อนลง",
    handleLabel: "ลากเพื่อย้าย หรือคลิกเพื่อเปิดเมนูบล็อก",
    handleTitle: "ลากเพื่อย้าย · คลิกเพื่อเปิดเมนู",
    linkToPage: "ลิงก์ไปยังหน้า",
    linkAlias: (alias) => `ชื่อเรียกอื่น “${alias}”`,
    linkNoMatch: (query) => `ไม่มีหน้าที่ตรงกับ “${query}” พิมพ์ต่อเพื่อลิงก์ไปยังหน้าใหม่`,
    linkNoPages: "ยังไม่มีหน้าอื่น",
    fold: (collapsed, toggle) => `${collapsed ? "กาง" : "พับ"}${toggle ? "บล็อกพับได้" : "กล่องเน้นข้อความ"}`,
    preserved: (kind) => `${kind === "html" ? "HTML" : kind === "math" ? "สูตรคณิตศาสตร์" : "Markdown"} · เก็บไว้ตามต้นฉบับ`,
    preservedTitle: "เก็บไว้ตามต้นฉบับ",
    linkAmbiguous: (candidates) => `ตรงกับหลายหน้า: ${candidates}`,
    linkUnresolved: (target) => `ยังไม่มีหน้าชื่อ "${target}"`,
    linkState: { resolved: "เปิดหน้า", ambiguous: "ลิงก์ที่ตรงกับหลายหน้า", unresolved: "ลิงก์ที่ยังไม่มีหน้า" },
    embed: "ฝัง · ",
    done: "เสร็จแล้ว",

    styles: {
      toolbar: "จัดรูปแบบข้อความ",
      bold: "ตัวหนา",
      italic: "ตัวเอียง",
      underline: "ขีดเส้นใต้",
      strike: "ขีดฆ่า",
      code: "โค้ดในบรรทัด",
      link: "ลิงก์",
      color: "สีข้อความ",
      highlight: "ไฮไลต์",
      colorMenu: "สีข้อความ",
      colorNames: { default: "ค่าเริ่มต้น", gray: "เทา", brown: "น้ำตาล", orange: "ส้ม", yellow: "เหลือง", green: "เขียว", blue: "น้ำเงิน", purple: "ม่วง", red: "แดง" },
      linkAddress: "ที่อยู่ลิงก์",
      linkPlaceholder: "วางลิงก์ หรือพิมพ์ที่อยู่ของหน้า",
      linkApply: "ใช้",
      linkRemove: "เอาลิงก์ออก",
      linkInvalid: "ที่อยู่ต้องขึ้นต้นด้วย http, https, mailto หรือ tel หรือเป็นที่อยู่ของหน้า",
      withShortcut: (label, shortcut) => `${label} (${shortcut})`,
    },

    // Link previews (ADR-0020). Strings marked REVIEW are the least certain.
    linkCard: {
      label: (name) => `ตัวอย่างลิงก์: ${name}`,
      loading: "กำลังโหลดตัวอย่าง…",
      load: "โหลดตัวอย่าง",
      loadHint: "การโหลดตัวอย่างจะทำให้เว็บไซต์รู้ว่าคุณเปิดดู", // REVIEW
      options: "ตัวเลือกของตัวอย่างลิงก์",
      showAsLink: "แสดงเป็นลิงก์", // REVIEW
      open: "เปิด",
      copy: "คัดลอกลิงก์",
    },

    blocks: {
      text: { title: "ข้อความ", description: "ย่อหน้าธรรมดา" },
      h1: { title: "หัวข้อ 1", description: "หัวข้อใหญ่ของส่วน" },
      h2: { title: "หัวข้อ 2", description: "หัวข้อขนาดกลาง" },
      h3: { title: "หัวข้อ 3", description: "หัวข้อย่อย" },
      bullet: { title: "รายการแบบจุด", description: "รายการที่มีจุดนำหน้า" },
      numbered: { title: "รายการแบบตัวเลข", description: "รายการที่มีเลขลำดับ" },
      todo: { title: "รายการสิ่งที่ต้องทำ", description: "ติดตามงานด้วยช่องติ๊ก" },
      toggle: { title: "บล็อกพับได้", description: "บล็อกที่พับเก็บและกางออกได้" },
      callout: { title: "กล่องเน้นข้อความ", description: "ทำให้ข้อความเด่นขึ้นมา" },
      quote: { title: "คำพูดอ้างอิง", description: "ยกคำพูดมาอ้างอิง" },
      code: { title: "โค้ด", description: "บล็อกสำหรับโค้ด" },
      divider: { title: "เส้นคั่น", description: "คั่นเนื้อหาให้แยกกันชัดเจน" },
    },
  },

  conflict: {
    text: {
      disk: { title: "หน้านี้ถูกเปลี่ยนบนดิสก์", side: "บนดิสก์", changed: "ถูกแก้ไขจากนอก Thoth", deleted: "ถูกลบหรือย้ายจากนอก Thoth", group: "ฉบับบนดิสก์" },
      server: { title: "หน้านี้ถูกเปลี่ยนบนเซิร์ฟเวอร์", side: "บนเซิร์ฟเวอร์", changed: "ถูกคนอื่นแก้ไข", deleted: "ถูกลบบนเซิร์ฟเวอร์", group: "ฉบับบนเซิร์ฟเวอร์" },
    },
    intro: (what) => ` ${what} ระหว่างที่คุณยังมีส่วนที่แก้ไขแต่ไม่ได้บันทึก ยังไม่มีอะไรถูกเขียนทับ เลือกว่าจะเก็บฉบับไหน`,
    yourEdits: "ที่คุณแก้ไข",
    differences: (group) => `ความต่างระหว่าง${group}กับที่คุณแก้ไข`,
    chooseToContinue: "เลือกหนึ่งข้อเพื่อไปต่อ",
    choices: {
      disk: {
        mine: { title: "ใช้ของฉัน", hint: "แทนที่ไฟล์บนดิสก์ด้วยเนื้อหาในตัวแก้ไข" },
        theirs: { title: "ใช้ฉบับบนดิสก์", hint: "โหลดไฟล์จากดิสก์ใหม่ และทิ้งส่วนที่ฉันแก้แต่ยังไม่ได้บันทึก" },
        both: { title: "เก็บไว้ทั้งคู่", hint: "บันทึกฉบับของฉันเป็นสำเนาแยกไว้ แล้วโหลดไฟล์จากดิสก์ใหม่" },
      },
      server: {
        mine: { title: "ใช้ของฉัน", hint: "แทนที่ฉบับบนเซิร์ฟเวอร์ด้วยเนื้อหาในตัวแก้ไข" },
        theirs: { title: "ใช้ฉบับบนเซิร์ฟเวอร์", hint: "โหลดฉบับบนเซิร์ฟเวอร์ และทิ้งส่วนที่ฉันแก้แต่ยังไม่ได้บันทึก" },
        both: { title: "เก็บไว้ทั้งคู่", hint: "บันทึกฉบับของฉันเป็นหน้าใหม่ในเวิร์กสเปซนี้ แล้วโหลดฉบับบนเซิร์ฟเวอร์" },
      },
    },
  },

  modal: { close: "ปิด" },

  workspace: {
    badge: (name) => `เวิร์กสเปซ · ${name}`,
    badgeShort: "เวิร์กสเปซ",
    onServer: (workspace, server) => `${workspace} บน ${server}`,
    readOnly: (name) => `คุณมีสิทธิ์ดูอย่างเดียวใน ${name} จึงแก้ไขหน้านี้ไม่ได้`,
    missingTitle: "หน้านี้ไม่มีแล้ว",
    missingDetail: "หน้านี้ถูกลบบนเซิร์ฟเวอร์ หรือคุณไม่มีสิทธิ์เข้าถึงแล้ว",
    pageFallback: "หน้า",
    couldNotLoad: "โหลดเวิร์กสเปซนี้ไม่ได้",
    loading: "กำลังโหลด…",
    noPages: "ยังไม่มีหน้า",
    pagesIn: (name) => `หน้าใน ${name}`,
    newPageIn: (name) => `หน้าใหม่ใน ${name}`,
    newPage: "หน้าใหม่",
    newPageTitle: "ไม่มีชื่อ",
    creating: "กำลังสร้าง…",
  },

  tree: {
    rename: "เปลี่ยนชื่อ",
    renameLabel: (title) => `เปลี่ยนชื่อ ${title}`,
    menuLabel: (title) => `การทำงานของ ${title}`,
    newPageInside: "หน้าใหม่ข้างใน",
    newFolderInside: "โฟลเดอร์ใหม่ข้างใน",
    moveUp: "เลื่อนขึ้น",
    moveDown: "เลื่อนลง",
    moveTo: "ย้ายไปที่…",
    share: "แชร์…",
    folder: "โฟลเดอร์",
    itemCount: (n) => (n === 0 ? "ว่างเปล่า" : `${count(n)} รายการ`),
    movedTo: (title, position, total) => `ย้าย ${title} ไปลำดับที่ ${count(position)} จาก ${count(total)}`,
    movedInto: (title, folder) => `ย้าย ${title} เข้าไปใน ${folder} แล้ว`,
    movedToTop: (title) => `ย้าย ${title} ไประดับบนสุดแล้ว`,
    renamed: (title) => `เปลี่ยนชื่อเป็น ${title} แล้ว`,
    renameFailed: (detail) => `เปลี่ยนชื่อไม่สำเร็จ: ${detail}`,
    moveFailed: (detail) => `ย้ายไม่สำเร็จ: ${detail}`,
    orderUnavailable: "เซิร์ฟเวอร์นี้เก็บลำดับที่กำหนดเองไม่ได้ จึงเรียงหน้าตาม A–Z และเรียงใหม่ไม่ได้",
    newFolderTitle: "โฟลเดอร์ใหม่",
    newFolder: "โฟลเดอร์ใหม่",
    newFolderIn: (name) => `โฟลเดอร์ใหม่ใน ${name}`,
    newFolderFailed: (detail) => `สร้างโฟลเดอร์ไม่สำเร็จ: ${detail}`,
    nameProblem: {
      reserved: "ชื่อนี้ถูกสงวนไว้",
      invalid: "ชื่อห้ามมี : * ? \" < > | หรืออักขระควบคุม ห้ามลงท้ายด้วยจุด และห้ามเป็นชื่อระบบ เช่น CON",
      tooLong: "ชื่อยาวเกินไป",
    },
    renameDialog: {
      title: (name) => `เปลี่ยนชื่อ “${name}”`,
      name: "ชื่อใหม่",
      rename: "เปลี่ยนชื่อ",
      cancel: "ยกเลิก",
      empty: "ตั้งชื่อก่อน",
      invalid: "ชื่อห้ามมี / หรือ \\",
      exists: "มีสิ่งที่ใช้ชื่อนี้อยู่แล้ว",
    },
    moveDialog: {
      title: (name) => `ย้าย “${name}” ไปที่…`,
      destination: "ย้ายเข้าไปใน",
      topLevel: "ระดับบนสุด",
      move: "ย้าย",
      cancel: "ยกเลิก",
    },
    across: {
      copyTo: (name) => `คัดลอกไปที่ ${name}…`,
      moveTo: (name) => `ย้ายไปที่ ${name}…`,
      privateSpace: "Private Space",
      viewer: (workspace) => `คุณเป็นผู้ดูใน ${workspace}`, // REVIEW
      noTransfers: (server) => `${server} ไม่รับการโอนย้าย`, // REVIEW
      exportRestricted: (workspace) => `${workspace} ไม่อนุญาตให้คัดลอกหรือย้ายหน้าออกไป`,
      signedOut: (server) => `เข้าสู่ระบบ ${server} ก่อน`, // REVIEW
    },
  },

  // ลิงก์สาธารณะแบบอ่านอย่างเดียว (ADR-0023). Strings marked REVIEW are the least certain.
  share: {
    title: (name) => `แชร์ “${name}”`,
    intro: "ทุกคนที่มีลิงก์จะอ่านหน้านี้และหน้าย่อยข้างในได้ แต่แก้ไขหรือแสดงความคิดเห็นไม่ได้ และไม่ต้องลงชื่อเข้าใช้",
    expiry: "ลิงก์จะใช้ไม่ได้หลังจาก", // REVIEW
    days: (n) => `${n} วัน`,
    never: "ไม่มีกำหนด", // REVIEW
    create: "สร้างลิงก์",
    creating: "กำลังสร้าง…",
    newLink: "ลิงก์สาธารณะ",
    copy: "คัดลอกลิงก์",
    copied: "คัดลอกลิงก์แล้ว",
    copyFailed: "คัดลอกไม่ได้ เลือกลิงก์แล้วคัดลอกเอง",
    onlyOnce: "คัดลอกไว้ตอนนี้ ลิงก์จะแสดงเพียงครั้งนี้ครั้งเดียว สร้างลิงก์ใหม่ได้ทุกเมื่อ", // REVIEW
    active: "ลิงก์ที่ใช้งานอยู่",
    none: "ไม่มีลิงก์ที่ใช้งานอยู่",
    loading: "กำลังโหลดลิงก์…",
    created: (date) => `สร้างเมื่อ ${date}`,
    expires: (date) => `ใช้ได้ถึง ${date}`, // REVIEW
    neverExpires: "ใช้ได้ตลอด", // REVIEW
    revoke: "เพิกถอน", // REVIEW
    revokeLabel: (date) => `เพิกถอนลิงก์ที่สร้างเมื่อ ${date}`, // REVIEW
    revoked: "เพิกถอนลิงก์แล้ว ลิงก์นี้ใช้ไม่ได้อีก", // REVIEW
    failed: (detail) => `สร้างลิงก์ไม่ได้: ${detail}`,
    listFailed: (detail) => `โหลดลิงก์ไม่ได้: ${detail}`,
    revokeFailed: (detail) => `เพิกถอนลิงก์ไม่ได้: ${detail}`, // REVIEW
    done: "เสร็จ",
  },

  limits: {
    pages: (n) => `${count(n)} หน้าต่อเวิร์กสเปซ`,
    members: (n) => `สมาชิก ${count(n)} คนต่อเวิร์กสเปซ`,
    workspaces: (n) => `${count(n)} เวิร์กสเปซต่อบัญชี`,
    attachmentsPerWorkspace: (size) => `ไฟล์แนบรวม ${size} ต่อเวิร์กสเปซ`,
    perAttachment: (size) => `ไฟล์แนบไม่เกิน ${size} ต่อไฟล์`,
    perPage: (size) => `ไม่เกิน ${size} ต่อหน้า`,
    retention: (n) => `เก็บฉบับเก่าของแต่ละหน้าไว้ ${count(n)} วัน`,
    bytes: (n) => `${count(n)} ไบต์`,
  },

  /** ตัวเลือกธีม (การตั้งค่าบนเดสก์ท็อป, ส่วนบัญชีบนเว็บ) */
  theme: { label: "ธีม", light: "สว่าง", dark: "มืด", system: "ตามระบบ" },

  /** รายการปุ่มลัด (Cmd/Ctrl+/) และพาเลตคำสั่ง (ADR-0016 ข้อ 7) */
  keyboard: {
    title: "ปุ่มลัด",
    intro: "ทุกคำสั่งใช้ได้ด้วยแป้นพิมพ์ กด Ctrl/Cmd+K แล้วพิมพ์ > เพื่อหาคำสั่งตามชื่อ",
    close: "ปิด",
    groups: { general: "ทุกที่", assistant: "ผู้ช่วย Thoth", tabs: "แท็บ", tree: "ต้นไม้หน้า", editor: "ตัวแก้ไข" },
    webDiffers: "บนแอปเดสก์ท็อปใช้ปุ่มอื่น",
    desktopDiffers: "บนเว็บใช้ปุ่มอื่น",
    webNote: "เบราว์เซอร์เก็บบางปุ่มไว้ใช้เอง (แท็บใหม่ ปิดแท็บ สลับแท็บ) เวอร์ชันเว็บจึงใช้ปุ่มเหล่านี้แทน หากต่างกัน จะแสดงปุ่มของแอปเดสก์ท็อปไว้ด้วย",
    desktopKeys: (keys) => `แอปเดสก์ท็อป: ${keys}`,
    webKeys: (keys) => `เว็บ: ${keys}`,
    searchOrCommands: "ค้นหาหน้า หรือพิมพ์ > เพื่อใช้คำสั่ง",
    palette: {
      hint: "พิมพ์ > เพื่อใช้คำสั่ง เช่น “> หน้าใหม่”",
      commands: "คำสั่ง",
      noCommands: "ไม่พบคำสั่งที่ตรงกัน",
    },
    commands: {
      newPage: "หน้าใหม่",
      newPageIn: (workspace) => `หน้าใหม่ใน ${workspace}`,
      newFolder: "โฟลเดอร์ใหม่",
      newFolderIn: (workspace) => `โฟลเดอร์ใหม่ใน ${workspace}`,
      rename: "เปลี่ยนชื่อหน้า",
      moveTo: "ย้ายไปที่…",
      moveUp: "ย้ายหน้าขึ้น",
      moveDown: "ย้ายหน้าลง",
      share: "แชร์หน้า…",
      theme: (name) => `เปลี่ยนธีม: ${name}`,
      settings: "เปิดการตั้งค่า",
      ask: "ถาม Thoth",
      assistantSize: "ย่อหรือขยายผู้ช่วย", // REVIEW
      assistantSettings: "เปิดการตั้งค่าผู้ช่วย",
      notifications: "แสดงการแจ้งเตือน",
      newTab: "แท็บใหม่",
      closeTab: "ปิดแท็บ",
      nextTab: "แท็บถัดไป",
      previousTab: "แท็บก่อนหน้า",
      goToTab: (label) => `ไปที่แท็บ: ${label}`,
      moveTabLeft: "ย้ายแท็บไปทางซ้าย",
      moveTabRight: "ย้ายแท็บไปทางขวา",
      moveTabToWindow: "ย้ายแท็บไปหน้าต่างใหม่", // REVIEW
      toggleMode: "สลับระหว่างโหมดบล็อกและโหมดข้อความล้วน",
      shortcuts: "แสดงปุ่มลัด",
      format: (style) => `จัดรูปแบบ: ${style}`,
      color: (name) => `สีข้อความ: ${name}`,
    },
    names: {
      "palette.open": "ค้นหาหน้า หรือพิมพ์ > เพื่อใช้คำสั่ง",
      "shortcuts.open": "แสดงปุ่มลัด",
      "settings.open": "เปิดการตั้งค่า",
      "page.new": "หน้าใหม่",
      "folder.new": "โฟลเดอร์ใหม่",
      "theme.cycle": "เปลี่ยนธีม (สว่าง มืด ตามระบบ)",
      "tab.new": "แท็บใหม่",
      "tab.close": "ปิดแท็บ",
      "tab.next": "แท็บถัดไป",
      "tab.previous": "แท็บก่อนหน้า",
      "tab.jump": "ไปยังแท็บที่ 1–9 (9 คือแท็บสุดท้าย)",
      "tab.openNew": "เปิดหน้าในแท็บใหม่",
      "tab.move": "ย้ายแท็บไปทางซ้ายหรือขวา",
      "tab.menu": "เปิดเมนูของแท็บ",
      "tree.move": "เลื่อนระหว่างหน้าและโฟลเดอร์",
      "tree.expand": "เปิดหรือปิดโฟลเดอร์",
      "tree.open": "เปิดหน้า",
      "tree.rename": "เปลี่ยนชื่อ",
      "tree.reorder": "ย้ายหน้าขึ้นหรือลง",
      "tree.menu": "เปิดเมนูของหน้า",
      "editor.save": "บันทึกทันที",
      "editor.mode": "สลับระหว่างโหมดบล็อกและโหมดข้อความล้วน",
      "editor.blockMenu": "เมนูบล็อก",
      "editor.blockMove": "ย้ายบล็อกขึ้นหรือลง",
      "style.bold": "ตัวหนา",
      "style.italic": "ตัวเอียง",
      "style.underline": "ขีดเส้นใต้",
      "style.strike": "ขีดฆ่า",
      "style.code": "โค้ดในบรรทัด",
      "style.highlight": "ไฮไลต์",
      "style.link": "ลิงก์",
      "style.toolbar": "ไปที่แถบเครื่องมือจัดรูปแบบ",
      "dialog.close": "ปิดกล่องโต้ตอบหรือเมนู",
      "assistant.ask": "ถาม Thoth (เปิดกล่องข้อความของผู้ช่วย)", // REVIEW
      "assistant.size": "ย่อหรือขยายผู้ช่วย", // REVIEW
    },
  },

  /** แท็บเหนือหน้า (ADR-0016 ข้อ 5) */
  sidebar: {
    resize: "ปรับความกว้างแถบด้านข้าง", // REVIEW
    resizeHint: "ลากเพื่อปรับขนาด ดับเบิลคลิกหรือกด Enter เพื่อคืนค่าเดิม", // REVIEW
  },

  // Notifications (ADR-0018). Strings marked REVIEW are the least certain.
  notifications: {
    bell: "การแจ้งเตือน",
    bellUnread: (n) => `การแจ้งเตือน ยังไม่ได้อ่าน ${count(n)} รายการ`,
    heading: "การแจ้งเตือน",
    empty: "ยังไม่มีการแจ้งเตือน งานของเอเจนต์ การคัดลอกหรือย้าย การนำเข้า และการบันทึกที่ขัดกันจะแสดงที่นี่", // REVIEW
    markAllRead: "ทำเครื่องหมายว่าอ่านแล้วทั้งหมด",
    clear: "ล้าง",
    unread: "ยังไม่ได้อ่าน",
    pages: (first, more) => (more === 0 ? first : `${first} และอีก ${count(more)} หน้า`),
    agentReview: "การแก้ไขพร้อมให้ตรวจแล้ว", // REVIEW
    agentFinished: "เอเจนต์ทำงานเสร็จโดยไม่ได้แก้ไขอะไร", // REVIEW
    agentFailed: (reason) => `งานล้มเหลว: ${reason}`, // REVIEW
    failures: {
      notSignedIn: (agent) => `${agent} ยังไม่ได้ลงชื่อเข้าใช้`,
      billing: (agent) => `${agent} ต้องใช้แพ็กเกจแบบเสียเงินหรือเครดิต`, // REVIEW
      rateLimit: (agent) => `${agent} ใช้งานถึงขีดจำกัดแล้ว`, // REVIEW
      modelNotFound: (agent) => `${agent} ไม่รู้จักโมเดลนั้น`, // REVIEW
      error: (agent) => `${agent} หยุดทำงานเพราะเกิดข้อผิดพลาด`,
    },
    agentLimitTime: "งานหยุดเพราะถึงเวลาที่กำหนด", // REVIEW
    agentLimitBudget: "งานหยุดเพราะถึงวงเงินที่กำหนด", // REVIEW
    agentLimitReview: "ยังตรวจงานที่ทำไปแล้วได้", // REVIEW
    transferDone: (mode, where) => (mode === "copy" ? `คัดลอกไปที่ ${where} แล้ว` : `ย้ายไปที่ ${where} แล้ว`),
    transferFailed: (mode, where) => (mode === "copy" ? `คัดลอกไปที่ ${where} ไม่สำเร็จ` : `ย้ายไปที่ ${where} ไม่สำเร็จ`),
    privateSpace: "Private Space",
    importDone: "นำเข้าเสร็จแล้ว",
    importFailed: "นำเข้าเสร็จแล้ว แต่มีข้อผิดพลาด", // REVIEW
    importBody: (pages, folder) => `${count(pages)} หน้าใน ${folder}`,
    saveConflict: (page) => `${page} ถูกแก้ไขที่อื่นระหว่างที่คุณกำลังแก้ไข`, // REVIEW
    saveConflictBody: "เลือกฉบับที่จะเก็บไว้",
    update: (version) => `Thoth ${version} ออกแล้ว`, // REVIEW
    updateBody: "เปิดเพื่อดาวน์โหลด ดูว่ามีอะไรใหม่ หรือข้ามเวอร์ชันนี้", // REVIEW
  },

  tabs: {
    list: "หน้าที่เปิดอยู่",
    new: "แท็บใหม่",
    close: "ปิดแท็บ",
    blank: "แท็บใหม่",
    settings: "การตั้งค่า",
    untitled: "ไม่มีชื่อ",
    loading: "กำลังโหลด…",
    menu: (label) => `แท็บ: ${label}`,
    moveLeft: "ย้ายแท็บไปทางซ้าย",
    moveRight: "ย้ายแท็บไปทางขวา",
    moveToWindow: "ย้ายแท็บไปหน้าต่างใหม่", // REVIEW
    movedTo: (label, position, total) => `ย้าย ${label} ไปลำดับที่ ${count(position)} จาก ${count(total)}`,
    movedToWindow: (label) => `ย้าย ${label} ไปหน้าต่างใหม่แล้ว`, // REVIEW
    releaseForWindow: "ปล่อยเพื่อเปิดในหน้าต่างใหม่", // REVIEW
  },

  web: {
    loading: "กำลังโหลด…",
    signInTitle: "เข้าสู่ระบบ Thoth",
    signInLead: "เขียนและแชร์หน้าต่าง ๆ ในเวิร์กสเปซบนเซิร์ฟเวอร์ทดลองของ Thoth",
    signInWith: (provider) => `เข้าสู่ระบบด้วย ${provider}`,
    signingIn: "กำลังเข้าสู่ระบบ…",
    noProviders: "เซิร์ฟเวอร์นี้ไม่เปิดให้เข้าสู่ระบบจากเบราว์เซอร์",
    signInFailed: {
      access_denied: "การเข้าสู่ระบบถูกยกเลิก หรือตอนนี้เซิร์ฟเวอร์ยังไม่รับบัญชีใหม่",
      state: "การเข้าสู่ระบบนี้ไม่ได้เริ่มจากหน้านี้ หรือใช้เวลานานเกินไป ลองใหม่อีกครั้ง",
      exchange: "เซิร์ฟเวอร์ไม่ยอมรับการเข้าสู่ระบบครั้งนี้ ลองใหม่อีกครั้ง",
      generic: "เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง",
    },
    unreachable: "ติดต่อเซิร์ฟเวอร์ Thoth ไม่ได้ ตรวจดูการเชื่อมต่อแล้วลองใหม่",
    tryAgain: "ลองอีกครั้ง",
    signOut: "ออกจากระบบ",
    privacy: "ความเป็นส่วนตัว",
    cookieSettings: "ตั้งค่าคุกกี้",
    knownAs: " หรือ",
    signingOut: "กำลังออกจากระบบ…",
    signedInAs: (name) => `เข้าสู่ระบบในชื่อ ${name}`,
    caution: "เซิร์ฟเวอร์ทดลองใช้ฟรี มีข้อจำกัดการใช้งาน บัญชีที่ไม่ได้ใช้ 90 วันจะถูกลบ และอาจมีการล้างข้อมูลทั้งหมด จึงควรเก็บสำเนาของงานสำคัญไว้เสมอ",
    limitsTitle: "ข้อจำกัดของเซิร์ฟเวอร์นี้:",
    workspaces: "เวิร์กสเปซ",
    noWorkspaces: "คุณยังไม่ได้อยู่ในเวิร์กสเปซใดเลย",
    search: "ค้นหา",
    searchLabel: (workspace) => `ค้นหาใน ${workspace}`,
    searchPlaceholder: "ค้นหาหน้า",
    searchNone: "ไม่พบหน้าที่ตรงกัน",
    searchHint: "พิมพ์เพื่อค้นหาในเวิร์กสเปซนี้",
    nothingOpen: "ยังไม่ได้เปิดหน้าไหน",
    nothingOpenHint: "เลือกหน้าทางซ้าย หรือกด หน้าใหม่ เพื่อเริ่มเขียน",
    language: "ภาษา",
    sessionEnded: "คุณออกจากระบบแล้ว การเข้าสู่ระบบอีกครั้งจะออกจากหน้านี้ หากมีข้อความที่ยังไม่ได้บันทึก ให้คัดลอกเก็บไว้ก่อน",
    signInAgain: "เข้าสู่ระบบอีกครั้ง",
    sidebar: "แถบด้านข้าง",
    pages: "หน้า",
    settingsView: {
      title: "การตั้งค่า",
      account: "บัญชี",
      appearance: "หน้าตา",
      themeHint: "สว่าง มืด หรือตามระบบของคุณ",
      languageHint: "ภาษาของเมนูและป้ายต่าง ๆ",
      keyboard: "แป้นพิมพ์",
      keyboardNote: "ทุกคำสั่งใช้ได้ด้วยแป้นพิมพ์ เบราว์เซอร์เก็บบางปุ่มไว้ใช้เอง เวอร์ชันเว็บจึงใช้ปุ่มอื่นแทน และรายการจะบอกไว้",
      showShortcuts: "แสดงปุ่มลัด",
    },
  },
};

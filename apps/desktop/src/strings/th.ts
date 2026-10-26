/**
 * Thai text of the desktop app's own views. Same keys as `en.ts`; written for Thai readers, not word for word.
 * "Private Space" stays in English as the product's name for it, as on the Thai website.
 */
import type { DesktopStrings } from "./en.ts";

const count = (n: number) => n.toLocaleString("th-TH");

export const th: DesktopStrings = {
  onboarding: {
    meet: { before: "พบกับ", after: "Thoth" },
    lede: "ที่เก็บทุกสิ่งที่คุณรู้แบบส่วนตัว ไฟล์ของคุณอยู่ในคอมพิวเตอร์เป็น Markdown ในโฟลเดอร์ที่คุณเลือกเอง ไม่ต้องมีบัญชี ไม่ต้องใช้คลาวด์",
    choose: "เลือกหรือสร้าง Private Space",
    opening: "กำลังเปิด…",
    hint: "เลือกโฟลเดอร์ไฟล์ Markdown ที่มีอยู่แล้ว หรือสร้างโฟลเดอร์ว่างใหม่ในหน้าต่างเลือกไฟล์ Thoth เก็บดัชนีไว้ในโฟลเดอร์ .thoth ที่ซ่อนอยู่ข้างใน และสร้างดัชนีใหม่จากไฟล์ของคุณได้เสมอ",
    recent: "ล่าสุด",
    ready: "พร้อมแล้ว",
    readyLede: " เป็น Private Space แล้ว ทุกอย่างที่คุณเขียนที่นี่คือไฟล์ Markdown ในโฟลเดอร์นั้น",
    startWriting: "เริ่มเขียน",
    importFrom: "นำเข้าจาก Notion หรือ Obsidian",
  },

  shell: {
    sidebar: "แถบด้านข้าง",
    searchPages: "ค้นหาหน้า",
    search: "ค้นหา",
    local: "ในเครื่อง",
    pages: "หน้า",
    pagesInSpace: "หน้าใน Private Space นี้",
    privateSection: (label) => `Private Space ${label}`,
    sectionOptions: (name) => `ตัวเลือกของส่วน ${name}`, // REVIEW
    sectionGripTip: "ลากเพื่อย้าย หรือคลิกเพื่อดูตัวเลือก", // REVIEW
    sectionMenu: (name) => `ส่วน: ${name}`, // REVIEW
    moveSectionUp: "ย้ายส่วนขึ้น", // REVIEW
    moveSectionDown: "ย้ายส่วนลง", // REVIEW
    sectionMoved: (name, position, total) => `ย้าย ${name} ไปลำดับที่ ${count(position)} จาก ${count(total)}`,
    noPages: "ยังไม่มีหน้า",
    newPage: "หน้าใหม่",
    newFolder: "โฟลเดอร์ใหม่",
    untitledFolder: "โฟลเดอร์ไม่มีชื่อ",
    folderCreated: (name) => `สร้างโฟลเดอร์ ${name} แล้ว`,
    windowFailed: (reason) => `ย้ายแท็บไปหน้าต่างใหม่ไม่ได้: ${reason}`, // REVIEW
    titleNotUpdated: (name) => `เปลี่ยนชื่อเป็น ${name} แล้ว แต่ไม่ได้อัปเดตชื่อภายในหน้า เพราะหน้านี้มีการเปลี่ยนแปลง`,
    unsavedChanges: "หน้าที่เปิดอยู่มีการเปลี่ยนแปลงที่ยังบันทึกไม่ได้",
    settings: "การตั้งค่า",
    watchError: (detail) => `การเปลี่ยนแปลงจากนอก Thoth อาจไม่แสดงขึ้นมาเอง: ${detail}`,
    nothingOpen: "ยังไม่ได้เปิดหน้าไหน",
    nothingOpenHint: "สร้างหน้าด้วยปุ่ม หน้าใหม่ หรือกด Ctrl/Cmd+K เพื่อค้นหา",
  },

  newPage: {
    title: "หน้าใหม่",
    name: "ชื่อ (ใช้ / เพื่อใส่ในโฟลเดอร์ เช่น Projects/Plan)",
    cancel: "ยกเลิก",
    create: "สร้าง",
    exists: "มีหน้าชื่อนี้อยู่แล้ว",
    errors: {
      empty: "ตั้งชื่อหน้าก่อน",
      invalid: "ใช้ชื่อนี้เป็นตำแหน่งของหน้าไม่ได้",
      reserved: "โฟลเดอร์ .thoth สงวนไว้ให้ Thoth ใช้",
    },
  },

  search: {
    title: "ค้นหา",
    label: "ค้นหาหน้า",
    placeholder: "ค้นหาหน้า หรือพิมพ์ > เพื่อใช้คำสั่ง",
    results: "ผลการค้นหา",
    none: (query) => `ไม่มีหน้าที่ตรงกับ “${query}”`,
  },

  page: {
    readOnly: "ไฟล์นี้ไม่ใช่ UTF-8 ที่ถูกต้อง Thoth จึงเปิดให้อ่านอย่างเดียวและจะไม่เขียนทับเด็ดขาด หากต้องการแก้ไข ให้เปิดด้วยโปรแกรมอื่น",
    goneTitle: "หน้านี้ไม่มีแล้ว",
    goneDetail: (path) => `ไม่มี ${path} บนดิสก์แล้ว`,
    backlinks: "ลิงก์ย้อนกลับ",
    noBacklinks: "ยังไม่มีหน้าไหนลิงก์มาที่นี่",
  },

  settings: {
    title: "การตั้งค่า",
    privateSpace: "Private Space",
    local: "ในเครื่อง",
    vaultNote: "หน้าต่าง ๆ คือไฟล์ Markdown ในโฟลเดอร์นี้ ดัชนีอยู่ใน .thoth ข้างใน และสร้างใหม่ได้เสมอ",
    reveal: { mac: "แสดงใน Finder", windows: "แสดงใน File Explorer", linux: "แสดงในตัวจัดการไฟล์" },
    switchSpace: "เปลี่ยน Private Space",
    language: "ภาษา",
    languageHint: "ตามระบบ คือใช้ภาษาเดียวกับคอมพิวเตอร์ของคุณ",
    system: "ตามระบบ",
    theme: "ธีม",
    themeHint: "ตามระบบจะใช้โหมดสว่างหรือมืดตามที่ตั้งไว้ในคอมพิวเตอร์",
    editor: "ตัวแก้ไข",
    editorNote: "ทั้งสองโหมดแก้ไขไฟล์ Markdown ไฟล์เดียวกัน สลับโหมดของหน้าไหนก็ได้ด้วย Ctrl/Cmd+Shift+E หรือปุ่มสลับด้านบนของหน้า",
    defaultMode: "โหมดแก้ไขเริ่มต้น",
    // Settings → Editor → Link previews (ADR-0020). Strings marked REVIEW are the least certain.
    linkPreviews: "ตัวอย่างลิงก์",
    linkPreviewsNote: "ลิงก์ที่อยู่บรรทัดเดียวโดด ๆ แสดงการ์ดที่มีชื่อ คำอธิบาย และรูปของหน้านั้นได้ Thoth จะดึงข้อมูลมาให้ ซึ่งทำให้เว็บไซต์รู้ว่าคุณเปิดดู ส่วนลิงก์ในหน้าของเวิร์กสเปซจะรอจนกว่าคุณจะกดโหลดตัวอย่าง", // REVIEW
    linkPreviewModes: { on: "เปิด", paste: "เฉพาะลิงก์ที่ฉันวาง", off: "ปิด" }, // REVIEW
    clearLinkPreviews: "ล้างตัวอย่างลิงก์",
    linkPreviewsCleared: "ล้างตัวอย่างลิงก์แล้ว",
    linkPreviewsClearFailed: "ล้างตัวอย่างลิงก์ไม่ได้",
    index: "ดัชนีการค้นหา",
    indexNote: "การสร้างดัชนีใหม่จะอ่านทุกไฟล์อีกครั้งแล้วสร้างดัชนีขึ้นใหม่ ไฟล์ของคุณไม่ถูกเปลี่ยน",
    rebuild: "สร้างดัชนีใหม่",
    rebuilding: "กำลังสร้างดัชนีใหม่…",
    rebuilt: (pages) => `สร้างดัชนีใหม่แล้ว (อ่าน ${count(pages)} หน้า)`,
    importExport: "นำเข้าและส่งออก",
    importNote: "นำหน้าเข้ามาจาก Notion หรือ Obsidian Thoth แค่อ่านต้นฉบับของคุณเท่านั้น",
    importFrom: "นำเข้าจาก Notion หรือ Obsidian",
  },

  // Settings → Notifications (ADR-0018). Strings marked REVIEW are the least certain.
  notifications: {
    title: "การแจ้งเตือน",
    system: "การแจ้งเตือนของระบบ",
    systemHint: "เฉพาะตอนที่ Thoth อยู่เบื้องหลัง คือหน้าต่างไม่ได้อยู่ในโฟกัสหรือถูกซ่อนไว้ รายการใต้กระดิ่งจะมีทุกเหตุการณ์เสมอ", // REVIEW
    kinds: "แสดงการแจ้งเตือนของระบบเมื่อ", // REVIEW
    kind: {
      agentReview: "การแก้ไขพร้อมให้ตรวจ", // REVIEW
      agentFinished: "งานเสร็จแล้ว",
      agentFailed: "งานล้มเหลว",
      agentLimit: "งานหยุดเพราะถึงขีดจำกัด", // REVIEW
      transferDone: "คัดลอกหรือย้ายเสร็จแล้ว",
      transferFailed: "คัดลอกหรือย้ายไม่สำเร็จ",
      importDone: "นำเข้าเสร็จแล้ว",
      importFailed: "นำเข้าเสร็จแล้ว แต่มีข้อผิดพลาด", // REVIEW
      saveConflict: "การบันทึกขัดกัน", // REVIEW
      update: "มีเวอร์ชันใหม่ออกแล้ว", // REVIEW
    },
    groups: { agent: "ผู้ช่วย Thoth", transfer: "คัดลอกและย้าย", import: "นำเข้า", editor: "การแก้ไข" },
    updateEntry: "เพิ่มเวอร์ชันใหม่ลงในรายการใต้กระดิ่ง", // REVIEW
    privacy: "การแจ้งเตือนจะบอกชื่อหน้า โฟลเดอร์ เวิร์กสเปซ และเอเจนต์เท่านั้น ไม่แสดงเนื้อหาของหน้า สิ่งที่เอเจนต์เขียน หรืองานที่คุณสั่ง", // REVIEW
    click: "คลิกการแจ้งเตือนเพื่อนำ Thoth ขึ้นมาด้านหน้า เรื่องที่แจ้งอยู่บนสุดของรายการใต้กระดิ่ง", // REVIEW
  },

  // The update notice (ADR-0022). Strings marked REVIEW are the least certain.
  updates: {
    popup: (version) => `Thoth ${version} ออกแล้ว`, // REVIEW
    body: (date) => `${date ? `เผยแพร่เมื่อ ${date} ` : ""}ปุ่มดาวน์โหลดจะเปิดหน้าดาวน์โหลดในเบราว์เซอร์ของคุณ Thoth ไม่ติดตั้งให้เอง`, // REVIEW
    download: "ดาวน์โหลด",
    whatsNew: "มีอะไรใหม่", // REVIEW
    later: "ไว้ทีหลัง",
    skip: "ข้ามเวอร์ชันนี้",
    announce: (version) => `Thoth เวอร์ชันใหม่ ${version} ออกแล้ว`, // REVIEW
    openFailed: "เปิดเบราว์เซอร์ไม่ได้",
    general: "ทั่วไป",
    notify: "แจ้งฉันเมื่อมีเวอร์ชันใหม่", // REVIEW
    notifyHint: "เมื่อเปิดแอป และวันละครั้งระหว่างที่ยังเปิดอยู่ Thoth จะถามที่ download.thoth.creaml4tt3.me ว่าเวอร์ชันล่าสุดคืออะไร โดยส่งไปเพียงหมายเลขเวอร์ชันของตัวเองเท่านั้น ไม่มีการดาวน์โหลดหรือติดตั้งให้เอง ถ้าปิดไว้ จะไม่มีการส่งคำขอเลย", // REVIEW
    current: (version) => `คุณใช้ Thoth ${version}`,
    checkNow: "ตรวจสอบเดี๋ยวนี้",
    checking: "กำลังตรวจสอบ…",
    upToDate: "คุณใช้เวอร์ชันล่าสุดแล้ว",
    available: (version) => `Thoth ${version} ออกแล้ว`, // REVIEW
    failed: "ตรวจสอบไม่ได้ ลองใหม่ภายหลัง",
    off: "เปิด “แจ้งฉันเมื่อมีเวอร์ชันใหม่” เพื่อตรวจสอบ", // REVIEW
  },

  // Settings → Connected apps and the question when an app connects (ADR-0021). Strings marked REVIEW are the least
  // certain. "Private Space" and "MCP" stay in English, as elsewhere.
  connectedApps: {
    title: "แอปที่เชื่อมต่อ",
    intro: "แอปในเครื่องนี้ที่ใช้ MCP ได้ เช่น Claude Desktop หรือ Cursor จะค้นหาและอ่าน Private Space ที่คุณแชร์ไว้ที่นี่ได้ แต่แก้ไขอะไรไม่ได้", // REVIEW
    unavailable: "เครื่องนี้ยังใช้แอปที่เชื่อมต่อไม่ได้",
    enable: "ให้แอปอื่นอ่านโน้ตของฉัน",
    enableHint: "ปิดอยู่โดยค่าเริ่มต้น แอปจะอ่าน Private Space ได้ก็ต่อเมื่อ Thoth เปิดอยู่และ Private Space นั้นเปิดอยู่ในหน้าต่างหนึ่ง", // REVIEW
    notListening: (reason) => `Thoth เริ่มรอรับการเชื่อมต่อจากแอปไม่ได้: ${reason}`, // REVIEW
    spaces: "Private Space ที่แอปอ่านได้",
    spacesHint: "เฉพาะที่ติ๊กไว้เท่านั้น Private Space อื่นของคุณแอปจะมองไม่เห็น",
    apps: "แอป",
    selfReported: "แต่ละแอปบอกชื่อของตัวเองตอนเชื่อมต่อ Thoth ตรวจสอบชื่อนั้นไม่ได้ อนุญาตเฉพาะแอปที่คุณตั้งค่าเองเท่านั้น", // REVIEW
    noApps: "ยังไม่มีแอปใดเชื่อมต่อ",
    allowed: "อนุญาตแล้ว",
    denied: "ไม่อนุญาต",
    waiting: "รอคำตอบจากคุณ",
    allow: "อนุญาต",
    revoke: "เพิกถอน",
    remove: "นำออก",
    setup: "ตั้งค่าแอป",
    setupHint: "วางข้อความนี้ในการตั้งค่า MCP ของแอป (Claude Desktop: claude_desktop_config.json, Cursor: mcp.json) ข้อความนี้จะเปิด thoth-mcp ที่มากับ Thoth", // REVIEW
    copySetup: "คัดลอกการตั้งค่า",
    copied: "คัดลอกแล้ว",
    copyFailed: "คัดลอกไม่ได้ ให้เลือกข้อความแล้วคัดลอกเอง",
    log: "คำขอ",
    logHint: "คำขอทุกครั้งใน 30 วันล่าสุด: เมื่อไร แอปไหน ขออะไร และหน้าไหน เก็บไว้ในเครื่องนี้เท่านั้น และไม่เก็บเนื้อหาของหน้าหรือคำที่ค้นหา", // REVIEW
    showLog: "แสดงคำขอ",
    refreshLog: "รีเฟรช",
    noRequests: "ยังไม่มีคำขอ",
    logLabel: "คำขอจากแอปที่เชื่อมต่อ",
    when: (date) => date.toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }),
    columns: { time: "เวลา", app: "แอป", tool: "สิ่งที่ขอ", pages: "หน้า", result: "ผล" },
    tools: { search: "ค้นหา", list_pages: "รายการหน้า", read_page: "อ่านหน้า", backlinks: "ลิงก์มายังหน้า", unknown: "สิ่งที่ไม่รู้จัก" }, // REVIEW
    answered: "ตอบแล้ว",
    refused: {
      DENIED: "ปฏิเสธ: ไม่ได้รับอนุญาต",
      NOT_ALLOWED: "ปฏิเสธ: รอคำตอบจากคุณ",
      NOT_ENABLED: "ปฏิเสธ: ปิดแอปที่เชื่อมต่ออยู่", // REVIEW
      NO_SPACE: "ไม่มี Private Space ที่แชร์เปิดอยู่",
      NOT_FOUND: "ไม่พบ",
      TOO_LARGE: "ใหญ่เกินไป",
      TIMEOUT: "ใช้เวลานานเกินไป",
      BAD_ARGUMENT: "คำขอไม่ถูกต้อง",
      BUSY: "ไม่ว่าง",
    },
    failed: (code) => `ไม่สำเร็จ (${code})`,
    prompt: {
      title: (app) => `ให้ “${app}” อ่านโน้ตของคุณไหม`,
      body: (spaces) => `แอปนี้จะค้นหาและอ่านหน้าใน ${spaces} ได้ แต่แก้ไขอะไรไม่ได้`, // REVIEW
      nothingShared: "ยังไม่ได้แชร์ Private Space ใด ติ๊กเลือกได้ที่ การตั้งค่า → แอปที่เชื่อมต่อ",
      caution: (app) => `แอปตั้งชื่อตัวเอง Thoth ตรวจสอบไม่ได้ว่าใช่ ${app} จริงหรือไม่ อนุญาตเฉพาะเมื่อคุณเพิ่งตั้งค่าแอปนี้เอง`, // REVIEW
      later: "Thoth จะจำคำตอบของคุณไว้ เปลี่ยนได้ทุกเมื่อที่ การตั้งค่า → แอปที่เชื่อมต่อ",
      allow: "อนุญาต",
      deny: "ไม่อนุญาต",
    },
  },

  servers: {
    title: "เซิร์ฟเวอร์",
    intro: "เชื่อมต่อกับเซิร์ฟเวอร์ Thoth เพื่อทำงานในเวิร์กสเปซที่แชร์กัน Thoth เก็บการเข้าสู่ระบบไว้ในพวงกุญแจของระบบ หน้าต่างนี้ไม่เคยเห็นข้อมูลนั้น",
    unreachable: (detail) => `ติดต่อเซิร์ฟเวอร์ Thoth ที่ที่อยู่นั้นไม่ได้ ${detail}`,
    unusable: (detail) => `ใช้ที่อยู่นี้ไม่ได้ ${detail}`,
    enterAddress: "ใส่ที่อยู่ของเซิร์ฟเวอร์ เช่น https://thoth.example.com",
    signedIn: "เข้าสู่ระบบแล้ว",
    signedOut: "ออกจากระบบแล้ว",
    account: (name, email, token) => `เข้าสู่ระบบแล้ว${name === null ? "" : `ในชื่อ ${name}${email ? ` (${email})` : ""}`}${token ? " ด้วยโทเค็นส่วนตัว" : ""}`,
    notSignedIn: "ยังไม่ได้เข้าสู่ระบบ",
    limitsTitle: "ข้อจำกัดของเซิร์ฟเวอร์นี้:",
    waiting: (provider) => `เข้าสู่ระบบด้วย ${provider} ในเบราว์เซอร์ให้เสร็จ Thoth กำลังรอให้กลับมา`,
    cancel: "ยกเลิก",
    signInWith: (provider) => `เข้าสู่ระบบด้วย ${provider}`,
    useToken: "ใช้โทเค็นส่วนตัว",
    signOut: "ออกจากระบบ",
    signingOut: "กำลังออกจากระบบ…",
    remove: "ลบ",
    tokenLabel: "โทเค็นส่วนตัว (ส่งให้ส่วนหลังของแอปครั้งเดียว แล้วเก็บไว้ในพวงกุญแจของระบบ จะไม่แสดงอีก)",
    checking: "กำลังตรวจสอบ…",
    signInWithToken: "เข้าสู่ระบบด้วยโทเค็น",
    removeTitle: (server) => `ลบ ${server} ใช่ไหม`,
    removeBody: "Thoth จะออกจากระบบของเซิร์ฟเวอร์นี้และลืมเซิร์ฟเวอร์นี้ไป หน้าบนเซิร์ฟเวอร์ไม่ถูกเปลี่ยน และไม่มีอะไรใน Private Space ของคุณถูกแตะต้อง",
    keepIt: "เก็บไว้",
    removeServer: "ลบเซิร์ฟเวอร์",
    suggested: "แนะนำ",
    connecting: "กำลังเชื่อมต่อ…",
    addStarter: (name) => `เพิ่ม${name}`,
    addServer: "เพิ่มเซิร์ฟเวอร์",
    address: "ที่อยู่เซิร์ฟเวอร์",
    starter: {
      name: "เซิร์ฟเวอร์ทดลองของ Thoth",
      caution: "เซิร์ฟเวอร์ทดลองใช้ฟรี มีข้อจำกัดการใช้งาน บัญชีที่ไม่ได้ใช้ 90 วันจะถูกลบ และอาจมีการล้างข้อมูลทั้งหมด จึงควรเก็บงานสำคัญไว้ใน Private Space ของคุณ",
    },
    serverSection: (server) => `เซิร์ฟเวอร์ ${server}`,
    signIn: "เข้าสู่ระบบ",
    loading: "กำลังโหลด…",
    noWorkspaces: "ยังไม่มีเวิร์กสเปซ",
    workspacesOn: (server) => `เวิร์กสเปซบน ${server}`,
    removedTitle: "เซิร์ฟเวอร์นี้ถูกลบแล้ว",
    removedDetail: "เพิ่มเซิร์ฟเวอร์อีกครั้งในการตั้งค่าเพื่อเปิดหน้าของมัน",
    signedOutOf: (server) => `ออกจากระบบ ${server} แล้ว`,
    signInAgainDetail: "เข้าสู่ระบบอีกครั้งเพื่อเปิดหน้านี้",
    signInTo: (server) => `เข้าสู่ระบบ ${server}`,
    editsStay: "สิ่งที่คุณแก้ไขยังอยู่ในหน้านี้ หลังเข้าสู่ระบบแล้ว ให้กด ลองอีกครั้ง เพื่อบันทึก",
  },

  // Thai for the assistant was written by the implementer, not a native reviewer. "Thoth", "Claude Code" and "Codex"
  // stay in English as names. Strings marked REVIEW are the least certain.
  agents: {
    title: "ผู้ช่วย Thoth",
    askAgent: "ถาม Thoth…", // REVIEW
    lede: "Thoth ส่งหน้าบางหน้าให้เครื่องมือ AI ที่คุณใช้อยู่แล้วช่วยทำงาน เครื่องมือจะทำงานกับสำเนา และคุณตรวจทุกการเปลี่ยนแปลงก่อนที่จะมีอะไรถูกเขียนลงใน Private Space เริ่มงานได้จากมาสคอตที่มุมหน้าต่าง", // REVIEW
    unavailable: "ผู้ช่วย Thoth ต้องใช้แอป Thoth บนเดสก์ท็อป เบราว์เซอร์รันโปรแกรมบนคอมพิวเตอร์ของคุณไม่ได้",
    recovered: (n) => `มี ${count(n)} งานที่หยุดไปตอนปิด Thoth ครั้งล่าสุด สำเนาของงานเหล่านั้นถูกลบแล้ว และไม่มีการเปลี่ยนแปลงใดถูกนำไปใช้`,
    awaiting: (n) => `มี ${count(n)} งานที่รอให้คุณตรวจ เปิดได้ที่ งานก่อนหน้า หรือคลิกที่มาสคอต`, // REVIEW
    dismiss: "ปิด",
    notice: {
      export_restricted: (workspace) => `${workspace ? `“${workspace}”` : "เวิร์กสเปซนี้"} ไม่อนุญาตให้คัดลอกหน้าออกไป จึงส่งให้เอเจนต์ไม่ได้`, // REVIEW
      forbidden: (workspace) => `บทบาทของคุณใน${workspace ? ` “${workspace}”` : "เวิร์กสเปซนี้"} อ่านหน้าเหล่านี้ไม่ได้ จึงส่งให้เอเจนต์ไม่ได้`, // REVIEW
      not_found: (workspace) => `หน้าในเวิร์กสเปซหายไป หรือคุณไม่ได้เป็นสมาชิก${workspace ? `ของ “${workspace}”` : ""}แล้ว เอาหน้านั้นออกแล้วลองอีกครั้ง`, // REVIEW
      unavailable: "ติดต่อเวิร์กสเปซไม่ได้ ตรวจสอบเซิร์ฟเวอร์ (การตั้งค่า → เซิร์ฟเวอร์) แล้วลองอีกครั้ง",
      reviewGone: "เปิดการตรวจนี้อีกไม่ได้ เพราะสำเนาที่บันทึกไว้ถูกลบหรือเสียหาย ไม่มีการเปลี่ยนแปลงใดถูกนำไปใช้", // REVIEW
      workspaceOff: "ปิดการใช้หน้าจากเวิร์กสเปซไว้ที่ การตั้งค่า → ผู้ช่วย Thoth → สิทธิ์", // REVIEW
    },

    picker: {
      legend: "เอเจนต์",
      short: {
        checking: "กำลังตรวจ…",
        ready: (version) => `พร้อม ${version}`,
        missing: "ไม่พบ",
        too_old: "เก่าเกินไป",
        unsupported: "ต้องอัปเดต",
        not_logged_in: "ยังไม่ได้เข้าสู่ระบบ",
        sandbox_unavailable: "ไม่มีแซนด์บ็อกซ์ที่นี่", // REVIEW
        error: "ไม่ตอบ",
      },
    },

    status: {
      searched: "Thoth หาในโฟลเดอร์เหล่านี้:",
      check: "ตรวจอีกครั้ง",
    },

    facts: {
      label: "รายละเอียด",
      version: (version) => `เวอร์ชัน ${version}`,
      noVersion: "ไม่มีเวอร์ชัน",
      notInstalled: "ยังไม่ได้ติดตั้ง",
      signedIn: "เข้าสู่ระบบแล้ว",
      signedOut: "ยังไม่ได้เข้าสู่ระบบ",
      sandbox: "แซนด์บ็อกซ์ใช้ได้", // REVIEW
      noSandbox: "ไม่มีแซนด์บ็อกซ์", // REVIEW
      unknown: "ยังไม่ทราบ",
    },

    providers: {
      claude: {
        name: "Claude Code",
        caution: "เอเจนต์ทำงานด้วยสิทธิ์ผู้ใช้ของคุณ Thoth จำกัดสิ่งที่ส่งให้เอเจนต์ ไม่ได้จำกัดสิ่งที่เอเจนต์ทำได้", // REVIEW
        checking: "กำลังหา Claude Code…",
        ready: (version) => `Claude Code ${version} พร้อมใช้งาน ใช้การเข้าสู่ระบบ Claude ของคุณเอง Thoth ไม่เห็นข้อมูลนั้น`,
        missing: "ยังไม่ได้ติดตั้ง Claude Code หรือ Thoth หาไม่พบ",
        missingFix: "ติดตั้ง Claude Code (ดู code.claude.com/docs/en/setup หรือใช้ brew install --cask claude-code) แล้วกด ตรวจอีกครั้ง",
        tooOld: (version, minimum) => `Claude Code ${version} เก่าเกินไป Thoth ต้องใช้เวอร์ชัน ${minimum} ขึ้นไป`,
        tooOldFix: "รัน claude update ในเทอร์มินัล แล้วกด ตรวจอีกครั้ง",
        unsupported: (version) => `Claude Code ${version} ไม่มีตัวเลือกที่ Thoth ต้องใช้:`,
        unsupportedFix: "อัปเดต Claude Code (รัน claude update ในเทอร์มินัล) แล้วกด ตรวจอีกครั้ง",
        notLoggedIn: "ติดตั้ง Claude Code แล้ว แต่ยังไม่ได้เข้าสู่ระบบ",
        notLoggedInFix: "รัน claude ในเทอร์มินัลแล้วเข้าสู่ระบบ (หรือ claude auth login) แล้วกด ตรวจอีกครั้ง",
        sandboxUnavailable: (message) => `ตรวจ Claude Code ไม่ได้: ${message}`,
        sandboxFix: "ตรวจอีกครั้ง",
        error: (message) => `Claude Code ไม่ตอบ: ${message}`,
        modelHint: "เว้นว่างไว้เพื่อใช้ค่าเริ่มต้นของ Claude Code หรือพิมพ์ชื่อย่อ เช่น sonnet, opus หรือ haiku",
        badModel: "ชื่อโมเดลนี้ Claude Code ไม่รับ",
        session: (model) => `เริ่มด้วย ${model} เครื่องมือ: อ่านและแก้ไขไฟล์ในโฟลเดอร์ของตัวเองเท่านั้น`,
        retry: (attempt) => `Claude Code กำลังลองใหม่ (ครั้งที่ ${count(attempt)})…`,
        budgetHint: "Claude Code จะหยุดเมื่อค่าใช้จ่ายที่ประมาณเองถึงจำนวนนี้ ค่าประมาณอาจคลาดเคลื่อนเล็กน้อย เปลี่ยนค่าเริ่มต้นได้ที่ การตั้งค่า → ผู้ช่วย Thoth", // REVIEW
        noBudget: "Claude Code ไม่รองรับ",
        errors: {
          not_logged_in: "Claude Code ยังไม่ได้เข้าสู่ระบบ รัน claude ในเทอร์มินัลแล้วเข้าสู่ระบบ จากนั้นลองอีกครั้ง",
          billing: "บัญชี Claude ของคุณยังชำระค่าใช้จ่ายสำหรับงานนี้ไม่ได้",
          rate_limit: "ใช้งาน Claude ถึงขีดจำกัดแล้ว ลองใหม่ภายหลัง",
          model_not_found: "Claude Code ไม่รู้จักโมเดลนี้ หรือบัญชีของคุณใช้โมเดลนี้ไม่ได้",
          cli: "Claude Code แจ้งข้อผิดพลาด:",
          spawn: "เริ่ม Claude Code ไม่ได้:",
        },
      },
      codex: {
        name: "Codex",
        caution: "Codex รันคำสั่งเชลล์ Thoth ให้ Codex ทำงานเฉพาะในแซนด์บ็อกซ์ของ Codex เอง คำสั่งและการแก้ไขของ Codex อ่านได้เฉพาะโฟลเดอร์ของงานนี้และไฟล์ระบบ เขียนได้เฉพาะโฟลเดอร์นี้ และใช้เครือข่ายไม่ได้ ตัว Codex เองทำงานด้วยสิทธิ์ผู้ใช้ของคุณ", // REVIEW
        checking: "กำลังหา Codex…",
        ready: (version) => `Codex ${version} พร้อมใช้งานพร้อมแซนด์บ็อกซ์ ใช้การเข้าสู่ระบบ Codex ของคุณเอง Thoth ไม่เห็นข้อมูลนั้น`, // REVIEW
        missing: "ยังไม่ได้ติดตั้ง Codex หรือ Thoth หาไม่พบ",
        missingFix: "ติดตั้ง Codex CLI (ดู developers.openai.com/codex/cli: npm install -g @openai/codex หรือ brew install --cask codex) แล้วกด ตรวจอีกครั้ง",
        tooOld: (version, minimum) => `Codex ${version} เก่าเกินไป Thoth ต้องใช้เวอร์ชัน ${minimum} ขึ้นไป`,
        tooOldFix: "รัน codex update ในเทอร์มินัล (หรืออัปเดตด้วยเครื่องมือที่ใช้ติดตั้ง) แล้วกด ตรวจอีกครั้ง",
        unsupported: (version) => `Codex ${version} ไม่มีตัวเลือกที่ Thoth ต้องใช้:`,
        unsupportedFix: "อัปเดต Codex (รัน codex update ในเทอร์มินัล) แล้วกด ตรวจอีกครั้ง",
        notLoggedIn: "ติดตั้ง Codex แล้ว แต่ยังไม่ได้เข้าสู่ระบบ",
        notLoggedInFix: "รัน codex login ในเทอร์มินัล แล้วกด ตรวจอีกครั้ง",
        sandboxUnavailable: (message) => `แซนด์บ็อกซ์ของ Codex ใช้งานบนคอมพิวเตอร์เครื่องนี้ไม่ได้ Thoth จึงจะไม่รัน Codex เพราะถ้าไม่มีแซนด์บ็อกซ์ คำสั่งที่ Codex รันจะมีสิทธิ์ทั้งหมดของคุณ Codex แจ้งว่า: ${message}`, // REVIEW
        sandboxFix: "บน Linux ให้ติดตั้ง bubblewrap (เช่น sudo apt install bubblewrap) บน Windows ให้ตั้งค่าแซนด์บ็อกซ์ Windows ของ Codex (developers.openai.com/codex/windows) แล้วกด ตรวจอีกครั้ง", // REVIEW
        error: (message) => `Codex ไม่ตอบ: ${message}`,
        modelHint: "เว้นว่างไว้เพื่อใช้ค่าเริ่มต้นของ Codex หรือพิมพ์ชื่อโมเดล เช่น gpt-5.5",
        badModel: "ชื่อโมเดลนี้ Codex ไม่รับ",
        session: (model) => `เริ่มด้วย ${model} คำสั่งและการแก้ไขทำงานในแซนด์บ็อกซ์ของ Codex: เฉพาะโฟลเดอร์นี้ ไม่มีเครือข่าย`, // REVIEW
        retry: (attempt) => `Codex กำลังเชื่อมต่อใหม่ (ครั้งที่ ${count(attempt)})…`,
        budgetHint: "Codex ไม่มีวงเงินค่าใช้จ่ายของตัวเอง จึงไม่ได้ตั้งไว้ เวลาสูงสุดยังใช้อยู่", // REVIEW
        noBudget: "Codex ไม่รองรับ",
        errors: {
          not_logged_in: "Codex ยังไม่ได้เข้าสู่ระบบ รัน codex login ในเทอร์มินัล จากนั้นลองอีกครั้ง",
          billing: "บัญชี OpenAI ของคุณยังชำระค่าใช้จ่ายสำหรับงานนี้ไม่ได้",
          rate_limit: "ใช้งาน Codex ถึงขีดจำกัดแล้ว ลองใหม่ภายหลัง",
          model_not_found: "Codex ไม่รู้จักโมเดลนี้ หรือบัญชีของคุณใช้โมเดลนี้ไม่ได้",
          cli: "Codex แจ้งข้อผิดพลาด:",
          spawn: "เริ่ม Codex ไม่ได้:",
        },
      },
    },

    form: {
      heading: "งานใหม่",
      context: "หน้าที่ส่งให้เอเจนต์",
      contextHint: "จะคัดลอกเฉพาะหน้าเหล่านี้และไฟล์แนบที่หน้าเหล่านี้ลิงก์ถึงไปให้เอเจนต์ เอเจนต์มองไม่เห็นส่วนอื่นใน Private Space เอเจนต์แก้ไขหน้าเหล่านี้ได้ และคุณตรวจทุกการเปลี่ยนแปลง",
      wholeSpace: "ทั้ง Private Space",
      wholeSpaceHint: "ทุกหน้าและไฟล์แนบ ยกเว้นโฟลเดอร์ .thoth ของ Thoth เอง ทุกการเปลี่ยนแปลงยังต้องผ่านการตรวจทีละไฟล์ก่อนจะมีอะไรถูกเขียน", // REVIEW
      wholeSpaceOn: "รวมทั้ง Private Space แล้ว",
      total: (files, size) => `จะคัดลอก ${count(files)} ไฟล์ (${size}) ให้เอเจนต์`,
      totalNone: "ไม่มีอะไรใน Private Space ถูกคัดลอก",
      totalLimits: (files, size) => `ขีดจำกัด: ${count(files)} ไฟล์ และ ${size} ต่อหนึ่งงาน`,
      workspace: "หน้าจากเวิร์กสเปซ (อ่านอย่างเดียว)",
      workspaceHint: "สำเนาจะอยู่ในโฟลเดอร์แยกที่อ่านได้อย่างเดียว เอเจนต์อ่านได้ แต่สิ่งที่เอเจนต์ทำกับสำเนาเหล่านี้จะไม่ถูกบันทึกหรือส่งกลับ แสดงเฉพาะเวิร์กสเปซที่คุณคัดลอกหน้าออกมาได้", // REVIEW
      workspaceNone: "ยังไม่มีเวิร์กสเปซให้เลือก เพิ่มเซิร์ฟเวอร์และเข้าสู่ระบบก่อน (การตั้งค่า → เซิร์ฟเวอร์)",
      workspaceLoading: "กำลังโหลดหน้า…",
      workspaceEmpty: "เวิร์กสเปซนี้ไม่มีหน้า",
      workspaceBlocked: (reason) => (reason === "export_restricted" ? "เวิร์กสเปซนี้ไม่อนุญาตให้คัดลอกหน้าออกไป" : "บทบาทของคุณที่นี่อ่านหน้าไม่ได้"), // REVIEW
      workspacePage: (title, workspace) => `${title} (${workspace} อ่านอย่างเดียว)`,
      workspaceAdded: (n) => `เพิ่มหน้าจากเวิร์กสเปซแล้ว ${count(n)} หน้า`,
      workspaceRemove: (title) => `เอา ${title} ออก`,
      filter: "กรองหน้าและโฟลเดอร์",
      selected: (n) => `เลือกแล้ว ${count(n)} รายการ`,
      folder: (name, n) => `${name} (โฟลเดอร์ ${count(n)} หน้า)`,
      inFolder: "รวมอยู่กับโฟลเดอร์แล้ว",
      clear: "ล้าง",
      none: "ไม่มีหน้าที่ตรงกัน",
      task: "งาน",
      taskHint: "ต้องการให้เอเจนต์ทำอะไรกับหน้าเหล่านี้",
      model: "โมเดล (ไม่บังคับ)",
      limits: "ขีดจำกัดของงานนี้",
      timeLimit: "เวลาสูงสุด",
      timeOption: (minutes) => `${count(minutes)} นาที`,
      budget: "วงเงินค่าใช้จ่าย",
      budgetOption: (usd) => `US$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`,
      noLimit: "ไม่จำกัด",
      useDefault: (what) => `ค่าเริ่มต้น (${what})`,
      start: "เริ่ม",
      starting: "กำลังคัดลอกหน้า…",
      needContext: "เลือกอย่างน้อยหนึ่งหน้าหรือหนึ่งโฟลเดอร์ ทั้ง Private Space หรือหน้าจากเวิร์กสเปซ",
      needTask: "เขียนว่าต้องการให้เอเจนต์ทำอะไร",
      contextTooMany: "ไฟล์มากเกินไปสำหรับหนึ่งงาน เลือกหน้าหรือโฟลเดอร์ให้น้อยลง",
      contextTooLarge: "ข้อมูลมากเกินไปสำหรับหนึ่งงาน เลือกหน้าหรือโฟลเดอร์ให้น้อยลง",
      contextFileTooLarge: "มีไฟล์หนึ่งใหญ่เกินกว่าจะส่งให้เอเจนต์ เลือกอย่างอื่น",
      contextMissing: "สิ่งที่คุณเลือกหายไปแล้ว เลือกใหม่อีกครั้ง",
      privateOff: "ปิดการใช้หน้าใน Private Space ไว้ที่ การตั้งค่า → ผู้ช่วย Thoth → สิทธิ์", // REVIEW
      wholeSpaceOff: "ปิดการส่งทั้ง Private Space ไว้ที่ การตั้งค่า → ผู้ช่วย Thoth → สิทธิ์", // REVIEW
      workspaceOff: "ปิดการใช้หน้าจากเวิร์กสเปซไว้ที่ การตั้งค่า → ผู้ช่วย Thoth → สิทธิ์", // REVIEW
    },

    run: {
      heading: "การทำงาน",
      working: "เอเจนต์กำลังทำงานกับสำเนา…",
      transcript: "สิ่งที่เอเจนต์กำลังทำ",
      cancel: "ยกเลิก",
      cancelling: "กำลังยกเลิก…",
      tool: { Read: "กำลังอ่าน", Edit: "กำลังแก้ไข", Write: "กำลังเขียน", Glob: "กำลังดูรายการไฟล์", Grep: "กำลังค้นหา", Shell: "กำลังรันคำสั่ง", Delete: "กำลังลบ", WebSearch: "กำลังค้นเว็บ", MCP: "กำลังใช้เครื่องมือ" },
      denied: (tool) => `ไม่อนุญาต: ${tool}`,
      toolError: "การเรียกเครื่องมือล้มเหลว",
      cost: (usd) => `ค่าใช้จ่ายโดยประมาณ: US$${usd}`,
      tokens: (input, cached, output) => `โทเคน: เข้า ${input.toLocaleString("th")} (แคช ${cached.toLocaleString("th")}) ออก ${output.toLocaleString("th")}`, // REVIEW
      cancelled: "ยกเลิกแล้ว ไม่มีอะไรใน Private Space ถูกเปลี่ยน",
      stoppedTime: (minutes) => `หยุดเมื่อถึงเวลาสูงสุด${minutes === null ? "" : ` (${count(minutes)} นาที)`} ยังตรวจสิ่งที่เอเจนต์ทำไว้ก่อนหน้านั้นได้`, // REVIEW
      stoppedBudget: (usd) => `หยุดเมื่อถึงวงเงินค่าใช้จ่าย${usd === null ? "" : ` (US$${Number.isInteger(usd) ? usd : usd.toFixed(2)})`} ยังตรวจสิ่งที่เอเจนต์ทำไว้ก่อนหน้านั้นได้`, // REVIEW
      noChanges: "เอเจนต์ทำงานเสร็จโดยไม่ได้เปลี่ยนอะไร",
      failed: "เอเจนต์หยุดเพราะมีข้อผิดพลาด ไม่มีอะไรใน Private Space ถูกเปลี่ยน",
      errors: {
        budget: "ถึงวงเงินค่าใช้จ่ายแล้ว",
        timeout: "งานใช้เวลานานเกินไปจึงถูกหยุด",
        output_limit: "เอเจนต์พิมพ์ผลลัพธ์มากเกินไปจึงถูกหยุด",
        cancelled: "ยกเลิกแล้ว",
        review: "อ่านการเปลี่ยนแปลงของเอเจนต์ไม่ได้:",
      },
    },

    review: {
      heading: "ตรวจการเปลี่ยนแปลง",
      lede: "ยังไม่มีอะไรถูกเขียน เลือกการเปลี่ยนแปลงที่จะนำไปใช้ ส่วนที่เหลือจะถูกทิ้ง",
      kinds: { modified: "แก้ไข", added: "ใหม่", deleted: "ลบ" },
      approve: (path) => `นำการเปลี่ยนแปลงของ ${path} ไปใช้`,
      all: "เลือกทั้งหมด",
      none: "ไม่เลือกเลย",
      apply: (n) => `นำ ${count(n)} การเปลี่ยนแปลงไปใช้`,
      applying: "กำลังนำไปใช้…",
      discard: "ทิ้งทั้งหมด",
      differences: (path) => `การเปลี่ยนแปลงของ ${path}`,
      before: "หน้าของคุณ",
      after: "ฉบับของเอเจนต์",
      stale: "หน้านี้ถูกแก้ใน Private Space หลังเอเจนต์เริ่มทำงาน จะไม่เขียนทับสิ่งที่คุณแก้ การนำไปใช้จะกลายเป็นความขัดแย้ง และคุณเก็บฉบับของเอเจนต์ไว้เป็นสำเนาได้", // REVIEW
      file: (size) => `ไฟล์ขนาด ${size} ไม่มีตัวอย่างข้อความ`,
      deleted: "เอเจนต์ลบรายการนี้",
      problems: {
        unsafe_path: "ชื่อนี้ไม่ปลอดภัยสำหรับ Private Space จะไม่ถูกนำไปใช้",
        reserved: "อยู่ในโฟลเดอร์ .thoth ที่ Thoth เก็บข้อมูลของตัวเอง จะไม่ถูกนำไปใช้",
        symlink: "เป็นทางลัด (symbolic link) จะไม่ถูกติดตามหรือนำไปใช้",
        special_file: "ไม่ใช่ไฟล์ปกติ จะไม่ถูกนำไปใช้",
        too_large: "ใหญ่เกินขนาดที่กำหนด จะไม่ถูกนำไปใช้",
        not_utf8: "ไม่ใช่ข้อความ UTF-8 ที่ถูกต้อง ถ้านำไปใช้เป็นการแก้หน้าจะทำให้ไบต์เปลี่ยน จึงไม่นำไปใช้",
        too_many: "มีไฟล์มากเกินไป ไฟล์ที่เหลือไม่ได้ถูกตรวจ",
        unreadable: "อ่านไม่ได้ จะไม่ถูกนำไปใช้",
        read_only: "หน้าจากเวิร์กสเปซที่อ่านได้อย่างเดียว: ทิ้งการเปลี่ยนแปลงแล้ว", // REVIEW
      },
    },

    applied: {
      heading: "ผลลัพธ์",
      applied: "นำไปใช้แล้ว",
      rejected: "ไม่ได้นำไปใช้ (ไม่ได้เลือก)",
      readOnly: "หน้าจากเวิร์กสเปซที่อ่านได้อย่างเดียว: ทิ้งการเปลี่ยนแปลงแล้ว", // REVIEW
      conflict: "ไม่ได้นำไปใช้ เพราะถูกแก้ใน Private Space หลังเริ่มงาน ฉบับของคุณยังอยู่", // REVIEW
      failed: (message) => `ไม่ได้นำไปใช้: ${message}`,
      copied: (copy) => `เก็บฉบับของเอเจนต์ไว้เป็น ${copy} แล้ว`,
      keepCopy: "เก็บฉบับของเอเจนต์ไว้เป็นสำเนา",
      open: (path) => `เปิด ${path}`,
      newTask: "งานใหม่",
      discarded: "ทิ้งการเปลี่ยนแปลงทั้งหมดแล้ว ไม่มีอะไรถูกเขียน",
    },

    history: {
      heading: "งานก่อนหน้า",
      empty: "ยังไม่มีงาน",
      states: {
        staging: "กำลังเตรียม",
        running: "กำลังทำงาน",
        review: "รอการตรวจ",
        applied: "นำไปใช้แล้ว",
        done: "ไม่มีการเปลี่ยนแปลง",
        discarded: "ทิ้งแล้ว",
        cancelled: "ยกเลิกแล้ว",
        failed: "ล้มเหลว",
        interrupted: "หยุดไปตอนปิด Thoth",
      },
      stoppedTime: "หยุดเมื่อถึงเวลาสูงสุด", // REVIEW
      stoppedBudget: "หยุดเมื่อถึงวงเงินค่าใช้จ่าย", // REVIEW
      summary: (pages, applied) => `ส่งให้ ${count(pages)} ไฟล์ · นำไปใช้ ${count(applied)} การเปลี่ยนแปลง`,
      date: "วันที่",
      task: "งาน",
      agent: "เอเจนต์",
      model: "โมเดล",
      cost: "ค่าใช้จ่าย",
      outcome: "ผลลัพธ์",
      defaultModel: "ค่าเริ่มต้น",
      noCost: "ไม่ทราบ",
      costOf: (usd) => `US$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`,
      tokensOf: (tokens) => `${tokens.toLocaleString("th")} โทเคน`,
      reviewAgain: "ตรวจการเปลี่ยนแปลง",
      openDetails: "เปิดบันทึกการทำงานและการเปลี่ยนแปลง",
      closeDetails: "ปิด",
      detailsHeading: "รายละเอียดที่บันทึกไว้ของงานนี้",
      loading: "กำลังโหลด…",
      noDetails: "บันทึกการทำงานและการเปลี่ยนแปลงของงานนี้หายไปแล้ว (ถูกลบ หรือเก่ากว่าที่เก็บประวัติไว้)", // REVIEW
      transcript: "สิ่งที่เอเจนต์ทำ",
      changes: "สิ่งที่เอเจนต์เสนอ",
      noChanges: "เอเจนต์ไม่ได้เสนอการเปลี่ยนแปลงใด",
      noReview: "ไม่ได้เก็บการเปลี่ยนแปลงที่เสนอของงานนี้ไว้",
      noOriginal: "ไม่ได้เก็บต้นฉบับไว้ จึงแสดงเฉพาะฉบับของเอเจนต์", // REVIEW
      omitted: "ใหญ่เกินกว่าจะแสดงที่นี่",
      localOnly: "เก็บไว้ในคอมพิวเตอร์เครื่องนี้เท่านั้น ไม่อยู่ใน Private Space",
    },

    runView: {
      tab: "การเปลี่ยนแปลงของเอเจนต์", // REVIEW
      title: "การเปลี่ยนแปลงของเอเจนต์", // REVIEW
      none: "ไม่มีงานที่รอการตรวจ เริ่มงานได้จากมาสคอตที่มุมหน้าต่าง", // REVIEW
      transcript: "บันทึกการทำงาน",
    },

    providersHeading: "เอเจนต์",
    providersLede: "Thoth เรียกใช้เครื่องมือบรรทัดคำสั่งที่คุณติดตั้งและเข้าสู่ระบบไว้แล้ว Thoth ไม่เคยเห็นข้อมูลเข้าสู่ระบบของคุณ", // REVIEW

    permissions: {
      heading: "สิทธิ์และขีดจำกัด", // REVIEW
      lede: "สิ่งที่ส่งให้เอเจนต์ได้ และค่าเริ่มต้นของทุกงาน เปลี่ยนขีดจำกัดเฉพาะงานเดียวได้ในตัวเลือกของกล่องข้อความ", // REVIEW
      private: "หน้าและโฟลเดอร์ใน Private Space",
      privateHint: "สำเนาของหน้าและโฟลเดอร์ที่คุณเลือก เอเจนต์แก้ไขได้ และคุณตรวจทุกการเปลี่ยนแปลง",
      wholeSpace: "ทั้ง Private Space",
      wholeSpaceHint: "ทุกหน้าและไฟล์แนบ ยกเว้นโฟลเดอร์ .thoth ของ Thoth เอง",
      workspace: "หน้าจากเวิร์กสเปซ (อ่านอย่างเดียว)",
      workspaceHint: "สำเนาของหน้าที่คุณคัดลอกออกจากเวิร์กสเปซได้ สิ่งที่เอเจนต์ทำกับหน้าเหล่านี้จะไม่ถูกบันทึกหรือส่งกลับ", // REVIEW
      limits: "ขีดจำกัดเริ่มต้น",
      codexNote: "Codex ไม่มีวงเงินค่าใช้จ่ายของตัวเอง วงเงินจึงใช้กับ Claude Code เท่านั้น ส่วนเวลาสูงสุดใช้กับทั้งสองตัว", // REVIEW
    },

    usage: {
      heading: "การใช้งาน",
      lede: "จากงานที่บันทึกไว้ในคอมพิวเตอร์เครื่องนี้ Claude Code รายงานค่าใช้จ่ายโดยประมาณ ส่วน Codex รายงานจำนวนโทเคน", // REVIEW
      period: "แสดงตาม",
      periods: { day: "วัน", week: "สัปดาห์", month: "เดือน" },
      chart: (runs, from, to) => `จำนวนงานต่อช่วงเวลา ตั้งแต่ ${from} ถึง ${to} รวม ${count(runs)} งาน ตัวเลขอยู่ในตารางด้านล่าง`, // REVIEW
      table: "แสดงตัวเลข",
      when: "ช่วงเวลา",
      claudeRuns: "งานของ Claude Code",
      cost: "ค่าใช้จ่าย",
      codexRuns: "งานของ Codex",
      tokens: "โทเคน",
      total: "รวม",
      none: "ยังไม่มีงานในช่วงนี้",
      weekOf: (date) => `สัปดาห์ของ ${date}`, // REVIEW
    },

    settings: {
      heading: "ประวัติการทำงาน",
      lede: "ค่าเริ่มต้นของทุกงาน เปลี่ยนขีดจำกัดเฉพาะงานเดียวได้ในแบบฟอร์มงาน Codex ไม่มีวงเงินค่าใช้จ่าย ใช้เฉพาะเวลาสูงสุด", // REVIEW
      time: "เวลาสูงสุด",
      budget: "วงเงินค่าใช้จ่าย",
      retention: "เก็บประวัติการทำงานไว้",
      retentionOption: (days) => (days === 0 ? "ตลอดไป" : `${count(days)} วัน`),
      retentionHint: "บันทึกการทำงานและการเปลี่ยนแปลงของงานที่เสร็จแล้วเก็บไว้ในคอมพิวเตอร์เครื่องนี้เท่านั้น ไม่อยู่ใน Private Space และรายการที่เก่ากว่านั้นจะถูกลบอัตโนมัติ งานที่รอการตรวจจะถูกเก็บไว้เสมอ", // REVIEW
      clear: "ลบประวัติตอนนี้",
      clearConfirm: "ลบบันทึกการทำงานและการเปลี่ยนแปลงของทุกงานที่เสร็จแล้วหรือไม่ รายการงานยังอยู่",
      clearYes: "ลบ",
      clearNo: "เก็บไว้",
      cleared: (n) => (n === 0 ? "ไม่มีอะไรให้ลบ" : `ลบรายละเอียดที่บันทึกไว้ของ ${count(n)} งานแล้ว`),
    },
  },

  mascot: {
    name: "ผู้ช่วย Thoth",
    states: { idle: "พร้อม", listening: "กำลังฟัง", working: "กำลังทำงาน", review: "การเปลี่ยนแปลงพร้อมให้ตรวจ", done: "เสร็จแล้ว", error: "หยุดเพราะมีข้อผิดพลาด", sleeping: "กำลังพัก" }, // REVIEW
    announce: {
      idle: "ผู้ช่วย Thoth พร้อมแล้ว",
      listening: "ผู้ช่วย Thoth กำลังฟัง",
      working: "ผู้ช่วย Thoth กำลังทำงาน",
      review: "ผู้ช่วย Thoth: การเปลี่ยนแปลงพร้อมให้คุณตรวจแล้ว", // REVIEW
      done: "ผู้ช่วย Thoth: เสร็จแล้ว",
      error: "ผู้ช่วย Thoth: งานหยุดเพราะมีข้อผิดพลาด", // REVIEW
      sleeping: "ผู้ช่วย Thoth กำลังพัก", // REVIEW
    },
    hint: "คลิกเพื่อถาม ลากหรือใช้ปุ่มลูกศรเพื่อย้าย", // REVIEW
    reviewHint: "คลิกเพื่อตรวจการเปลี่ยนแปลง",
    shrink: "ย่อผู้ช่วย", // REVIEW
    expand: "ขยายผู้ช่วย", // REVIEW
    bubble: {
      title: "ถาม Thoth",
      close: "ปิด",
      context: "บริบท", // REVIEW
      contextNone: "ยังไม่มี เพิ่มหน้าได้ด้วยปุ่ม +",
      remove: (name) => `เอา ${name} ออก`,
      selection: (words) => `ข้อความที่เลือก (${count(words)} คำ)`, // REVIEW
      wholeSpace: "ทั้ง Private Space",
      workspacePage: (title) => `${title} (อ่านอย่างเดียว)`,
      add: "เพิ่มบริบท", // REVIEW
      addDone: "เสร็จ",
      agent: "เอเจนต์",
      agentOption: (name, state) => `${name} · ${state}`,
      options: "ตัวเลือก",
      task: "งาน",
      taskHint: "ให้ Thoth ทำอะไรกับหน้าเหล่านี้",
      working: "กำลังทำงาน…",
      reviewReady: "การเปลี่ยนแปลงพร้อมให้คุณตรวจแล้ว", // REVIEW
      openReview: "ตรวจการเปลี่ยนแปลง",
      openResult: "เปิดผลลัพธ์",
      settings: "การตั้งค่าผู้ช่วย",
      appliedSummary: (n) => (n === 0 ? "ไม่ได้นำการเปลี่ยนแปลงใดไปใช้" : `นำการเปลี่ยนแปลง ${count(n)} รายการไปใช้แล้ว`), // REVIEW
    },
    settings: {
      heading: "มาสคอต", // REVIEW
      lede: "มาสคอตลอยอยู่ที่มุมหน้าต่าง คลิกเพื่อถาม ลากเพื่อย้าย", // REVIEW
      show: "แสดงมาสคอต",
      size: "ขนาด",
      sizes: { compact: "เล็ก", full: "เต็มตัว", auto: "อัตโนมัติ" }, // REVIEW
      sizeHint: "อัตโนมัติจะแสดงเต็มตัว และย่อเล็กลงขณะที่คุณพิมพ์ในหน้าหรือเมื่อหน้าต่างแคบ", // REVIEW
      scale: "มาตราส่วน", // REVIEW
      scaleValue: (percent) => `${count(percent)}%`,
      motion: "การเคลื่อนไหว",
      motions: { full: "เต็มที่", calm: "นุ่มนวล", off: "ปิด" }, // REVIEW
      motionHint: "นุ่มนวลจะเคลื่อนไหวน้อยลงและช้าลง ปิดจะแสดงภาพนิ่งของแต่ละสถานะ เมื่อคอมพิวเตอร์ขอให้ลดการเคลื่อนไหว มาสคอตจะอยู่นิ่งไม่ว่าจะเลือกอะไรไว้ที่นี่", // REVIEW
      snap: "ชิดขอบอัตโนมัติ", // REVIEW
      snapHint: "เมื่อปล่อยมือ มาสคอตจะเลื่อนไปที่ขอบหรือมุมที่ใกล้ที่สุด", // REVIEW
      reset: "รีเซ็ตตำแหน่ง",
      resetDone: "กลับไปที่มุมขวาล่างแล้ว",
      preview: "ตัวอย่าง",
    },
  },

  // Thai for transfers was written by the implementer, not a native reviewer. Strings marked REVIEW are the
  // least certain (terminology for "move", "original", "conflict copy", and long result sentences).
  transfer: {
    select: "เลือกหน้า",
    selectDone: "เลือกเสร็จแล้ว",
    selectPage: (title) => `เลือก ${title}`,
    selected: (n) => `เลือกแล้ว ${count(n)} หน้า`,
    copyTo: "คัดลอกไปยังเวิร์กสเปซ…",
    moveTo: "ย้ายไปยังเวิร์กสเปซ…",
    copyHere: "คัดลอกมาที่ Private Space…",
    moveHere: "ย้ายมาที่ Private Space…",
    transfers: "การโอนย้าย", // REVIEW
    noWorkspaces: "เพิ่มเซิร์ฟเวอร์และเข้าสู่ระบบเวิร์กสเปซก่อน (การตั้งค่า → เซิร์ฟเวอร์)",

    titleTo: (mode, n) => `${mode === "copy" ? "คัดลอก" : "ย้าย"} ${count(n)} หน้าไปยังเวิร์กสเปซ`,
    titleFrom: (mode, title) => `${mode === "copy" ? "คัดลอก" : "ย้าย"} “${title}” มาที่ Private Space`,

    destination: "ปลายทาง",
    workspace: "เวิร์กสเปซ",
    chooseWorkspace: "เลือกเวิร์กสเปซ",
    parent: "วางหน้าไว้",
    topLevel: "ที่ระดับบนสุด",
    under: (title) => `ข้างใน “${title}”`,
    folder: "โฟลเดอร์ใน Private Space (เว้นว่างไว้เพื่อวางที่ระดับบนสุด)",
    folderHint: "หน้าที่เคยย้ายออกไปจาก Private Space นี้จะกลับไปที่เดิม ถ้าที่นั้นยังว่างอยู่",
    mode: "ต้นฉบับจะเป็นอย่างไร", // REVIEW
    copy: { title: "คัดลอก", hint: "ต้นฉบับอยู่ที่เดิม สำเนาจะมีตัวตนของตัวเอง" },
    moveToWs: { title: "ย้าย", hint: "ต้นฉบับจะถูกลบออกจาก Private Space หลังจากเวิร์กสเปซยืนยันครบทุกหน้าแล้ว หน้าที่คุณแก้ไขระหว่างนั้นจะยังเก็บไว้" },
    moveFromWs: { title: "ย้าย", hint: "หน้านี้จะถูกลบออกจากเวิร์กสเปซหลังจากอยู่ใน Private Space อย่างปลอดภัยแล้ว ถ้ามีคนแก้ไขระหว่างนั้น หน้าจะยังอยู่ในเวิร์กสเปซ" },
    attachments: "รวมไฟล์แนบที่หน้าเหล่านี้ลิงก์ถึง",

    checking: "กำลังตรวจดูว่าการโอนย้ายนี้จะทำอะไรบ้าง…", // REVIEW
    whoCanSee: "ใครเห็นได้บ้าง",
    visibleTo: (n) => (n === 1 ? "มีแค่คุณ ซึ่งเป็นสมาชิกคนเดียวของเวิร์กสเปซนี้" : `ทุกคนในเวิร์กสเปซนี้ (สมาชิก ${count(n)} คน) จะเห็นหน้าเหล่านี้`),
    membersHidden: (n) => `สมาชิก ${count(n)} คนจะเห็นหน้าเหล่านี้ เซิร์ฟเวอร์นี้ไม่แสดงรายชื่อ`,
    roles: { owner: "เจ้าของ", editor: "ผู้แก้ไข", viewer: "ผู้ดู" },
    you: (role) => `บทบาทของคุณ: ${role}`,
    pagesHeading: "หน้า",
    attachmentsHeading: (n) => `จะอัปโหลดไฟล์แนบ ${count(n)} ไฟล์`,
    linksHeading: "ลิงก์",
    links: {
      included: "ชี้ไปยังหน้าหรือไฟล์ในการโอนย้ายนี้ และจะถูกปรับให้ถูกต้อง",
      already_at_destination: "ชี้ไปยังหน้าที่อยู่ในเวิร์กสเปซแล้ว และจะถูกปรับให้ถูกต้อง",
      left_at_source: "ชี้ไปยังหน้าที่ไม่ได้ไปด้วย จึงคงเป้าหมายเดิมไว้",
      external: "เป็นลิงก์เว็บ และคงไว้ตามเดิม",
      unresolved: "ไม่ได้ชี้ไปยังสิ่งที่มีอยู่ จึงคงไว้ตามที่เขียน",
    },
    linksIn: "มองจากฝั่งเวิร์กสเปซ", // REVIEW
    flaggedTitle: "ลิงก์ที่จะใช้ไม่ได้ที่ปลายทาง",
    noLinks: "หน้าเหล่านี้ไม่มีลิงก์",
    nothingLeaves: "ยังไม่มีอะไรออกจากคอมพิวเตอร์เครื่องนี้",
    nothingLeavesFrom: "ยังไม่มีอะไรถูกเขียนลงใน Private Space",

    problems: {
      server_unknown: "เซิร์ฟเวอร์นี้ไม่อยู่ในรายการของคุณแล้ว",
      unreachable: (detail) => `ติดต่อเซิร์ฟเวอร์ไม่ได้ ${detail}`,
      signed_out: "คุณออกจากระบบเซิร์ฟเวอร์นี้แล้ว เข้าสู่ระบบอีกครั้งที่ การตั้งค่า → เซิร์ฟเวอร์",
      incompatible: "เซิร์ฟเวอร์นี้ใช้โปรโตคอลเวิร์กสเปซคนละเวอร์ชัน",
      no_transfers: "เซิร์ฟเวอร์นี้ไม่รับการโอนย้าย จึงปิดการคัดลอกและย้ายหน้าสำหรับเซิร์ฟเวอร์นี้",
      workspace_not_found: "เวิร์กสเปซนี้ไม่มีแล้ว หรือคุณไม่ได้เป็นสมาชิกแล้ว",
      forbidden: (role) => `คุณเป็น${role}ในเวิร์กสเปซนี้ ซึ่งทำสิ่งนี้ไม่ได้`,
      export_restricted: "เวิร์กสเปซนี้ไม่อนุญาตให้คัดลอกหรือย้ายหน้าออกไป เจ้าของเปิดการจำกัดการส่งออกไว้ และเซิร์ฟเวอร์บังคับใช้ข้อจำกัดนี้",
      not_editable: (path) => `${path} ไม่ใช่ข้อความ UTF-8 จึงใส่รหัสถาวรที่การโอนย้ายต้องใช้ไม่ได้`, // REVIEW
      malformed_frontmatter: (path) => `${path} มี frontmatter ที่ Thoth อ่านได้ไม่ปลอดภัย จึงใส่รหัสถาวรที่การโอนย้ายต้องใช้ไม่ได้`, // REVIEW
      page_too_large: (path, size, limit) => `${path} มีขนาด ${size} เซิร์ฟเวอร์นี้รับหน้าได้ไม่เกิน ${limit}`,
      too_large_total: (size, limit) => `หน้าเหล่านี้รวมกันมีขนาด ${size} เกินกว่าที่ส่งได้ในครั้งเดียว (${limit}) เลือกให้น้อยลง`,
      quota: (limit, current, adding) => `เวิร์กสเปซมีอยู่ ${count(current)} หน้า จากที่รับได้สูงสุด ${count(limit)} หน้า จึงเพิ่มอีก ${count(adding)} หน้าไม่ได้`,
      bad_folder: "ใช้โฟลเดอร์นี้ใน Private Space ไม่ได้",
      nothing_selected: "เลือกอย่างน้อยหนึ่งหน้า",
    },

    warnings: {
      unresolved_links: (n) => `มีลิงก์ ${count(n)} ลิงก์ที่ไม่ได้ชี้ไปยังสิ่งที่มีอยู่ จะคงไว้ตามที่เขียนทุกตัวอักษร`,
      left_at_source: (n) => `มีลิงก์ ${count(n)} ลิงก์ที่ชี้ไปยังหน้าที่ไม่ได้อยู่ในการโอนย้ายนี้ จึงจะเปิดไม่ได้ที่ปลายทาง`,
      attachments_unsupported: (n) => `เซิร์ฟเวอร์นี้ไม่รับไฟล์แนบ ไฟล์ที่ลิงก์ไว้ ${count(n)} ไฟล์จึงไม่ได้ไปด้วย`,
      attachment_too_large: (path, size, limit) => `${path} มีขนาด ${size} เกินขีดจำกัดต่อไฟล์ของเซิร์ฟเวอร์นี้ (${limit}) จึงไม่ได้ไปด้วย`,
      attachments_stay_in_workspace: (n) => `ไฟล์ที่ลิงก์ไว้ ${count(n)} ไฟล์ยังอยู่ในเวิร์กสเปซ การโอนย้ายจากเวิร์กสเปซมาที่ Private Space นำมาเฉพาะหน้า`,
      quota_near: (limit, current, adding) => `หลังจากนี้เวิร์กสเปซจะมี ${count(current + adding)} หน้า จากที่รับได้สูงสุด ${count(limit)} หน้า`,
    },

    cancel: "ยกเลิก",
    startCopy: "คัดลอก",
    startMove: "ย้าย",
    close: "ปิด",
    retry: "ลองอีกครั้ง",
    stop: "หยุดและย้อนกลับ", // REVIEW
    dismiss: "ซ่อน",
    openResult: "เปิด",

    working: "กำลังโอนย้าย…",
    states: {
      plan: "กำลังวางแผน",
      validate: "กำลังตรวจสิทธิ์และข้อจำกัด",
      stage: "กำลังเตรียมที่ปลายทาง",
      transfer: "กำลังส่ง",
      verify: "กำลังตรวจสอบ",
      commit_destination: "กำลังบันทึกที่ปลายทาง",
      finalize_source: "กำลังลบต้นฉบับ",
      done: "เสร็จแล้ว",
      destination_committed_source_cleanup_pending: "เสร็จแล้ว แต่ยังเก็บต้นฉบับไว้", // REVIEW
      failed: "ไม่ได้โอนย้าย",
      aborted: "หยุดแล้ว",
    },
    progressLabel: "ความคืบหน้าของการโอนย้าย",

    resultDone: (mode, n, where) => `${mode === "copy" ? "คัดลอก" : "ย้าย"} ${count(n)} หน้าไปยัง ${where} แล้ว ทุกหน้าได้รับการตรวจสอบที่ปลายทางแล้ว`,
    resultPending: (moved, kept, where) =>
      `ตอนนี้ ${count(moved)} หน้าอยู่ใน ${where} แล้ว แต่การย้ายยังไม่เสร็จ: เก็บต้นฉบับไว้ ${count(kept)} หน้า เพราะมีการแก้ไขหลังจากเริ่มโอนย้าย ไม่มีอะไรหาย ลองเทียบทั้งสองฉบับ แล้วลบฉบับที่ไม่ต้องการ`, // REVIEW
    resultFailed: (detail) => `ไม่มีอะไรถูกโอนย้าย และต้นฉบับไม่ได้เปลี่ยนแปลง ${detail}`,
    resultAborted: "หยุดและย้อนกลับการโอนย้ายแล้ว ปลายทางไม่มีอะไรเปลี่ยน และต้นฉบับไม่ได้เปลี่ยนแปลง",
    resultInterrupted: (detail) => `การโอนย้ายถูกขัดจังหวะ: ${detail} ต้นฉบับของคุณปลอดภัย ลองอีกครั้ง หรือหยุดและย้อนกลับ`,
    keptItems: "ต้นฉบับที่เก็บไว้",
    keptReason: {
      source_changed: "ถูกแก้ไขหลังเริ่มโอนย้าย",
      source_moved: "ถูกย้ายที่หลังเริ่มโอนย้าย",
      revision_conflict: "ถูกแก้ไขในเวิร์กสเปซหลังเริ่มโอนย้าย",
      hash_mismatch: "ตรวจสอบที่ปลายทางไม่ผ่าน",
    },
    keptOther: "เก็บไว้เพื่อความปลอดภัย",
    conflictCopies: (n) => `มี ${count(n)} หน้าที่อยู่ที่นี่แล้วและมีการแก้ไขอื่น จึงบันทึกไว้ข้างต้นฉบับเป็นสำเนาที่ขัดแย้ง`, // REVIEW
    privateSpace: "Private Space ของคุณ",

    recoveredTitle: "การโอนย้ายที่ยังไม่เสร็จ",
    recoveredCompleted: (n) => `ทำการโอนย้าย ${count(n)} รายการที่ถูกขัดจังหวะเมื่อปิด Thoth ครั้งก่อนให้เสร็จแล้ว`,
    recoveredRolledBack: (n) => `ย้อนกลับการโอนย้าย ${count(n)} รายการที่ถูกขัดจังหวะก่อนบันทึกที่ปลายทางแล้ว ต้นฉบับไม่ได้เปลี่ยนแปลง`,
    recoveredWaiting: (n) => `ยังจัดการการโอนย้าย ${count(n)} รายการไม่ได้ เพราะติดต่อเซิร์ฟเวอร์ไม่ได้ Thoth จะลองใหม่ครั้งหน้า`,
    pendingList: "การย้ายที่ยังเก็บต้นฉบับไว้",
    pendingItem: (n, where) => `เก็บต้นฉบับไว้ ${count(n)} หน้า · ${where}`,
  },

  wizard: {
    region: "นำเข้า",
    titles: {
      source: "เลือกแหล่งที่มา",
      instructions: "เตรียมไฟล์ส่งออก",
      pick: "เลือกไฟล์ส่งออก",
      preview: "ดูตัวอย่าง",
      destination: "ปลายทาง",
      options: "ตัวเลือก",
      run: "กำลังนำเข้า",
      report: "รายงาน",
    },
    stepOf: (step, total) => `นำเข้าและส่งออก · ขั้นที่ ${step} จาก ${total}`,
    close: "ปิด",
    back: "ย้อนกลับ",
    continue: "ต่อไป",
    backToStart: "กลับไปเริ่มใหม่",

    source: {
      question: "โน้ตของคุณมาจากที่ไหน",
      hints: { notion: "ไฟล์ส่งออกแบบ Markdown & CSV (ZIP หรือโฟลเดอร์ที่แตกไฟล์แล้ว)", obsidian: "โฟลเดอร์ vault หรือไฟล์ ZIP ของ vault" },
      unfinished: "การนำเข้าที่ยังไม่เสร็จ",
      state: { cancelled: "ยกเลิกแล้ว", failed: "มีข้อผิดพลาด", interrupted: "หยุดกลางคัน" },
      progress: (done, total, into) => `นำเข้าแล้ว ${count(done)} จาก ${count(total)} รายการ ไปที่ ${into}`,
      topLevel: "ระดับบนสุด",
      resume: "ทำต่อ",
      resumeLabel: (source) => `นำเข้า ${source} ต่อ`,
    },

    how: {
      notion: {
        title: "ส่งออกจาก Notion",
        steps: [
          "ใน Notion เปิด Settings แล้วเลือก Export all workspace content (หรือใช้เมนู ... ของหน้าใดหน้าหนึ่ง แล้วเลือก Export)",
          "เลือกรูปแบบ Markdown & CSV เลือกรวมหน้าย่อย และรวมฐานข้อมูลเป็น CSV",
          "Notion จะส่งอีเมลหรือดาวน์โหลดไฟล์ ZIP ให้ เก็บ ZIP ไว้ตามเดิม หรือจะแตกไฟล์แล้วเลือกโฟลเดอร์ก็ได้",
        ],
        note: "Notion สร้างเวิร์กสเปซของคุณกลับมาจากไฟล์ส่งออกไม่ได้ทั้งหมด การย้ายจึงทำได้เท่าที่ทำได้ หน้าตัวอย่างจะบอกว่าอะไรย้ายมาได้และอะไรไม่ได้",
      },
      obsidian: {
        title: "เตรียม vault ของ Obsidian",
        steps: [
          "ปิด Obsidian หรืออย่างน้อยรอให้ซิงก์เสร็จ ไฟล์จะได้ไม่เปลี่ยนระหว่างที่ Thoth อ่าน",
          "เลือกโฟลเดอร์ vault โดยตรง (โฟลเดอร์ที่มีโน้ตและโฟลเดอร์ .obsidian) หรือไฟล์ ZIP ของ vault",
          "ไม่ต้องคัดลอกอะไร Thoth อ่าน vault อย่างเดียวและไม่เปลี่ยนแปลงเลย",
        ],
        note: "การตั้งค่าและโค้ดปลั๊กอินของ Obsidian ไม่ถูกนำเข้า ไวยากรณ์ของปลั๊กอินอย่าง Dataview จะเก็บไว้เป็นข้อความธรรมดา",
      },
    },
    ready: "เตรียมไว้แล้ว",

    pick: {
      title: { notion: "เลือกไฟล์ส่งออกจาก Notion", obsidian: "เลือก vault ของ Obsidian" },
      note: "Thoth จะสแกนแล้วแสดงตัวอย่างให้ดู ยังไม่มีอะไรถูกนำเข้าหรือเปลี่ยนแปลง",
      zip: "เลือกไฟล์ ZIP",
      folder: "เลือกโฟลเดอร์",
      scanning: "กำลังสแกนและตรวจสอบแหล่งที่มา…",
    },

    preview: {
      of: "ตัวอย่างของ ",
      contents: "สิ่งที่จะนำเข้า",
      stats: { pages: "หน้า", folders: "โฟลเดอร์", attachments: "ไฟล์แนบ", databases: "ฐานข้อมูล / CSV", skipped: "ข้าม" },
      links: "ลิงก์",
      linkStats: { resolved: "เชื่อมได้", unresolved: "ไม่พบปลายทาง", ambiguous: "ตรงกับหลายหน้า", external: "ลิงก์ภายนอก" },
      already: (n, where) => `เนื้อหานี้เคยนำเข้าแล้ว ${count(n)} ครั้ง (ไปที่ ${where}) ถ้านำเข้าอีกจะได้สำเนาแยกกัน`,
      duplicates: (n) => `ชื่อหน้าซ้ำกัน (${count(n)})`,
      duplicatesNote: "หน้าที่ชื่อซ้ำกันจะไม่ถูกรวมกัน แต่ละหน้าเก็บเป็นไฟล์ของตัวเอง",
      pagesCount: (n) => `${count(n)} หน้า`,
      collisions: (n) => `ชื่อชนกัน (${count(n)})`,
      collisionsNote: "รายการเหล่านี้จะชนกับไฟล์ที่มีอยู่หรือชนกันเอง ขั้นตัวเลือกจะเป็นตัวกำหนดว่าจะเปลี่ยนชื่อหรือข้าม",
      warnings: "คำเตือน",
      noWarnings: "ไม่มีคำเตือน",
      andMore: (n) => `และอีก ${count(n)} รายการ`,
      safe: "Thoth แค่อ่านแหล่งที่มาของคุณ ไม่เปลี่ยน ไม่ย้าย และไม่ลบ",
      another: "เลือกแหล่งอื่น",
    },

    destination: {
      question: "จะให้หน้าที่นำเข้าไปอยู่ที่ไหน",
      privateNote: "ไฟล์อยู่ในคอมพิวเตอร์ของคุณเป็น Markdown",
      workspace: "เวิร์กสเปซ",
      later: "เร็ว ๆ นี้",
      folder: "โฟลเดอร์ใน Private Space ของคุณ (เว้นว่างไว้เพื่อใส่ที่ระดับบนสุด)",
      ok: "ไฟล์ที่นำเข้าจะถูกเพิ่มไว้ที่นี่ ไม่มีไฟล์เดิมถูกเขียนทับ",
      reserved: "โฟลเดอร์ .thoth สงวนไว้ให้ Thoth ใช้",
      invalid: "นี่ไม่ใช่ตำแหน่งโฟลเดอร์ที่ใช้ได้ใน Private Space ของคุณ",
    },

    options: {
      question: "ถ้ามีไฟล์ชื่อเดียวกันอยู่แล้ว",
      rename: { title: "เก็บไว้ทั้งคู่ (เปลี่ยนชื่อไฟล์ใหม่)", hint: "ไฟล์ที่นำเข้าจะมีตัวเลขต่อท้าย ไม่มีอะไรถูกเขียนทับ" },
      skip: { title: "ข้ามไป", hint: "ไฟล์เดิมยังอยู่ และไม่เพิ่มไฟล์ที่นำเข้า" },
      identity: "เพิ่ม frontmatter ระบุตัวตนให้หน้าที่นำเข้า",
      identityHint: "เขียน thoth_id และที่มาของหน้า (thoth_source) ไว้ด้านบนของแต่ละหน้าที่นำเข้า ช่วยให้ลิงก์และการนำเข้าซ้ำคงที่ และจะเห็นเป็นบล็อกข้อมูลเล็ก ๆ ในไฟล์ Markdown แหล่งที่มาไม่ถูกเปลี่ยนแปลง",
      preparing: "กำลังเตรียม…",
      start: "เริ่มนำเข้า",
    },

    run: {
      title: "กำลังนำเข้า",
      cancelling: "กำลังยกเลิก…",
      phases: { staging: "อ่านและแปลงไฟล์", verifying: "ตรวจสอบ", committing: "เพิ่มลงใน Private Space" },
      waiting: "รอ",
      errors: (n) => `รายการที่มีข้อผิดพลาด (${count(n)})`,
      note: "ยกเลิกได้ทุกเมื่อ สิ่งที่เพิ่มไปแล้วจะยังอยู่ และกลับมาทำต่อทีหลังได้",
      cancel: "ยกเลิกการนำเข้า",
    },

    report: {
      headline: { completed: "นำเข้าเสร็จแล้ว", cancelled: "ยกเลิกการนำเข้าแล้ว", failed: "นำเข้าเสร็จแต่มีข้อผิดพลาด", other: "นำเข้าเสร็จแล้ว" },
      results: "ผลการนำเข้า",
      stats: { pages: "หน้าที่นำเข้า", attachments: "ไฟล์แนบ", databases: "ฐานข้อมูล / CSV", skipped: "ข้าม", failed: "ไม่สำเร็จ", warnings: "คำเตือน" },
      failedItems: "รายการที่ไม่สำเร็จ",
      links: (resolved, unresolved, ambiguous) => `ลิงก์: เชื่อมได้ ${count(resolved)} ไม่พบปลายทาง ${count(unresolved)} ตรงกับหลายหน้า ${count(ambiguous)}`,
      safe: "Thoth แค่อ่านแหล่งที่มาของคุณ ไม่ได้เปลี่ยน ย้าย หรือลบ",
      openLabel: (folder) => `เปิดโฟลเดอร์ที่นำเข้า ${folder ?? "(ระดับบนสุด)"}`,
      open: (name) => `เปิด${name === null ? "หน้าที่นำเข้า" : ` “${name}”`}`,
    },

    warnings: {
      unresolved_link: { title: "ลิงก์ไปยังหน้าที่ไม่ได้อยู่ในการนำเข้า", explanation: "ลิงก์เหล่านี้ชี้ไปยังสิ่งที่ไม่ได้อยู่ในไฟล์ส่งออก จึงเก็บไว้ตามที่เขียน และจะใช้ได้ถ้านำเข้าหน้านั้นทีหลัง" },
      ambiguous_link: { title: "ลิงก์ที่ตรงกับหลายหน้า", explanation: "ลิงก์เหล่านี้ตรงกับไฟล์มากกว่าหนึ่งไฟล์ Thoth จึงไม่เดา และเก็บไว้ตามเดิม" },
      link_not_rewritable: { title: "ลิงก์ที่เขียนใหม่ไม่ได้", explanation: "ตำแหน่งใหม่ของปลายทางมีอักขระที่ใส่ในลิงก์ไม่ได้ ลิงก์จึงเก็บข้อความเดิมไว้" },
      renamed_on_collision: { title: "เปลี่ยนชื่อเพื่อไม่ให้ชื่อชนกัน", explanation: "มีไฟล์ชื่อเดียวกันอยู่แล้ว (หรือมีซ้ำสองครั้ง) จึงต่อท้ายด้วยตัวเลข ไม่มีอะไรถูกเขียนทับ" },
      destination_exists: { title: "ข้ามเพราะมีไฟล์อยู่แล้ว", explanation: "คุณตั้งให้ข้ามเมื่อชื่อชนกัน ไฟล์เดิมจึงไม่ถูกแตะต้อง และรายการเหล่านี้ไม่ได้นำเข้า" },
      file_folder_conflict: { title: "ชื่อเดียวใช้เป็นทั้งไฟล์และโฟลเดอร์", explanation: "วางรายการเหล่านี้ไม่ได้ เพราะต้องใช้ชื่อเดียวกันเป็นทั้งไฟล์และโฟลเดอร์ จึงข้ามไป" },
      reserved_path: { title: "อยู่ในโฟลเดอร์ .thoth", explanation: "Thoth เก็บข้อมูลของตัวเองไว้ในโฟลเดอร์ .thoth และไม่นำเข้าไปในนั้นเด็ดขาด รายการเหล่านี้จึงถูกข้าม" },
      skipped_metadata: { title: "ข้ามข้อมูลของเครื่องมือ", explanation: "โฟลเดอร์ข้อมูลของระบบควบคุมเวอร์ชันและของ Thoth ไม่ถูกนำเข้า" },
      obsidian_config_skipped: { title: "ข้ามการตั้งค่า Obsidian", explanation: "การตั้งค่าแอปและปลั๊กอินของ Obsidian ไม่ถูกนำเข้า และโค้ดปลั๊กอินไม่ถูกเรียกใช้" },
      plugin_syntax: { title: "ไวยากรณ์ที่ต้องใช้ปลั๊กอิน", explanation: "ไวยากรณ์ของ Dataview, Templater และปลั๊กอินแบบเดียวกันเก็บไว้เป็นข้อความหรือโค้ด และจะไม่ทำงานใน Thoth" },
      obsidian_comment: { title: "ความคิดเห็นของ Obsidian", explanation: "ความคิดเห็นแบบ %% … %% เก็บไว้เป็นข้อความ และจะมองเห็นได้ใน Thoth" },
      custom_task_status: { title: "สถานะงานแบบกำหนดเอง", explanation: "งานอย่าง [/] เก็บไว้เป็นข้อความ ไม่ใช่ช่องติ๊ก" },
      embed_size: { title: "ขนาดของสิ่งที่ฝัง", explanation: "ขนาดอย่าง ![[image|300]] เก็บไว้ในไฟล์ แต่ยังไม่นำไปใช้ตอนแสดงผล" },
      html_block: { title: "บล็อก HTML เก็บไว้ตามต้นฉบับ", explanation: "Notion ส่งออกส่วนเหล่านี้ (เช่น กล่องเน้นข้อความหรือบล็อกพับได้) เป็น HTML จึงเก็บไว้ตามเดิม ไม่ได้แปลงเป็นบล็อกของ Thoth" },
      notion_url_link: { title: "ลิงก์ไปยัง notion.so", explanation: "ลิงก์เหล่านี้ชี้ไปยังหน้า Notion ที่อาจไม่ได้อยู่ในไฟล์ส่งออก จึงเก็บไว้เป็นลิงก์เว็บ" },
      database_semantics_lost: { title: "ฐานข้อมูลนำเข้าเป็น CSV", explanation: "ฐานข้อมูลแต่ละอันกลายเป็นไฟล์ CSV ต้นฉบับ ความสัมพันธ์ สูตร rollup มุมมอง และระบบอัตโนมัติไม่ถูกสร้างขึ้นใหม่" },
      database_view_csv: { title: "ไฟล์ส่งออกของมุมมองฐานข้อมูล", explanation: "CSV นี้มีแค่มุมมองหนึ่งของฐานข้อมูล ไฟล์ส่งออกฉบับเต็มนำเข้ามาด้วยกัน" },
      csv_ragged_rows: { title: "แถว CSV ไม่เท่ากัน", explanation: "บางแถวมีจำนวนคอลัมน์ไม่เท่ากับหัวตาราง ไฟล์ถูกนำเข้าโดยไม่เปลี่ยนแปลง" },
      csv_not_utf8: { title: "CSV ไม่ใช่ UTF-8", explanation: "ไฟล์ถูกคัดลอกมาทุกไบต์ตามเดิม และอาจแสดงอักขระแปลก ๆ ในโปรแกรมอื่น" },
      invalid_utf8: { title: "หน้าที่ไม่ใช่ UTF-8", explanation: "หน้าเหล่านี้ถูกคัดลอกมาทุกไบต์ตามเดิม เปิดได้แบบอ่านอย่างเดียว และลิงก์ไม่ถูกเขียนใหม่" },
      malformed_frontmatter: { title: "อ่าน frontmatter ไม่ได้", explanation: "อ่านบล็อกข้อมูลของหน้าไม่ได้ หน้าจึงนำเข้าตามต้นฉบับโดยไม่แก้ไข" },
      identity_not_written: { title: "ไม่ได้เขียน Thoth ID", explanation: "การเพิ่ม ID ต้องแก้เนื้อหาที่ Thoth อ่านได้ไม่ปลอดภัย หน้าเหล่านี้จึงได้ ID ชั่วคราวในดัชนีแทน" },
      unsafe_path: { title: "ปฏิเสธตำแหน่งที่ไม่ปลอดภัย", explanation: "รายการที่ตำแหน่งอาจหลุดออกนอกปลายทาง (เช่น ../) ถูกปฏิเสธเพื่อความปลอดภัย" },
      symlink_entry: { title: "ไม่ตามทางลัด", explanation: "Thoth ไม่ตามลิงก์สัญลักษณ์ (symbolic link) จึงไม่นำเข้ารายการเหล่านี้" },
      special_entry: { title: "ข้ามไฟล์พิเศษ", explanation: "รายการที่ไม่ใช่ไฟล์ธรรมดาถูกข้าม" },
      duplicate_entry: { title: "รายการซ้ำ", explanation: "ตำแหน่งเดียวกันปรากฏมากกว่าหนึ่งครั้ง เก็บไว้เฉพาะรายการแรก" },
      entry_too_large: { title: "ไฟล์ใหญ่เกินขีดจำกัด", explanation: "ไฟล์เหล่านี้ใหญ่เกินขีดจำกัดความปลอดภัยต่อไฟล์ จึงไม่ได้นำเข้า" },
      encrypted_entry: { title: "รายการที่เข้ารหัส", explanation: "อ่านรายการในไฟล์บีบอัดที่ตั้งรหัสผ่านไว้ไม่ได้ จึงข้ามไป" },
      nested_archive: { title: "ไฟล์บีบอัดซ้อนกัน", explanation: "ไฟล์บีบอัดที่ซ้อนลึกเกินหนึ่งชั้นจะไม่ถูกเปิด" },
    },
    unknownWarning: "ตัวนำเข้ารายงานเรื่องนี้ ดูรายละเอียดของไฟล์ที่เกี่ยวข้องด้านล่าง",
  },
};

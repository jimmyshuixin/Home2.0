export const seedPages = [
  {
    id: "cover",
    kind: "cover",
    title: "Home 2.0",
    date: "封面",
    mood: "生活手账",
    excerpt: "一本翻得动、写得上去、可以贴照片的个人网站。",
    image: "/images/window-desk-journal.png",
    elements: []
  },
  {
    id: "contents",
    kind: "toc",
    title: "目录",
    date: "contents",
    mood: "慢慢翻",
    excerpt: "日常小记 / 走走停停 / 喜欢的瞬间 / 给未来的便签",
    elements: []
  },
  {
    id: "morning",
    kind: "entry",
    title: "窗边的早晨",
    date: "05.29",
    mood: "晴",
    excerpt: "把茶放在窗边，光就会自己慢慢爬到纸上。",
    image: "/images/window-desk-journal.png",
    elements: [
      {
        id: "morning-text",
        type: "text",
        text: "今天先写一点点，像给生活按下书签。",
        x: 14,
        y: 62,
        width: 32,
        rotate: -3,
        color: "#25322d"
      },
      {
        id: "morning-tape",
        type: "tape",
        x: 58,
        y: 12,
        width: 24,
        rotate: 7,
        color: "sky"
      }
    ]
  },
  {
    id: "walk",
    kind: "entry",
    title: "散步路线",
    date: "05.30",
    mood: "微风",
    excerpt: "路边的小店、便利贴一样的云，还有突然想记下来的句子。",
    elements: [
      {
        id: "walk-note",
        type: "text",
        text: "大众能看懂，也能感觉到一点私人生活的温度。",
        x: 16,
        y: 22,
        width: 52,
        rotate: 2,
        color: "#2c312e"
      },
      {
        id: "walk-sticker",
        type: "sticker",
        text: "today",
        x: 64,
        y: 55,
        width: 20,
        rotate: -8,
        color: "coral"
      }
    ]
  }
];

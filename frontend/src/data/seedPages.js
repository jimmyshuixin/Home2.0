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
    image: "/images/coastal-road-journal.png",
    elements: [
      {
        id: "walk-note",
        type: "text",
        text: "收集瞬间，不收集事情。",
        x: 13,
        y: 66,
        width: 36,
        rotate: 2,
        color: "#2c312e"
      },
      {
        id: "walk-sticker",
        type: "sticker",
        text: "keep going",
        x: 66,
        y: 72,
        width: 18,
        rotate: -8,
        color: "coral"
      },
      {
        id: "walk-tape",
        type: "tape",
        x: 50,
        y: 10,
        width: 22,
        rotate: -5,
        color: "coral"
      }
    ]
  }
];

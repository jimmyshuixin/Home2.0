import cors from "cors";
import express from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, "data");
const pagesFile = path.join(dataDir, "pages.json");

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === allowedOrigin) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"));
    }
  })
);
app.use(express.json({ limit: "8mb" }));

async function ensureStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    await readFile(pagesFile, "utf8");
  } catch {
    await writeFile(pagesFile, "[]", "utf8");
  }
}

async function readPages() {
  await ensureStore();
  const raw = await readFile(pagesFile, "utf8");
  return JSON.parse(raw);
}

async function writePages(pages) {
  await ensureStore();
  await writeFile(pagesFile, `${JSON.stringify(pages, null, 2)}\n`, "utf8");
}

function trimText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeElement(element) {
  const type = ["text", "image", "tape", "sticker"].includes(element?.type)
    ? element.type
    : "text";

  return {
    id: trimText(element?.id, 80) || crypto.randomUUID(),
    type,
    x: Number.isFinite(element?.x) ? Math.max(0, Math.min(100, element.x)) : 12,
    y: Number.isFinite(element?.y) ? Math.max(0, Math.min(100, element.y)) : 12,
    rotate: Number.isFinite(element?.rotate)
      ? Math.max(-25, Math.min(25, element.rotate))
      : 0,
    text: trimText(element?.text, 420),
    src: typeof element?.src === "string" && element.src.startsWith("data:image/")
      ? element.src.slice(0, 2_000_000)
      : "",
    color: trimText(element?.color, 40),
    width: Number.isFinite(element?.width) ? Math.max(8, Math.min(65, element.width)) : 28
  };
}

function sanitizePage(body) {
  const elements = Array.isArray(body?.elements)
    ? body.elements.slice(0, 36).map(sanitizeElement)
    : [];

  return {
    id: crypto.randomUUID(),
    title: trimText(body?.title, 80) || "未命名手账",
    date: trimText(body?.date, 24) || new Date().toISOString().slice(0, 10),
    mood: trimText(body?.mood, 24) || "日常",
    excerpt: trimText(body?.excerpt, 180),
    drawing:
      typeof body?.drawing === "string" && body.drawing.startsWith("data:image/")
        ? body.drawing.slice(0, 2_000_000)
        : "",
    elements,
    createdAt: new Date().toISOString()
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "home2-backend" });
});

app.get("/api/pages", async (_req, res, next) => {
  try {
    const pages = await readPages();
    res.json({ pages });
  } catch (error) {
    next(error);
  }
});

app.post("/api/pages", async (req, res, next) => {
  try {
    const page = sanitizePage(req.body);
    const pages = await readPages();
    pages.unshift(page);
    await writePages(pages.slice(0, 120));
    res.status(201).json({ page });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/pages/:id", async (req, res, next) => {
  try {
    const pages = await readPages();
    const nextPages = pages.filter((page) => page.id !== req.params.id);
    await writePages(nextPages);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "手账暂时没有保存成功，请稍后再试。" });
});

app.listen(port, () => {
  console.log(`Home2 backend listening on http://localhost:${port}`);
});

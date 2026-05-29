<script setup>
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { ImagePlus, MousePointer2, Pen, Plus, Save, Sparkles, StickyNote, X } from "@lucide/vue";
import { runtimePort } from "../platform/runtimePort";

const emit = defineEmits(["save-page", "close"]);

const title = ref("今天的小页");
const excerpt = ref("把照片、字句和一点点涂画放进这一页。");
const activeTool = ref("pen");
const noteDraft = ref("写在纸上的一句话");
const elements = ref([
  {
    id: runtimePort.createId(),
    type: "text",
    text: "拖动我，像挪一张便签。",
    x: 58,
    y: 32,
    width: 34,
    rotate: -4,
    color: "#26312d"
  },
  {
    id: runtimePort.createId(),
    type: "tape",
    x: 58,
    y: 12,
    width: 22,
    rotate: 6,
    color: "sky"
  }
]);

const canvasRef = ref(null);
const boardRef = ref(null);
const isDrawing = ref(false);
const dragState = ref(null);

onMounted(() => {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
});

onUnmounted(() => {
  window.removeEventListener("resize", resizeCanvas);
});

function resizeCanvas() {
  const canvas = canvasRef.value;
  const board = boardRef.value;
  if (!canvas || !board) return;
  const rect = board.getBoundingClientRect();
  const snapshot = canvas.toDataURL("image/png");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext("2d");
  const image = new Image();
  image.onload = () => context.drawImage(image, 0, 0, rect.width, rect.height);
  image.src = snapshot;
}

function canvasPoint(event) {
  const rect = canvasRef.value.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function startDrawing(event) {
  if (activeTool.value !== "pen") return;
  isDrawing.value = true;
  const context = canvasRef.value.getContext("2d");
  const point = canvasPoint(event);
  context.lineWidth = 3.2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#26312d";
  context.beginPath();
  context.moveTo(point.x, point.y);
}

function draw(event) {
  if (!isDrawing.value) return;
  const context = canvasRef.value.getContext("2d");
  const point = canvasPoint(event);
  context.lineTo(point.x, point.y);
  context.stroke();
}

function stopDrawing() {
  isDrawing.value = false;
}

function addNote() {
  elements.value.push({
    id: runtimePort.createId(),
    type: "text",
    text: noteDraft.value || "新的手写便签",
    x: 18 + Math.random() * 18,
    y: 18 + Math.random() * 20,
    width: 34,
    rotate: Math.round(Math.random() * 10 - 5),
    color: "#27342f"
  });
}

function addTape() {
  elements.value.push({
    id: runtimePort.createId(),
    type: "tape",
    x: 42 + Math.random() * 22,
    y: 12 + Math.random() * 38,
    width: 22,
    rotate: Math.round(Math.random() * 18 - 9),
    color: Math.random() > 0.5 ? "coral" : "sky"
  });
}

function addSticker() {
  elements.value.push({
    id: runtimePort.createId(),
    type: "sticker",
    text: "nice",
    x: 56 + Math.random() * 20,
    y: 48 + Math.random() * 24,
    width: 18,
    rotate: Math.round(Math.random() * 16 - 8),
    color: "coral"
  });
}

async function uploadPhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 2_000_000) {
    alert("请选择 2MB 以内的图片。");
    return;
  }

  try {
    const src = await runtimePort.fileToDataUrl(file);
    elements.value.push({
      id: runtimePort.createId(),
      type: "image",
      src,
      x: 38,
      y: 24,
      width: 36,
      rotate: 4,
      color: ""
    });
  } finally {
    event.target.value = "";
  }
}

function startDrag(element, event) {
  if (activeTool.value === "pen") return;
  const rect = boardRef.value.getBoundingClientRect();
  dragState.value = {
    id: element.id,
    offsetX: event.clientX - rect.left - (element.x / 100) * rect.width,
    offsetY: event.clientY - rect.top - (element.y / 100) * rect.height
  };
}

function drag(event) {
  if (!dragState.value) return;
  const rect = boardRef.value.getBoundingClientRect();
  const element = elements.value.find((item) => item.id === dragState.value.id);
  if (!element) return;
  element.x = Math.max(2, Math.min(82, ((event.clientX - rect.left - dragState.value.offsetX) / rect.width) * 100));
  element.y = Math.max(2, Math.min(84, ((event.clientY - rect.top - dragState.value.offsetY) / rect.height) * 100));
}

function stopDrag() {
  dragState.value = null;
}

async function savePage() {
  await nextTick();
  emit("save-page", {
    title: title.value,
    date: new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
    mood: "新页",
    excerpt: excerpt.value,
    drawing: runtimePort.canvasToImage(canvasRef.value),
    elements: elements.value
  });
}
</script>

<template>
  <section class="studio-stage" aria-label="手账画板">
    <div class="studio-bar">
      <button type="button" @click="emit('close')">← 回到手账</button>
      <span>Editing {{ title }}</span>
      <span>✓ H5 草稿</span>
      <button type="button" @click="savePage">保存页面</button>
    </div>

    <div class="tool-sash" aria-label="画板工具">
      <button :class="{ active: activeTool === 'pen' }" type="button" @click="activeTool = 'pen'">
        <Pen :size="19" />
        画笔
      </button>
      <button :class="{ active: activeTool === 'select' }" type="button" @click="activeTool = 'select'">
        <MousePointer2 :size="19" />
        挪动
      </button>
      <button type="button" @click="addNote">
        <StickyNote :size="19" />
        便签
      </button>
      <label class="upload-button">
        <ImagePlus :size="19" />
        照片
        <input type="file" accept="image/*" @change="uploadPhoto" />
      </label>
      <button type="button" @click="addTape">
        <Plus :size="19" />
        胶带
      </button>
      <button type="button" @click="addSticker">
        <Sparkles :size="19" />
        贴纸
      </button>
    </div>

    <form class="studio-meta" @submit.prevent="savePage">
      <label>
        标题
        <input v-model="title" maxlength="32" />
      </label>
      <label>
        页边小字
        <textarea v-model="excerpt" maxlength="120"></textarea>
      </label>
      <label>
        新便签
        <textarea v-model="noteDraft" maxlength="120"></textarea>
      </label>
      <div class="studio-actions">
        <button type="submit">
          <Save :size="18" />
          保存
        </button>
        <button type="button" @click="emit('close')">
          <X :size="18" />
          合上
        </button>
      </div>
    </form>

    <div
      ref="boardRef"
      class="paper-board"
      @pointermove="drag"
      @pointerup="stopDrag"
      @pointerleave="stopDrag"
    >
      <div class="board-heading">
        <h1>{{ title }}</h1>
        <p>{{ excerpt }}</p>
      </div>

      <canvas
        ref="canvasRef"
        class="draw-layer"
        @pointerdown="startDrawing"
        @pointermove="draw"
        @pointerup="stopDrawing"
        @pointerleave="stopDrawing"
      ></canvas>

      <div
        v-for="element in elements"
        :key="element.id"
        class="studio-element"
        :class="'element-' + element.type"
        :style="{
          left: element.x + '%',
          top: element.y + '%',
          width: element.width + '%',
          transform: 'rotate(' + element.rotate + 'deg)'
        }"
        @pointerdown.stop="startDrag(element, $event)"
      >
        <span v-if="element.type === 'tape'" :class="['tape-strip', element.color]">tape</span>
        <img v-else-if="element.type === 'image'" :src="element.src" alt="" />
        <span v-else-if="element.type === 'sticker'" class="sticker-dot">{{ element.text }}</span>
        <span v-else>{{ element.text }}</span>
      </div>
    </div>
  </section>
</template>

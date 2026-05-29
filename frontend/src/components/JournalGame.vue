<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const GAME_SECONDS = 45;

const spriteTypes = [
  { type: "tape", label: "胶带", score: 8 },
  { type: "heart", label: "爱心", score: 10 },
  { type: "leaf", label: "叶子", score: 12 },
  { type: "camera", label: "相机", score: 14 },
  { type: "photo", label: "照片", score: 16 },
  { type: "ink", label: "墨水", score: 0, hazard: true }
];

const emit = defineEmits(["close"]);

const stageRef = ref(null);
const running = ref(false);
const finished = ref(false);
const score = ref(0);
const lives = ref(3);
const timeLeft = ref(GAME_SECONDS);
const catcherX = ref(50);
const falling = ref([]);
const bestScore = ref(Number(window.localStorage.getItem("home2-game-best") || 0));

let frameId = 0;
let lastFrame = 0;
let spawnClock = 0;
let timerId = 0;
let objectId = 0;

const statusText = computed(() => {
  if (finished.value) return score.value >= 120 ? "这一页贴得很满" : "再贴一次会更好";
  if (running.value) return lives.value > 1 ? "接住贴纸，避开墨水" : "小心，最后一次机会";
  return "按开始，把素材接进手账";
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function moveCatcher(clientX) {
  const rect = stageRef.value?.getBoundingClientRect();
  if (!rect) return;
  catcherX.value = clamp(((clientX - rect.left) / rect.width) * 100, 9, 91);
}

function spawnItem() {
  const pool = Math.random() < 0.18 ? [spriteTypes[5]] : spriteTypes.slice(0, 5);
  const item = pool[Math.floor(Math.random() * pool.length)];

  falling.value.push({
    id: objectId++,
    type: item.type,
    label: item.label,
    score: item.score,
    hazard: Boolean(item.hazard),
    x: 10 + Math.random() * 80,
    y: -12,
    size: 58 + Math.random() * 22,
    speed: 26 + Math.random() * 22 + score.value * 0.05,
    drift: -6 + Math.random() * 12,
    rotate: -9 + Math.random() * 18
  });
}

function finishGame() {
  if (!running.value) return;
  running.value = false;
  finished.value = true;
  window.clearInterval(timerId);
  cancelAnimationFrame(frameId);

  if (score.value > bestScore.value) {
    bestScore.value = score.value;
    window.localStorage.setItem("home2-game-best", String(score.value));
  }
}

function updateGame(now) {
  if (!running.value) return;

  const delta = Math.min((now - lastFrame) / 1000, 0.034);
  lastFrame = now;
  spawnClock += delta;

  if (spawnClock > Math.max(0.5, 1.02 - score.value / 470)) {
    spawnClock = 0;
    spawnItem();
  }

  const catcherY = 82;
  const catcherHalf = 13;

  falling.value = falling.value.filter((item) => {
    item.y += item.speed * delta;
    item.x = clamp(item.x + item.drift * delta, 5, 95);
    item.rotate += item.drift * delta * 0.45;

    const hitX = Math.abs(item.x - catcherX.value) < catcherHalf;
    const hitY = item.y > catcherY - 10 && item.y < catcherY + 8;

    if (hitX && hitY) {
      if (item.hazard) {
        lives.value -= 1;
        if (lives.value <= 0) finishGame();
      } else {
        score.value += item.score;
      }
      return false;
    }

    return item.y < 112;
  });

  frameId = requestAnimationFrame(updateGame);
}

function startGame() {
  score.value = 0;
  lives.value = 3;
  timeLeft.value = GAME_SECONDS;
  falling.value = [];
  finished.value = false;
  running.value = true;
  spawnClock = 0;
  lastFrame = performance.now();

  window.clearInterval(timerId);
  timerId = window.setInterval(() => {
    timeLeft.value -= 1;
    if (timeLeft.value <= 0) finishGame();
  }, 1000);

  cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(updateGame);
}

function onPointer(event) {
  moveCatcher(event.clientX);
}

function onKeydown(event) {
  if (event.key === "ArrowLeft") {
    catcherX.value = clamp(catcherX.value - 5, 9, 91);
  }
  if (event.key === "ArrowRight") {
    catcherX.value = clamp(catcherX.value + 5, 9, 91);
  }
  if ((event.key === " " || event.key === "Enter") && !running.value) {
    startGame();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.clearInterval(timerId);
  cancelAnimationFrame(frameId);
});
</script>

<template>
  <section class="game-stage" aria-label="手账贴贴乐 H5 小游戏">
    <div class="game-copy">
      <p class="game-kicker">H5 小游戏</p>
      <h1>手账贴贴乐</h1>
      <p>{{ statusText }}</p>
    </div>

    <div class="game-hud" aria-label="游戏状态">
      <span>得分 {{ score }}</span>
      <span>时间 {{ timeLeft }}</span>
      <span>生命 {{ lives }}</span>
      <span>最好 {{ bestScore }}</span>
    </div>

    <div
      ref="stageRef"
      class="game-board"
      tabindex="0"
      role="application"
      aria-label="移动接物小手账，接住贴纸素材"
      @pointerdown="onPointer"
      @pointermove="onPointer"
    >
      <img src="/images/journal-game-board.png" alt="" class="game-board-image" draggable="false" />

      <div
        v-for="item in falling"
        :key="item.id"
        class="falling-sticker"
        :class="'sprite-' + item.type"
        :aria-label="item.label"
        :style="{
          left: item.x + '%',
          top: item.y + '%',
          width: item.size + 'px',
          height: item.size + 'px',
          transform: 'translate(-50%, -50%) rotate(' + item.rotate + 'deg)'
        }"
      ></div>

      <img
        src="/images/journal-game-catcher.png"
        alt="接住贴纸的小手账"
        class="game-catcher"
        draggable="false"
        :style="{ left: catcherX + '%' }"
      />

      <div v-if="!running" class="game-panel">
        <p>{{ finished ? "这一局得分 " + score : "左右移动小手账，接住照片、叶子和胶带" }}</p>
        <button type="button" @click="startGame">{{ finished ? "再玩一次" : "开始游戏" }}</button>
        <button type="button" class="game-panel-link" @click="emit('close')">回到书本</button>
      </div>
    </div>
  </section>
</template>

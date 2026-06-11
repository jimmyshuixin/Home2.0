<script setup>
import { X } from 'lucide-vue-next';
import { siteConfig } from '../data/site';

defineProps({ open: { type: Boolean, required: true } });
defineEmits(['close']);
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="video-modal" aria-label="年度摄影记录">
        <button class="icon-button modal-close" type="button" aria-label="关闭视频" @click="$emit('close')">
          <X :size="22" />
        </button>
        <h2>年度摄影记录</h2>
        <p>把生活里闪光的片段，整理成一段可以回看的路。</p>
        <div class="video-frame">
          <iframe
            :src="siteConfig.bilibiliVideo"
            title="年度摄影记录"
            scrolling="no"
            frameborder="0"
            allow="autoplay; fullscreen; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
      </section>
    </div>
  </Transition>
</template>
